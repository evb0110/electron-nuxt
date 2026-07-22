use crate::{
    analysis::build_analysis_level,
    bw::despeckle_connected_calibrated,
    calibration::{CalibrationConfig, PageCalibration},
};
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    Component, ComponentMap, GrayImage, Rect,
};

#[derive(Clone, Copy, Debug)]
pub struct ContentResult {
    pub content: Option<Rect>,
    pub output_rect: Rect,
    pub margins: [f64; 4],
}

pub fn detect_content_and_margins(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    detect_content_and_margins_with_calibration_config(
        source,
        dpi,
        margins_mm,
        margins_pixels,
        CalibrationConfig::default(),
    )
}

#[doc(hidden)]
pub fn detect_content_and_margins_with_calibration_config(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration_config: CalibrationConfig,
) -> ContentResult {
    let level = build_analysis_level(source, dpi, 150.0);
    let calibration =
        PageCalibration::estimate(&level.image, level.effective_dpi, calibration_config);
    let content = detect_content_at_analysis_scale(&level.image, calibration).map(|content| {
        Rect::new(
            content.x / level.scale_x,
            content.y / level.scale_y,
            content.width / level.scale_x,
            content.height / level.scale_y,
        )
    });
    content_with_margins(source, dpi, content, margins_mm, margins_pixels)
}

pub(crate) fn detect_content_and_margins_calibrated(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration: PageCalibration,
) -> ContentResult {
    let content = detect_content_at_analysis_scale(source, calibration);
    content_with_margins(source, dpi, content, margins_mm, margins_pixels)
}

fn detect_content_at_analysis_scale(
    working: &GrayImage,
    calibration: PageCalibration,
) -> Option<Rect> {
    let binary = threshold_local(
        working,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    let horizontal_seed = open(&binary, 40, 2);
    let vertical_seed = open(&binary, 2, 40);
    let border_candidates = reconstruct_binary(&horizontal_seed, &binary)
        .or(&reconstruct_binary(&vertical_seed, &binary));
    let border_map = ComponentMap::from_binary(&border_candidates);
    let borders = border_map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        attached && (width * 2 >= working.width() || height * 2 >= working.height())
    });
    let cleaned = despeckle_connected_calibrated(
        &binary.subtract(&borders),
        calibration.content_despeckle_dpi(),
        calibration,
    );
    let map = ComponentMap::from_binary(&cleaned);
    let distance_to_white = squared_euclidean_distance(&cleaned.invert());
    let mut candidates = Vec::new();
    let (neighborhood_x, neighborhood_y) = calibration.content_neighborhood();
    let dirt_radius_squared = calibration.content_dirt_radius_squared();
    for component in map.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let solid_rule =
            (width > height * 25 && height <= 3) || (height > width * 25 && width <= 3);
        let border_attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let nearby_components = map
            .components()
            .iter()
            .filter(|other| {
                if other.label == component.label {
                    return false;
                }
                let other_x = (other.left + other.right) / 2;
                let other_y = (other.top + other.bottom) / 2;
                center_x.abs_diff(other_x) <= neighborhood_x
                    && center_y.abs_diff(other_y) <= neighborhood_y
            })
            .count();
        let mut maximum_inscribed_radius_squared = 0u32;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) == component.label {
                    maximum_inscribed_radius_squared = maximum_inscribed_radius_squared
                        .max(distance_to_white[y * working.width() + x]);
                }
            }
        }
        let isolated_thick_dirt = nearby_components == 0
            && maximum_inscribed_radius_squared > dirt_radius_squared
            && component.area < working.width().saturating_mul(working.height()) / 20;
        let border_shadow =
            border_attached && component.area > working.width().max(working.height()) / 3;
        let grayscale_supported =
            (solid_rule || isolated_thick_dirt) && grayscale_structure_evidence(working, component);
        if border_shadow || ((solid_rule || isolated_thick_dirt) && !grayscale_supported) {
            continue;
        }
        candidates.push(ContentCandidate {
            component,
            grayscale_supported,
        });
    }
    let retained = cluster_content_blocks(&map, &candidates, calibration);
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    for candidate in candidates {
        let component = candidate.component;
        if !retained[component.label as usize] {
            continue;
        }
        bounds = Some(match bounds {
            None => (
                component.left,
                component.top,
                component.right,
                component.bottom,
            ),
            Some((left, top, right, bottom)) => (
                left.min(component.left),
                top.min(component.top),
                right.max(component.right),
                bottom.max(component.bottom),
            ),
        });
    }
    bounds.map(|(left, top, right, bottom)| {
        Rect::new(
            left as f64,
            top as f64,
            (right - left + 1) as f64,
            (bottom - top + 1) as f64,
        )
    })
}

#[derive(Clone, Copy)]
struct ContentCandidate<'a> {
    component: &'a Component,
    grayscale_supported: bool,
}

#[derive(Clone, Debug, Default)]
struct BlockStats {
    component_count: usize,
    ink_area: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    initialized: bool,
    grayscale_supported: bool,
}

fn cluster_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    calibration: PageCalibration,
) -> Vec<bool> {
    let mut candidate_labels = vec![false; map.components().len() + 1];
    for candidate in candidates {
        candidate_labels[candidate.component.label as usize] = true;
    }
    let candidate_image = map.retain(|component| candidate_labels[component.label as usize]);
    let (dilation_x, dilation_y) = calibration.content_dilation();
    let block_map = ComponentMap::from_binary(&dilate(&candidate_image, dilation_x, dilation_y));
    let mut blocks = vec![BlockStats::default(); block_map.components().len() + 1];
    let mut component_blocks = vec![0usize; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let block_label = block_map.label_at(center_x, center_y) as usize;
        component_blocks[component.label as usize] = block_label;
        if block_label == 0 {
            continue;
        }
        let block = &mut blocks[block_label];
        if !block.initialized {
            block.left = component.left;
            block.top = component.top;
            block.right = component.right;
            block.bottom = component.bottom;
            block.initialized = true;
        } else {
            block.left = block.left.min(component.left);
            block.top = block.top.min(component.top);
            block.right = block.right.max(component.right);
            block.bottom = block.bottom.max(component.bottom);
        }
        block.component_count += 1;
        block.ink_area += component.area;
        block.grayscale_supported |= candidate.grayscale_supported;
    }
    let maximum_area = blocks.iter().map(|block| block.ink_area).max().unwrap_or(0);
    let maximum_count = blocks
        .iter()
        .map(|block| block.component_count)
        .max()
        .unwrap_or(0);
    let minimum_block_area = calibration.content_min_block_area();
    let dominant = blocks
        .iter()
        .map(|block| {
            block.initialized
                && (block.grayscale_supported
                    || block.ink_area >= (maximum_area / 12).max(minimum_block_area)
                    || block.component_count >= (maximum_count / 8).max(3))
        })
        .collect::<Vec<_>>();
    let mut retained = vec![false; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        let block_label = component_blocks[component.label as usize];
        if block_label == 0 {
            continue;
        }
        let block = &blocks[block_label];
        let supported_marginalia = block.ink_area >= 4
            && blocks.iter().enumerate().any(|(other_label, other)| {
                dominant.get(other_label).copied().unwrap_or(false)
                    && block_is_supported_outlier(block, other, calibration)
            });
        retained[component.label as usize] =
            dominant[block_label] || block.grayscale_supported || supported_marginalia;
    }
    retained
}

fn block_is_supported_outlier(
    block: &BlockStats,
    dominant: &BlockStats,
    calibration: PageCalibration,
) -> bool {
    let x_gap = axis_gap(block.left, block.right, dominant.left, dominant.right);
    let y_gap = axis_gap(block.top, block.bottom, dominant.top, dominant.bottom);
    let x_overlaps = x_gap == 0;
    let y_overlaps = y_gap == 0;
    let (vertical_gap, horizontal_gap) = calibration.content_block_gaps();
    (x_overlaps && y_gap <= vertical_gap) || (y_overlaps && x_gap <= horizontal_gap)
}

fn axis_gap(first_start: usize, first_end: usize, second_start: usize, second_end: usize) -> usize {
    if first_end < second_start {
        second_start - first_end - 1
    } else if second_end < first_start {
        first_start - second_end - 1
    } else {
        0
    }
}

fn grayscale_structure_evidence(image: &GrayImage, component: &Component) -> bool {
    let left = component.left.saturating_sub(2);
    let top = component.top.saturating_sub(2);
    let right = (component.right + 2).min(image.width() - 1);
    let bottom = (component.bottom + 2).min(image.height() - 1);
    let area = (right - left + 1).saturating_mul(bottom - top + 1);
    if area < 64 {
        return false;
    }
    let mut midtones = 0usize;
    let mut edges = 0usize;
    let mut samples = 0usize;
    for y in top..=bottom {
        for x in left..=right {
            let value = image.get(x, y);
            midtones += usize::from((40..=224).contains(&value));
            if x > left {
                edges += usize::from(value.abs_diff(image.get(x - 1, y)) >= 24);
            }
            if y > top {
                edges += usize::from(value.abs_diff(image.get(x, y - 1)) >= 24);
            }
            samples += 1;
        }
    }
    let midtone_fraction = midtones as f64 / samples.max(1) as f64;
    let edge_fraction = edges as f64 / samples.saturating_mul(2).max(1) as f64;
    (midtone_fraction >= 0.04 && edge_fraction >= 0.03) || edge_fraction >= 0.12
}

pub fn content_with_margins(
    source: &GrayImage,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    let margins = margins_pixels.unwrap_or_else(|| {
        margins_mm
            .unwrap_or([0.0; 4])
            .map(|millimeters| millimeters * dpi / 25.4)
    });
    let base = content.unwrap_or(Rect::new(
        0.0,
        0.0,
        source.width() as f64,
        source.height() as f64,
    ));
    let output_rect = base.expand(margins[0], margins[1], margins[2], margins[3]);
    ContentResult {
        content,
        output_rect,
        margins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }
    #[test]
    fn recovers_synthetic_content_box_and_ignores_border_shadow() {
        let mut image = GrayImage::new(240, 180, 238);
        for x in 0..240 {
            image.set(x, 3, 30);
            image.set(x, 4, 30);
        }
        for y in (40..140).step_by(14) {
            for word in 0..7 {
                let left = 42 + word * 23;
                for x in left..(left + 18).min(198) {
                    image.set(x, y, 20);
                    image.set(x, y + 1, 20);
                    image.set(x, y + 2, 20);
                }
            }
        }
        image.set(48, 33, 10);
        image.set(49, 33, 10);
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let expected = Rect::new(42.0, 33.0, 156.0, 96.0);
        assert!(
            iou(result.content.unwrap(), expected) > 0.82,
            "actual={:?}",
            result.content
        );
    }

    #[test]
    fn sedm_scoring_rejects_isolated_scan_bed_dirt_without_losing_marginalia() {
        let mut image = GrayImage::new(320, 220, 245);
        for y in (55..170).step_by(15) {
            for x in 72..245 {
                if x % 28 < 20 {
                    image.set(x, y, 20);
                    image.set(x, y + 1, 20);
                    image.set(x, y + 2, 20);
                }
            }
        }
        for y in 80..100 {
            for x in 18..21 {
                image.set(x, y, 25);
            }
        }
        for y in 190..205 {
            for x in 290..305 {
                image.set(x, y, 5);
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.x <= 21.0, "marginalia was lost: {bounds:?}");
        assert!(
            bounds.right() < 270.0,
            "isolated dirt expanded crop: {bounds:?}"
        );
    }

    #[test]
    fn grayscale_evidence_preserves_table_rules_and_photo_blocks() {
        let mut image = GrayImage::new(360, 260, 245);
        for y in (55..155).step_by(14) {
            for x in 72..245 {
                if x % 30 < 21 {
                    image.set(x, y, 18);
                    image.set(x, y + 1, 18);
                    image.set(x, y + 2, 18);
                }
            }
        }
        for x in 48..312 {
            image.set(x, 205, 35);
            image.set(x, 206, 35);
        }
        for y in 76..143 {
            for x in 282..337 {
                image.set(x, y, if (x / 4 + y / 4) % 2 == 0 { 58 } else { 178 });
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.right() >= 335.0, "photo block was lost: {bounds:?}");
        assert!(bounds.bottom() >= 206.0, "table rule was lost: {bounds:?}");
    }
}
