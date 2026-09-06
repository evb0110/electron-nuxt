//! Typed handoff for fold-edge fragment filtering.

use super::*;

pub(crate) struct Input<'a> {
    pub binary: &'a BinaryImage,
    pub picture_mask: Option<&'a BinaryImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub half: PageHalf,
    pub split: &'a SplitResult,
    pub region: Rect,
    pub render_plan: &'a ComposedRenderPlan,
    pub source_content_box: Option<Rect>,
    pub blank_leaf: bool,
    pub dpi: f64,
}

pub(crate) fn run(input: Input<'_>) -> (BinaryImage, BinaryImage) {
    let Input {
        binary,
        picture_mask,
        text_mask,
        text_vicinity_mask,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        blank_leaf,
        dpi,
    } = input;
    if split.classification != LayoutClassification::TwoPageSpread
        || half == PageHalf::Full
        || binary.width() == 0
        || binary.height() == 0
    {
        return (
            binary.clone(),
            BinaryImage::new(binary.width(), binary.height()),
        );
    }
    debug_assert!(picture_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));
    debug_assert!(text_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));

    let fold_source_x = match half {
        PageHalf::Left => region.right(),
        PageHalf::Right => region.x,
        PageHalf::Full => {
            return (
                binary.clone(),
                BinaryImage::new(binary.width(), binary.height()),
            )
        }
    };
    let mut fold_samples = (0..=8)
        .filter_map(|index| {
            let fraction = index as f64 / 8.0;
            render_plan
                .source_to_output(Point::new(
                    fold_source_x,
                    region.y + region.height * fraction,
                ))
                .map(|point| (point.y, point.x))
        })
        .collect::<Vec<_>>();
    if fold_samples.is_empty() {
        return (
            binary.clone(),
            BinaryImage::new(binary.width(), binary.height()),
        );
    }
    fold_samples.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
    let fold_edge_x_at = |output_y: f64| {
        if fold_samples.len() == 1 {
            return fold_samples[0].1;
        }
        let segment = fold_samples.windows(2).find(|window| {
            output_y >= window[0].0.min(window[1].0) && output_y <= window[0].0.max(window[1].0)
        });
        let Some(segment) = segment else {
            return if output_y < fold_samples[0].0 {
                fold_samples[0].1
            } else {
                fold_samples.last().map_or(0.0, |sample| sample.1)
            };
        };
        let delta_y = segment[1].0 - segment[0].0;
        if delta_y.abs() <= f64::EPSILON {
            return segment[0].1.min(segment[1].1);
        }
        let fraction = ((output_y - segment[0].0) / delta_y).clamp(0.0, 1.0);
        segment[0].1 + (segment[1].1 - segment[0].1) * fraction
    };
    let rendered_content_rect = source_content_box.and_then(|content| {
        let points = [
            Point::new(content.x, content.y),
            Point::new(content.right(), content.y),
            Point::new(content.x, content.bottom()),
            Point::new(content.right(), content.bottom()),
        ]
        .into_iter()
        .filter_map(|point| {
            render_plan.source_to_output(Point::new(point.x + region.x, point.y + region.y))
        })
        .collect::<Vec<_>>();
        (points.len() == 4).then(|| {
            let left = points
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min);
            let top = points
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min);
            let right = points
                .iter()
                .map(|point| point.x)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = points
                .iter()
                .map(|point| point.y)
                .fold(f64::NEG_INFINITY, f64::max);
            Rect::new(left, top, right - left, bottom - top)
        })
    });

    let margin = (binary.width() as f64 * FOLD_EDGE_FRAGMENT_MARGIN_FRACTION)
        .ceil()
        .max(1.0);
    let contact = (dpi.max(1.0) * FOLD_EDGE_FRAGMENT_CONTACT_MM / 25.4)
        .round()
        .max(1.0);
    let dpi_scale = dpi.max(1.0) / 25.4;
    let maximum_major = (dpi_scale * FOLD_EDGE_FRAGMENT_MAX_MAJOR_MM)
        .round()
        .max(4.0) as usize;
    let maximum_minor = (dpi_scale * FOLD_EDGE_FRAGMENT_MAX_MINOR_MM)
        .round()
        .max(2.0) as usize;
    let maximum_area = (dpi_scale.powi(2) * FOLD_EDGE_FRAGMENT_MAX_AREA_MM2)
        .round()
        .max(8.0) as usize;
    let minimum_rule_major = (dpi_scale * FOLD_EDGE_RULE_MIN_MAJOR_MM).round().max(4.0) as usize;
    let blank_maximum_major = (dpi_scale * FOLD_EDGE_BLANK_SPECK_MAX_MAJOR_MM)
        .round()
        .max(3.0) as usize;
    let blank_maximum_minor = (dpi_scale * FOLD_EDGE_BLANK_SPECK_MAX_MINOR_MM)
        .round()
        .max(2.0) as usize;
    let blank_maximum_area = (dpi_scale.powi(2) * FOLD_EDGE_BLANK_SPECK_MAX_AREA_MM2)
        .round()
        .max(4.0) as usize;
    let components = ComponentMap::from_binary(binary);
    let text_components = text_mask.map(ComponentMap::from_binary);
    let text_vicinity_components = text_vicinity_mask.map(ComponentMap::from_binary);
    let overlaps_mask = |component: &scan_primitives::Component, mask: &BinaryImage| {
        (component.top..=component.bottom).any(|y| {
            (component.left..=component.right)
                .any(|x| components.label_at(x, y) == component.label && mask.get(x, y))
        })
    };
    let component_inside = |component: &scan_primitives::Component, rect: Rect| {
        component.left as f64 >= rect.x
            && component.top as f64 >= rect.y
            && component.right as f64 + 1.0 <= rect.right()
            && component.bottom as f64 + 1.0 <= rect.bottom()
    };
    let ownership_reaches_leaf_interior =
        |component: &scan_primitives::Component, ownership: &ComponentMap| {
            for y in component.top..=component.bottom {
                for x in component.left..=component.right {
                    if components.label_at(x, y) != component.label {
                        continue;
                    }
                    let label = ownership.label_at(x, y);
                    if label == 0 {
                        continue;
                    }
                    let owner = &ownership.components()[label as usize - 1];
                    let rows = [owner.top, (owner.top + owner.bottom) / 2, owner.bottom];
                    let reaches_interior = rows.into_iter().any(|row| {
                        let edge = fold_edge_x_at(row as f64);
                        match half {
                            PageHalf::Left => (owner.left as f64) < edge - margin,
                            PageHalf::Right => owner.right as f64 + 1.0 > edge + margin,
                            PageHalf::Full => false,
                        }
                    });
                    if reaches_interior {
                        return true;
                    }
                }
            }
            false
        };
    let touches_horizontal_page_edge = |component: &scan_primitives::Component| {
        component.top == 0 || component.bottom + 1 == binary.height()
    };
    let touches_outer_leaf_edge = |component: &scan_primitives::Component| match half {
        PageHalf::Left => component.left == 0,
        PageHalf::Right => component.right + 1 == binary.width(),
        PageHalf::Full => true,
    };
    let touches_non_fold_edge = |component: &scan_primitives::Component| {
        touches_horizontal_page_edge(component) || touches_outer_leaf_edge(component)
    };
    let fold_geometry = |component: &scan_primitives::Component| {
        let sample_rows = [
            component.top,
            (component.top + component.bottom) / 2,
            component.bottom,
        ];
        let mut near_boundary = false;
        let mut inward_depth = 0.0_f64;
        for row in sample_rows {
            let edge = fold_edge_x_at(row as f64);
            let facing_distance = match half {
                PageHalf::Left => edge - component.right as f64,
                PageHalf::Right => component.left as f64 - edge,
                PageHalf::Full => f64::INFINITY,
            };
            near_boundary |= facing_distance.abs() <= contact
                || match half {
                    PageHalf::Left => component.right as f64 >= edge - contact,
                    PageHalf::Right => component.left as f64 <= edge + contact,
                    PageHalf::Full => false,
                };
            inward_depth = inward_depth.max(match half {
                PageHalf::Left => (edge - component.left as f64).max(0.0),
                PageHalf::Right => (component.right as f64 - edge).max(0.0),
                PageHalf::Full => f64::INFINITY,
            });
        }
        (near_boundary, inward_depth)
    };
    let component_has_text_ownership = |component: &scan_primitives::Component| {
        text_components
            .as_ref()
            .is_some_and(|mask| ownership_reaches_leaf_interior(component, mask))
            || text_vicinity_components
                .as_ref()
                .is_some_and(|mask| ownership_reaches_leaf_interior(component, mask))
    };
    let component_has_content_ownership = |component: &scan_primitives::Component| {
        rendered_content_rect.is_some_and(|rect| {
            if !component_inside(component, rect) {
                return false;
            }
            let edge = fold_edge_x_at(((component.top + component.bottom) / 2) as f64);
            match half {
                PageHalf::Left => component.right as f64 + 1.0 < edge - margin,
                PageHalf::Right => component.left as f64 > edge + margin,
                PageHalf::Full => true,
            }
        })
    };

    // Gutter geometry handles continuous shadow. A scanner rail can instead
    // be one ragged vertical component, or several aligned components, whose
    // bright gaps intentionally stop the column-only band walk. Remove that
    // rail locally rather than weakening the band's no-ink guarantee. This
    // path needs independent gutter evidence, fold contact, substantial
    // physical span, and no picture, text, or content ownership. A solid
    // marginal rule remains pinned.
    #[derive(Clone, Copy)]
    struct RailCandidate {
        label: u32,
        distance: f64,
        top: usize,
        bottom: usize,
        height: usize,
        fill: f64,
    }
    let measured_gutter_band = split
        .cutter_x
        .is_some_and(|cutter| split.diagnostics.fold_band.has_suppression(cutter));
    let rail_max_width = (dpi_scale * FOLD_EDGE_RAIL_MAX_WIDTH_MM).round().max(2.0) as usize;
    let rail_alignment = (dpi_scale * FOLD_EDGE_RAIL_ALIGNMENT_MM).round().max(1.0);
    let rail_min_single_height = (dpi_scale * FOLD_EDGE_RAIL_MIN_SINGLE_HEIGHT_MM)
        .round()
        .max(8.0) as usize;
    let rail_min_chain_span = (dpi_scale * FOLD_EDGE_RAIL_MIN_CHAIN_SPAN_MM)
        .round()
        .max(16.0) as usize;
    let rail_min_chain_coverage = (dpi_scale * FOLD_EDGE_RAIL_MIN_CHAIN_COVERAGE_MM)
        .round()
        .max(8.0) as usize;
    let mut rail_labels = vec![false; components.components().len() + 1];
    if measured_gutter_band {
        let rail_candidates = components
            .components()
            .iter()
            .filter_map(|component| {
                let width = component.right - component.left + 1;
                let height = component.bottom - component.top + 1;
                let (near_boundary, inward_depth) = fold_geometry(component);
                // The visible end of a binding rail can enter from the top or
                // bottom corner of an otherwise blank leaf. Admit that one
                // geometry to the measured-rail classifier; an outer-edge
                // contact, or the same contact on a nonblank leaf, remains an
                // unconditional preservation boundary.
                if touches_outer_leaf_edge(component)
                    || (touches_horizontal_page_edge(component) && !blank_leaf)
                    || !near_boundary
                    || inward_depth > margin
                    || width > rail_max_width
                    || height < width.saturating_mul(2)
                    || picture_mask.is_some_and(|mask| overlaps_mask(component, mask))
                    || component_has_text_ownership(component)
                    || component_has_content_ownership(component)
                {
                    return None;
                }
                let edge = fold_edge_x_at(((component.top + component.bottom) / 2) as f64);
                let center = (component.left + component.right) as f64 * 0.5;
                Some(RailCandidate {
                    label: component.label,
                    distance: (center - edge).abs(),
                    top: component.top,
                    bottom: component.bottom,
                    height,
                    fill: component.area as f64 / width.saturating_mul(height).max(1) as f64,
                })
            })
            .collect::<Vec<_>>();
        let mut assigned = vec![false; rail_candidates.len()];
        for anchor in 0..rail_candidates.len() {
            if assigned[anchor] {
                continue;
            }
            let mut group = Vec::new();
            for candidate in anchor..rail_candidates.len() {
                if !assigned[candidate]
                    && (rail_candidates[candidate].distance - rail_candidates[anchor].distance)
                        .abs()
                        <= rail_alignment
                {
                    assigned[candidate] = true;
                    group.push(rail_candidates[candidate]);
                }
            }
            let mut intervals = group
                .iter()
                .map(|candidate| (candidate.top, candidate.bottom))
                .collect::<Vec<_>>();
            intervals.sort_unstable();
            let mut coverage = 0usize;
            let mut covered: Option<(usize, usize)> = None;
            for (top, bottom) in intervals {
                match covered {
                    Some((covered_top, covered_bottom))
                        if top <= covered_bottom.saturating_add(1) =>
                    {
                        covered = Some((covered_top, covered_bottom.max(bottom)));
                    }
                    Some((covered_top, covered_bottom)) => {
                        coverage += covered_bottom - covered_top + 1;
                        covered = Some((top, bottom));
                    }
                    None => covered = Some((top, bottom)),
                }
            }
            if let Some((covered_top, covered_bottom)) = covered {
                coverage += covered_bottom - covered_top + 1;
            }
            let top = group
                .iter()
                .map(|candidate| candidate.top)
                .min()
                .unwrap_or(0);
            let bottom = group
                .iter()
                .map(|candidate| candidate.bottom)
                .max()
                .unwrap_or(0);
            let span = bottom.saturating_sub(top) + 1;
            let ragged_single = group.len() == 1
                && group[0].height >= rail_min_single_height
                && group[0].fill <= FOLD_EDGE_RAIL_MAX_SINGLE_FILL;
            let broken_chain = group.len() >= 2
                && span >= rail_min_chain_span
                && coverage >= rail_min_chain_coverage;
            if ragged_single || broken_chain {
                for candidate in group {
                    rail_labels[candidate.label as usize] = true;
                }
            }
        }
    }
    let kept = components.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let major = width.max(height);
        let minor = width.min(height);
        // A clipped vertical glyph stem is often much longer than it is wide.
        // It is still a glyph-scale fragment; reserve the rule veto for a
        // high-aspect component at least 3 mm long. Long or chained scanner
        // rails remain outside the fragment envelope altogether.
        let line_like = major >= minimum_rule_major && major >= minor.saturating_mul(4);
        let small_fragment = component.area <= maximum_area
            && major <= maximum_major
            && minor <= maximum_minor
            && !line_like;
        let blank_speck = blank_leaf
            && component.area <= blank_maximum_area
            && major <= blank_maximum_major
            && minor <= blank_maximum_minor
            && !line_like;
        // Do not treat the physical outer/top/bottom edges as fold edges. This
        // is intentionally checked on the rendered raster as well as against
        // the mapped fold line: a crop margin can move the fold away from the
        // payload boundary without changing which payload edge is outer.
        // A corner rail is removable only after the stricter measured-gutter,
        // blank-leaf, ownership, size, alignment, and raggedness gates above
        // claimed it. Every other top/bottom/outer-edge component stays pinned.
        if rail_labels[component.label as usize] {
            return false;
        }
        if touches_non_fold_edge(component) {
            return true;
        }
        let (near_boundary, inward_depth) = fold_geometry(component);
        let within_fold_margin = inward_depth <= margin;
        if !within_fold_margin {
            return true;
        }
        let picture_ownership = picture_mask.is_some_and(|mask| overlaps_mask(component, mask));
        // Text masks are detected on the whole spread, so a facing-page line
        // that crosses the cutter can mark its clipped end as "text" on the
        // wrong leaf. It becomes leaf ownership only when the same connected
        // text or text-vicinity component continues beyond the narrow fold
        // corridor. This is the tight-rebind pin: genuine near-binding text
        // connects inward, while a foreign line end terminates at the fold.
        let text_ownership = component_has_text_ownership(component);
        // Content crops can themselves be pulled to the fold by the foreign
        // fragment being rejected. Only the part beyond the independently
        // bounded fold corridor is content interior for this filter.
        let content_ownership = component_has_content_ownership(component);
        if (picture_ownership && !blank_speck) || text_ownership || content_ownership {
            return true;
        }
        if !small_fragment && !blank_speck {
            return true;
        }
        if near_boundary && small_fragment {
            return false;
        }
        if blank_speck {
            // Blank leaves get one extra cosmetic pass, but only for isolated
            // sub-glyph-scale marks already confined to the fold corridor.
            return false;
        }
        true
    });
    let removed = binary.subtract(&kept);
    (kept, removed)
}

#[cfg(test)]
#[path = "fold_edge_filtering_tests.rs"]
mod tests;
