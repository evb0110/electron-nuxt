use crate::{
    analysis::build_analysis_level,
    bw::despeckle_connected_calibrated,
    calibration::{CalibrationConfig, PageCalibration},
    protocol::manifest_v3::{
        ContentAcceptedTrim, ContentBlockEvidence, ContentDiagnosticRect, ContentDiagnostics,
        ContentSideConfidence, ContentTextMaskSummary, ContentTrimSide,
    },
};
use scan_primitives::{
    distance::{find_peaks, squared_euclidean_distance, InfluenceMap},
    morphology::{dilate, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage, Rect,
};

#[derive(Clone, Debug)]
pub struct ContentResult {
    pub content: Option<Rect>,
    pub output_rect: Rect,
    pub margins: [f64; 4],
    pub diagnostics: Option<ContentDiagnostics>,
}

pub(crate) struct ContentAnalysisEvidence {
    pub diagnostics: ContentDiagnostics,
    pub text_mask: BinaryImage,
    pub text_vicinity_mask: BinaryImage,
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
    let (detected, diagnostics, _, _) =
        detect_content_at_analysis_scale(&level.image, None, calibration);
    let content = detected.map(|content| {
        Rect::new(
            content.x / level.scale_x,
            content.y / level.scale_y,
            content.width / level.scale_x,
            content.height / level.scale_y,
        )
    });
    let mut result = content_with_margins(source, dpi, content, margins_mm, margins_pixels);
    result.diagnostics = Some(diagnostics);
    result
}

pub(crate) fn detect_content_and_margins_calibrated(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration: PageCalibration,
) -> ContentResult {
    let (content, diagnostics, _, _) =
        detect_content_at_analysis_scale(source, picture_mask, calibration);
    let mut result = content_with_margins(source, dpi, content, margins_mm, margins_pixels);
    result.diagnostics = Some(diagnostics);
    result
}

pub(crate) fn analyze_content_evidence_calibrated(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    calibration: PageCalibration,
) -> ContentAnalysisEvidence {
    let (_, diagnostics, text_mask, text_vicinity_mask) =
        detect_content_at_analysis_scale(source, picture_mask, calibration);
    ContentAnalysisEvidence {
        diagnostics,
        text_mask,
        text_vicinity_mask,
    }
}

fn detect_content_at_analysis_scale(
    working: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    calibration: PageCalibration,
) -> (Option<Rect>, ContentDiagnostics, BinaryImage, BinaryImage) {
    if let Some(mask) = picture_mask {
        assert_eq!(
            (working.width(), working.height()),
            (mask.width(), mask.height())
        );
    }
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
    let borders = border_artifact_mask_from_binary(working, &binary);
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
    let centers = ComponentCenterGrid::build(map.components(), neighborhood_x, neighborhood_y);
    for (index, component) in map.components().iter().enumerate() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let solid_rule =
            (width > height * 25 && height <= 3) || (height > width * 25 && width <= 3);
        let border_attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        let nearby_components = centers.neighbor_count(map.components(), index);
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
        let picture_mask_overlap_pixels = component_mask_overlap(&map, component, picture_mask);
        let grayscale_supported =
            (solid_rule || isolated_thick_dirt) && grayscale_structure_evidence(working, component);
        let picture_supported = picture_mask_overlap_pixels != 0;
        if (border_shadow || ((solid_rule || isolated_thick_dirt) && !grayscale_supported))
            && !picture_supported
        {
            if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_CONTENT").is_some() {
                eprintln!(
                    "{{\"event\":\"content-candidate-dropped\",\"left\":{},\"top\":{},\"right\":{},\"bottom\":{},\"area\":{},\"borderShadow\":{border_shadow},\"solidRule\":{solid_rule},\"dirt\":{isolated_thick_dirt}}}",
                    component.left, component.top, component.right, component.bottom, component.area,
                );
            }
            continue;
        }
        candidates.push(ContentCandidate {
            component,
            grayscale_supported,
            picture_mask_overlap_pixels,
        });
    }
    let retained = cluster_content_blocks(&map, &candidates, picture_mask, calibration);
    let candidate_image = map.retain(|component| retained[component.label as usize]);
    let (mut blocks, component_blocks) =
        retained_content_blocks(&map, &candidates, &retained, picture_mask, calibration);
    annotate_heading_evidence(&map, &mut blocks, calibration);
    let text = build_text_line_mask(&candidate_image, &blocks, &distance_to_white, calibration);
    annotate_text_evidence(&map, &component_blocks, &mut blocks, &text.mask);
    let protected_mask =
        build_protected_mask(working.width(), working.height(), picture_mask, &blocks);
    let garbage = garbage_seed_labels(&borders, &cleaned, &protected_mask, calibration);
    let (mut bounds, side_confidence, accepted_trims) = trim_content_bounds(
        &candidate_image,
        &map,
        &blocks,
        &component_blocks,
        &text.mask,
        &protected_mask,
        garbage,
        calibration,
    );
    if let Some(picture_bounds) = picture_mask.and_then(binary_bounds) {
        bounds = Some(match bounds {
            Some(content_bounds) => PixelBounds {
                left: content_bounds.left.min(picture_bounds.left),
                top: content_bounds.top.min(picture_bounds.top),
                right: content_bounds.right.max(picture_bounds.right),
                bottom: content_bounds.bottom.max(picture_bounds.bottom),
            },
            None => picture_bounds,
        });
    }
    let protected_blocks = blocks
        .iter()
        .filter(|block| block.initialized && block.protected())
        .map(block_evidence)
        .collect();
    let diagnostics = ContentDiagnostics {
        side_confidence: ContentSideConfidence {
            left: side_confidence[0],
            top: side_confidence[1],
            right: side_confidence[2],
            bottom: side_confidence[3],
        },
        text_mask: text.summary,
        accepted_trims,
        protected_blocks,
    };
    (
        bounds.map(|bounds| {
            Rect::new(
                bounds.left as f64,
                bounds.top as f64,
                bounds.width() as f64,
                bounds.height() as f64,
            )
        }),
        diagnostics,
        text.mask,
        text.vicinity_mask,
    )
}

fn component_center(component: &Component) -> (usize, usize) {
    (
        (component.left + component.right) / 2,
        (component.top + component.bottom) / 2,
    )
}

/// Uniform grid over component centres, bucketed at exactly the neighbourhood
/// extent. The neighbour test is a box test of half-extent `(neighborhood_x,
/// neighborhood_y)`, so with that cell size every match lies in the 3x3 cell
/// block around the query cell: the counts are exact, not approximate, and the
/// scan stops being quadratic in the component count.
struct ComponentCenterGrid {
    neighborhood_x: usize,
    neighborhood_y: usize,
    columns: usize,
    rows: usize,
    cell_starts: Vec<u32>,
    entries: Vec<u32>,
}

impl ComponentCenterGrid {
    fn build(components: &[Component], neighborhood_x: usize, neighborhood_y: usize) -> Self {
        let cell_width = neighborhood_x.max(1);
        let cell_height = neighborhood_y.max(1);
        let mut columns = 1;
        let mut rows = 1;
        let mut placements = Vec::with_capacity(components.len());
        for component in components {
            let (center_x, center_y) = component_center(component);
            let column = center_x / cell_width;
            let row = center_y / cell_height;
            columns = columns.max(column + 1);
            rows = rows.max(row + 1);
            placements.push((column, row));
        }
        let mut cell_starts = vec![0u32; columns * rows + 1];
        for &(column, row) in &placements {
            cell_starts[row * columns + column + 1] += 1;
        }
        for cell in 1..cell_starts.len() {
            cell_starts[cell] += cell_starts[cell - 1];
        }
        let mut cursors = cell_starts.clone();
        let mut entries = vec![0u32; components.len()];
        for (index, &(column, row)) in placements.iter().enumerate() {
            let cell = row * columns + column;
            entries[cursors[cell] as usize] = index as u32;
            cursors[cell] += 1;
        }
        Self {
            neighborhood_x,
            neighborhood_y,
            columns,
            rows,
            cell_starts,
            entries,
        }
    }

    fn neighbor_count(&self, components: &[Component], index: usize) -> usize {
        let component = &components[index];
        let (center_x, center_y) = component_center(component);
        let column = center_x / self.neighborhood_x.max(1);
        let row = center_y / self.neighborhood_y.max(1);
        let mut nearby = 0;
        for cell_row in row.saturating_sub(1)..=(row + 1).min(self.rows - 1) {
            for cell_column in column.saturating_sub(1)..=(column + 1).min(self.columns - 1) {
                let cell = cell_row * self.columns + cell_column;
                let occupants = &self.entries
                    [self.cell_starts[cell] as usize..self.cell_starts[cell + 1] as usize];
                for &entry in occupants {
                    let other = &components[entry as usize];
                    if other.label == component.label {
                        continue;
                    }
                    let (other_x, other_y) = component_center(other);
                    if center_x.abs_diff(other_x) <= self.neighborhood_x
                        && center_y.abs_diff(other_y) <= self.neighborhood_y
                    {
                        nearby += 1;
                    }
                }
            }
        }
        nearby
    }
}

/// Reconstructs the long, edge-attached objects used by content detection as
/// scanner-border evidence. The opening seeds require sustained horizontal or
/// vertical structure before reconstruction, so ordinary edge-touching content
/// is not enough to qualify.
pub(crate) fn border_artifact_mask(working: &GrayImage) -> BinaryImage {
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
    border_artifact_mask_from_binary(working, &binary)
}

fn border_artifact_mask_from_binary(working: &GrayImage, binary: &BinaryImage) -> BinaryImage {
    let horizontal_seed = open(binary, 40, 2);
    let vertical_seed = open(binary, 2, 40);
    let border_candidates = reconstruct_binary(&horizontal_seed, binary)
        .or(&reconstruct_binary(&vertical_seed, binary));
    let retained = ComponentMap::from_binary(&border_candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        attached && (width * 2 >= working.width() || height * 2 >= working.height())
    });
    // A scanner border is a thin band hugging the page edge. Threshold bloom
    // on a normalized raster can bridge such a band to the nearest authored
    // structure (observed: a top bar swallowing the running head and its
    // rule through geodesic reconstruction), so the artifact mask is clipped
    // to the same 1/40 edge zone the mode selector uses for border shapes —
    // nothing deeper into the page may be removed as a border.
    let horizontal_zone = working.width().div_ceil(40).max(1);
    let vertical_zone = working.height().div_ceil(40).max(1);
    BinaryImage::from_fn_parallel(working.width(), working.height(), |x, y| {
        retained.get(x, y)
            && (x < horizontal_zone
                || x + horizontal_zone >= working.width()
                || y < vertical_zone
                || y + vertical_zone >= working.height())
    })
}

#[derive(Clone, Copy)]
struct ContentCandidate<'a> {
    component: &'a Component,
    grayscale_supported: bool,
    picture_mask_overlap_pixels: usize,
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
    picture_mask_overlap_pixels: usize,
    heading_evidence: bool,
    text_evidence: bool,
    labels: Vec<u32>,
}

impl BlockStats {
    fn protected(&self) -> bool {
        self.grayscale_supported
            || self.picture_mask_overlap_pixels != 0
            || self.heading_evidence
            || self.text_evidence
    }

    fn width(&self) -> usize {
        self.right - self.left + 1
    }

    fn height(&self) -> usize {
        self.bottom - self.top + 1
    }
}

fn cluster_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    picture_mask: Option<&BinaryImage>,
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
        block.picture_mask_overlap_pixels += candidate.picture_mask_overlap_pixels;
    }
    annotate_picture_overlap(&mut blocks, picture_mask);
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
                && (block.protected()
                    || block.ink_area >= (maximum_area / 12).max(minimum_block_area)
                    || block.component_count >= (maximum_count / 8).max(3))
        })
        .collect::<Vec<_>>();
    // Running heads, folio lines and chapter ornaments sit above the whole
    // text column, and on chapter openers the whitespace below them exceeds
    // any marginalia gap (16.8-38.8 mm measured against pages 208/339/360
    // of the calibration book) because the only block in between — the
    // chapter heading — is not yet protected at this stage. Positional
    // evidence identifies this furniture directly: a band above the primary
    // block, sharing its horizontal extent, at least half its width, and
    // reaching below the outer 1/20 scanner-junk frame is page content no
    // matter how far the body starts.
    let primary_block = dominant
        .iter()
        .enumerate()
        .filter(|&(_, &is_dominant)| is_dominant)
        .map(|(label, _)| &blocks[label])
        .filter(|block| block.initialized)
        .max_by_key(|block| block.ink_area);
    let frame_band_bottom = block_map.height() / 20;
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
        let top_furniture = primary_block.is_some_and(|primary| {
            block.bottom < primary.top
                && block.bottom >= frame_band_bottom
                && axis_gap(block.left, block.right, primary.left, primary.right) == 0
                && block.width().saturating_mul(2) >= primary.width()
        });
        retained[component.label as usize] =
            dominant[block_label] || block.protected() || supported_marginalia || top_furniture;
        if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_CONTENT").is_some()
            && !retained[component.label as usize]
        {
            eprintln!(
                "{{\"event\":\"content-component-unretained\",\"left\":{},\"top\":{},\"right\":{},\"bottom\":{},\"blockInk\":{},\"blockCount\":{},\"dominant\":{},\"marginalia\":{supported_marginalia}}}",
                component.left, component.top, component.right, component.bottom,
                block.ink_area, block.component_count, dominant[block_label],
            );
        }
    }
    retained
}

fn retained_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    retained: &[bool],
    picture_mask: Option<&BinaryImage>,
    calibration: PageCalibration,
) -> (Vec<BlockStats>, Vec<usize>) {
    let retained_image = map.retain(|component| retained[component.label as usize]);
    let (dilation_x, dilation_y) = calibration.content_dilation();
    let block_map = ComponentMap::from_binary(&dilate(&retained_image, dilation_x, dilation_y));
    let mut blocks = vec![BlockStats::default(); block_map.components().len() + 1];
    let mut component_blocks = vec![0usize; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        if !retained[component.label as usize] {
            continue;
        }
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
        block.picture_mask_overlap_pixels += candidate.picture_mask_overlap_pixels;
        block.labels.push(component.label);
    }
    annotate_picture_overlap(&mut blocks, picture_mask);
    (blocks, component_blocks)
}

fn annotate_picture_overlap(blocks: &mut [BlockStats], picture_mask: Option<&BinaryImage>) {
    let Some(mask) = picture_mask else {
        return;
    };
    for block in blocks.iter_mut().filter(|block| block.initialized) {
        block.picture_mask_overlap_pixels = (block.top..=block.bottom)
            .flat_map(|y| (block.left..=block.right).map(move |x| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
    }
}

fn component_mask_overlap(
    map: &ComponentMap,
    component: &Component,
    mask: Option<&BinaryImage>,
) -> usize {
    let Some(mask) = mask else {
        return 0;
    };
    let mut overlap = 0usize;
    for y in component.top..=component.bottom {
        for x in component.left..=component.right {
            overlap += usize::from(map.label_at(x, y) == component.label && mask.get(x, y));
        }
    }
    overlap
}

fn annotate_heading_evidence(
    map: &ComponentMap,
    blocks: &mut [BlockStats],
    calibration: PageCalibration,
) {
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_CONTENT").is_some() {
        eprintln!(
            "{{\"event\":\"heading-nominal\",\"nominal\":{nominal_height:.2},\"valid\":{}}}",
            calibration.valid,
        );
    }
    let maximum_gap = (12.0 * nominal_height).round().max(12.0) as usize;
    let alignment_tolerance = (2.0 * nominal_height).round().max(4.0) as usize;
    let heading_flags = blocks
        .iter()
        .map(|candidate| {
            if !candidate.initialized
                || candidate.component_count < 3
                || candidate.component_count > 64
                || candidate.height() as f64 > 5.0 * nominal_height
            {
                return false;
            }
            let mut component_heights = Vec::new();
            let mut glyph_like = 0usize;
            for component in map
                .components()
                .iter()
                .filter(|component| candidate.labels.contains(&component.label))
            {
                let width = component.right - component.left + 1;
                let height = component.bottom - component.top + 1;
                let height_f64 = height as f64;
                component_heights.push(height);
                if height_f64 >= 0.7 * nominal_height
                    && height_f64 <= 4.0 * nominal_height
                    && width as f64 <= 4.0 * height_f64
                    && component.area >= 3
                {
                    glyph_like += 1;
                }
            }
            if component_heights.is_empty() || glyph_like * 2 < component_heights.len() {
                return false;
            }
            component_heights.sort_unstable();
            let median_height = component_heights[component_heights.len() / 2] as f64;
            // Running heads are often set at the body text's x-height. Requiring
            // a heading to be visibly larger misclassified the narrow header on
            // dictionary pages as scanner-edge garbage, so a text-like line at
            // the same calibrated height remains ownership evidence too.
            if median_height < 0.9 * nominal_height || median_height > 4.0 * nominal_height {
                return false;
            }
            let candidate_center = (candidate.left + candidate.right) / 2;
            let body_envelope = blocks
                .iter()
                .filter(|body| {
                    body.initialized
                        && body.top > candidate.bottom
                        && body.component_count >= 8
                        && (body.height() as f64) >= 2.0 * nominal_height
                        && body.top - candidate.bottom - 1 <= maximum_gap
                })
                .fold(None, |envelope: Option<(usize, usize)>, body| {
                    Some(match envelope {
                        None => (body.left, body.right),
                        Some((left, right)) => (left.min(body.left), right.max(body.right)),
                    })
                });
            body_envelope.is_some_and(|(body_left, body_right)| {
                let overlap = candidate
                    .right
                    .min(body_right)
                    .saturating_sub(candidate.left.max(body_left));
                let aligned_center = candidate_center.saturating_add(alignment_tolerance)
                    >= body_left
                    && candidate_center <= body_right.saturating_add(alignment_tolerance);
                aligned_center || overlap.saturating_mul(4) >= candidate.width()
            })
        })
        .collect::<Vec<_>>();
    for (block, heading_evidence) in blocks.iter_mut().zip(heading_flags) {
        block.heading_evidence = heading_evidence;
    }
}

fn build_protected_mask(
    width: usize,
    height: usize,
    picture_mask: Option<&BinaryImage>,
    blocks: &[BlockStats],
) -> BinaryImage {
    let mut protected = picture_mask
        .cloned()
        .unwrap_or_else(|| BinaryImage::new(width, height));
    for block in blocks
        .iter()
        .filter(|block| block.initialized && block.protected())
    {
        for y in block.top..=block.bottom {
            for x in block.left..=block.right {
                protected.set(x, y, true);
            }
        }
    }
    protected
}

fn annotate_text_evidence(
    map: &ComponentMap,
    component_blocks: &[usize],
    blocks: &mut [BlockStats],
    text_mask: &BinaryImage,
) {
    for y in 0..text_mask.height() {
        for x in 0..text_mask.width() {
            if !text_mask.get(x, y) {
                continue;
            }
            let component_label = map.label_at(x, y) as usize;
            let block_label = component_blocks
                .get(component_label)
                .copied()
                .unwrap_or_default();
            if block_label != 0 {
                blocks[block_label].text_evidence = true;
            }
        }
    }
}

fn block_evidence(block: &BlockStats) -> ContentBlockEvidence {
    ContentBlockEvidence {
        bounds: ContentDiagnosticRect {
            x_px: block.left,
            y_px: block.top,
            width_px: block.width(),
            height_px: block.height(),
        },
        picture_mask_overlap_pixels: block.picture_mask_overlap_pixels,
        heading_evidence: block.heading_evidence,
        grayscale_evidence: block.grayscale_supported,
        text_evidence: block.text_evidence,
    }
}

struct TextLineMask {
    mask: BinaryImage,
    vicinity_mask: BinaryImage,
    summary: ContentTextMaskSummary,
}

fn build_text_line_mask(
    content: &BinaryImage,
    blocks: &[BlockStats],
    distance_to_white: &[u32],
    calibration: PageCalibration,
) -> TextLineMask {
    let peaks = find_peaks(distance_to_white, content.width(), content.height());
    let mut mask = BinaryImage::new(content.width(), content.height());
    let mut vicinity_mask = BinaryImage::new(content.width(), content.height());
    let mut line_count = 0usize;
    for block in blocks.iter().filter(|block| block.initialized) {
        let mut histogram = vec![0usize; block.bottom - block.top + 1];
        for y in block.top..=block.bottom {
            histogram[y - block.top] = (block.left..=block.right)
                .filter(|&x| content.get(x, y))
                .count();
        }
        let mut bands = Vec::new();
        split_histogram_bands(
            &histogram,
            0,
            histogram.len(),
            calibration.content_minimum_band_rows(),
            &mut bands,
        );
        for (start, end) in bands {
            let Some(first_row) = (start..end).find(|&row| histogram[row] != 0) else {
                continue;
            };
            let last_row = (start..end)
                .rev()
                .find(|&row| histogram[row] != 0)
                .expect("a nonempty band has a last row");
            let top = block.top + first_row;
            let bottom = block.top + last_row;
            let mut left = block.right;
            let mut right = block.left;
            let mut ink = 0usize;
            for y in top..=bottom {
                for x in block.left..=block.right {
                    if content.get(x, y) {
                        left = left.min(x);
                        right = right.max(x);
                        ink += 1;
                    }
                }
            }
            if ink == 0 || right < left {
                continue;
            }
            let width = right - left + 1;
            let height = bottom - top + 1;
            let fill_ratio = ink as f64 / width.saturating_mul(height).max(1) as f64;
            if !(0.22..=0.65).contains(&fill_ratio) {
                continue;
            }
            let required_peaks = ((0.4 * width as f64 / height.max(1) as f64) as usize).max(2);
            let peak_count = peaks
                .iter()
                .filter(|&&(x, y)| {
                    (left..=right).contains(&x) && (top..=bottom).contains(&y) && content.get(x, y)
                })
                .count();
            if peak_count < required_peaks {
                continue;
            }
            line_count += 1;
            for y in top..=bottom {
                for x in left..=right {
                    // This rectangle is measurement evidence only. Including
                    // inter-glyph and inter-word paper prevents the tonal-page
                    // refusal from mistaking the interior of a recognized text
                    // line for unrelated continuous-tone content.
                    vicinity_mask.set(x, y, true);
                    if content.get(x, y) {
                        mask.set(x, y, true);
                    }
                }
            }
        }
    }
    let bounds = binary_bounds(&mask).map(|bounds| ContentDiagnosticRect {
        x_px: bounds.left,
        y_px: bounds.top,
        width_px: bounds.width(),
        height_px: bounds.height(),
    });
    TextLineMask {
        summary: ContentTextMaskSummary {
            analysis_width_px: content.width(),
            analysis_height_px: content.height(),
            ink_pixels: mask.count_black(),
            line_count,
            bounds,
        },
        mask,
        vicinity_mask,
    }
}

fn split_histogram_bands(
    histogram: &[usize],
    start: usize,
    end: usize,
    minimum_rows: usize,
    output: &mut Vec<(usize, usize)>,
) {
    if end.saturating_sub(start) < minimum_rows.saturating_mul(2) {
        output.push((start, end));
        return;
    }
    let mut best: Option<(usize, f64)> = None;
    for valley in start + minimum_rows..=end - minimum_rows {
        let left_peak = histogram[start..valley].iter().copied().max().unwrap_or(0);
        let right_peak = histogram[valley..end].iter().copied().max().unwrap_or(0);
        let smaller = left_peak.min(right_peak);
        let larger = left_peak.max(right_peak);
        if smaller.saturating_mul(20) < larger || larger == 0 {
            continue;
        }
        let valley_height = histogram[valley];
        if valley_height as f64 * 3.5 > 0.5 * (left_peak + right_peak) as f64 {
            continue;
        }
        let depth = 1.0 - valley_height as f64 / ((left_peak + right_peak) as f64 * 0.5);
        if best.is_none_or(|(_, best_depth)| depth > best_depth) {
            best = Some((valley, depth));
        }
    }
    if let Some((valley, _)) = best {
        split_histogram_bands(histogram, start, valley, minimum_rows, output);
        split_histogram_bands(histogram, valley, end, minimum_rows, output);
    } else {
        output.push((start, end));
    }
}

const HORIZONTAL_GARBAGE: u32 = 1;
const VERTICAL_GARBAGE: u32 = 2;
const REMOVED_GARBAGE: u32 = 3;

fn garbage_seed_labels(
    borders: &BinaryImage,
    cleaned: &BinaryImage,
    protected: &BinaryImage,
    calibration: PageCalibration,
) -> Vec<u32> {
    let width = cleaned.width();
    let height = cleaned.height();
    let (long_size, thin_size) = calibration.content_long_opening_size();
    let long_radius = long_size.saturating_sub(1) / 2;
    let thin_radius = thin_size.saturating_sub(1) / 2;
    let horizontal = border_zone_long_lines(&open(cleaned, long_radius, thin_radius), true);
    let vertical = border_zone_long_lines(&open(cleaned, thin_radius, long_radius), false);
    let border_map = ComponentMap::from_binary(borders);
    let mut border_labels = vec![0u32; border_map.components().len() + 1];
    for component in border_map.components() {
        let component_width = component.right - component.left + 1;
        let component_height = component.bottom - component.top + 1;
        border_labels[component.label as usize] = if component_width >= component_height {
            HORIZONTAL_GARBAGE
        } else {
            VERTICAL_GARBAGE
        };
    }
    let mut labels = vec![0; width.saturating_mul(height)];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if protected.get(x, y) {
                continue;
            }
            let border_label = border_map.label_at(x, y) as usize;
            if border_label != 0 {
                labels[index] = border_labels[border_label];
            }
            if horizontal.get(x, y) {
                labels[index] = HORIZONTAL_GARBAGE;
            }
            if vertical.get(x, y) {
                labels[index] = VERTICAL_GARBAGE;
            }
        }
    }
    labels
}

fn border_zone_long_lines(source: &BinaryImage, horizontal: bool) -> BinaryImage {
    let map = ComponentMap::from_binary(source);
    let horizontal_zone = source.height().div_ceil(10).max(1);
    let vertical_zone = source.width().div_ceil(10).max(1);
    map.retain(|component| {
        if horizontal {
            component.top < horizontal_zone
                || component.bottom.saturating_add(horizontal_zone) >= source.height()
        } else {
            component.left < vertical_zone
                || component.right.saturating_add(vertical_zone) >= source.width()
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PixelBounds {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
}

impl PixelBounds {
    fn width(self) -> usize {
        self.right - self.left + 1
    }

    fn height(self) -> usize {
        self.bottom - self.top + 1
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrimSide {
    Left,
    Top,
    Right,
    Bottom,
}

impl TrimSide {
    const ALL: [Self; 4] = [Self::Left, Self::Top, Self::Right, Self::Bottom];

    fn index(self) -> usize {
        match self {
            Self::Left => 0,
            Self::Top => 1,
            Self::Right => 2,
            Self::Bottom => 3,
        }
    }

    fn strip_thickness(self, current: PixelBounds, next: PixelBounds) -> usize {
        match self {
            Self::Left => next.left.saturating_sub(current.left),
            Self::Top => next.top.saturating_sub(current.top),
            Self::Right => current.right.saturating_sub(next.right),
            Self::Bottom => current.bottom.saturating_sub(next.bottom),
        }
    }

    fn diagnostic(self) -> ContentTrimSide {
        match self {
            Self::Left => ContentTrimSide::Left,
            Self::Top => ContentTrimSide::Top,
            Self::Right => ContentTrimSide::Right,
            Self::Bottom => ContentTrimSide::Bottom,
        }
    }
}

struct TrimProposal {
    side: TrimSide,
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
    score: f64,
    threshold: f64,
    content_distance_sum: f64,
    garbage_distance_sum: f64,
}

struct TrimGeometry {
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
}

fn trim_is_frame_admissible(
    side: TrimSide,
    removed_blocks: &[bool],
    blocks: &[BlockStats],
    component_map: &ComponentMap,
    page_width: usize,
    page_height: usize,
) -> bool {
    let horizontal_zone = page_width.div_ceil(20).max(1);
    let vertical_zone = page_height.div_ceil(20).max(1);
    let right_zone_start = page_width.saturating_sub(horizontal_zone);
    let bottom_zone_start = page_height.saturating_sub(vertical_zone);

    blocks.iter().enumerate().all(|(block_label, block)| {
        if !removed_blocks.get(block_label).copied().unwrap_or(false) {
            return true;
        }
        let in_border_zone = match side {
            TrimSide::Left => block.right < horizontal_zone,
            TrimSide::Top => block.bottom < vertical_zone,
            TrimSide::Right => block.left >= right_zone_start,
            TrimSide::Bottom => block.top >= bottom_zone_start,
        };
        let edge_attached = block.labels.iter().any(|&component_label| {
            let Some(component) = component_label
                .checked_sub(1)
                .and_then(|label| component_map.components().get(label as usize))
            else {
                return false;
            };
            match side {
                TrimSide::Left => component.left == 0,
                TrimSide::Top => component.top == 0,
                TrimSide::Right => component.right.saturating_add(1) == page_width,
                TrimSide::Bottom => component.bottom.saturating_add(1) == page_height,
            }
        });
        in_border_zone || edge_attached
    })
}

#[allow(clippy::too_many_arguments)]
fn trim_content_bounds(
    content: &BinaryImage,
    component_map: &ComponentMap,
    blocks: &[BlockStats],
    component_blocks: &[usize],
    text_mask: &BinaryImage,
    protected_mask: &BinaryImage,
    mut garbage_labels: Vec<u32>,
    calibration: PageCalibration,
) -> (Option<PixelBounds>, [f64; 4], Vec<ContentAcceptedTrim>) {
    let mut active = blocks
        .iter()
        .map(|block| block.initialized)
        .collect::<Vec<_>>();
    if let Some(first) = active.first_mut() {
        *first = false;
    }
    let Some(mut bounds) = bounds_for_active_blocks(blocks, &active) else {
        return (None, [0.0; 4], Vec::new());
    };
    let mut confidence = [0.0f64; 4];
    let mut accepted_trims = Vec::new();
    let mut iteration = 1usize;
    loop {
        if active.iter().filter(|&&is_active| is_active).count() <= 1 {
            break;
        }
        if !TrimSide::ALL
            .iter()
            .any(|&side| build_trim_geometry(side, bounds, blocks, &active, calibration).is_some())
        {
            break;
        }
        let Some(garbage_influence) =
            garbage_influence(content.width(), content.height(), &garbage_labels)
        else {
            break;
        };
        let mut best: Option<TrimProposal> = None;
        for side in TrimSide::ALL {
            let Some(proposal) = build_trim_proposal(
                side,
                bounds,
                content,
                component_map,
                blocks,
                component_blocks,
                &active,
                text_mask,
                &garbage_influence,
                calibration,
            ) else {
                continue;
            };
            confidence[side.index()] = confidence[side.index()].max(proposal.score);
            if proposal.score <= proposal.threshold {
                continue;
            }
            if !trim_is_frame_admissible(
                side,
                &proposal.removed_blocks,
                blocks,
                component_map,
                content.width(),
                content.height(),
            ) {
                continue;
            }
            let margin = proposal.score - proposal.threshold;
            if best
                .as_ref()
                .is_none_or(|current| margin > current.score - current.threshold)
            {
                best = Some(proposal);
            }
        }
        let Some(proposal) = best else {
            break;
        };
        for (block_active, remove) in active.iter_mut().zip(&proposal.removed_blocks) {
            if *remove {
                *block_active = false;
            }
        }
        mark_removed_strip(
            &mut garbage_labels,
            content.width(),
            bounds,
            proposal.next_bounds,
            proposal.side,
            protected_mask,
        );
        accepted_trims.push(ContentAcceptedTrim {
            side: proposal.side.diagnostic(),
            iteration,
            score: proposal.score,
            threshold: proposal.threshold,
            content_distance_sum: proposal.content_distance_sum,
            garbage_distance_sum: proposal.garbage_distance_sum,
            removed_blocks: blocks
                .iter()
                .enumerate()
                .filter(|(label, _)| proposal.removed_blocks[*label])
                .map(|(_, block)| block_evidence(block))
                .collect(),
        });
        iteration += 1;
        bounds = bounds_for_active_blocks(blocks, &active)
            .expect("an accepted trim proposal retains at least one content block");
    }
    (Some(bounds), confidence, accepted_trims)
}

#[allow(clippy::too_many_arguments)]
fn build_trim_proposal(
    side: TrimSide,
    current: PixelBounds,
    content: &BinaryImage,
    component_map: &ComponentMap,
    blocks: &[BlockStats],
    component_blocks: &[usize],
    active: &[bool],
    text_mask: &BinaryImage,
    garbage_influence: &InfluenceMap,
    calibration: PageCalibration,
) -> Option<TrimProposal> {
    let geometry = build_trim_geometry(side, current, blocks, active, calibration)?;
    let removed_blocks = geometry.removed_blocks;
    let next = geometry.next_bounds;

    let mut content_seeds = BinaryImage::new(content.width(), content.height());
    let mut removed_pixels = Vec::new();
    let mut text_area = 0usize;
    for y in current.top..=current.bottom {
        for x in current.left..=current.right {
            let component = component_map.label_at(x, y) as usize;
            let block = component_blocks.get(component).copied().unwrap_or(0);
            if content.get(x, y) && block != 0 && active[block] {
                if removed_blocks[block] {
                    removed_pixels.push((x, y));
                    text_area += usize::from(text_mask.get(x, y));
                } else {
                    content_seeds.set(x, y, true);
                }
            }
        }
    }
    if removed_pixels.is_empty() || content_seeds.count_black() == 0 {
        return None;
    }
    let content_influence = squared_euclidean_distance(&content_seeds);
    let mut content_distance_sum = 0.0;
    let mut garbage_distance_sum = 0.0;
    for (x, y) in removed_pixels {
        content_distance_sum += f64::from(content_influence[y * content.width() + x]).sqrt();
        garbage_distance_sum += f64::from(garbage_influence.squared_distance_at(x, y)).sqrt();
    }
    let score = content_distance_sum / (content_distance_sum + garbage_distance_sum).max(1.0);
    let threshold = trimming_bias(side, text_area, calibration.content_text_bias_area_cap());
    Some(TrimProposal {
        side,
        removed_blocks,
        next_bounds: next,
        score,
        threshold,
        content_distance_sum,
        garbage_distance_sum,
    })
}

fn build_trim_geometry(
    side: TrimSide,
    current: PixelBounds,
    blocks: &[BlockStats],
    active: &[bool],
    calibration: PageCalibration,
) -> Option<TrimGeometry> {
    let mut removed_blocks = vec![false; blocks.len()];
    for (label, block) in blocks.iter().enumerate() {
        if !active[label] {
            continue;
        }
        let touches = match side {
            TrimSide::Left => block.left == current.left,
            TrimSide::Top => block.top == current.top,
            TrimSide::Right => block.right == current.right,
            TrimSide::Bottom => block.bottom == current.bottom,
        };
        removed_blocks[label] = touches;
    }
    if !removed_blocks.iter().any(|&remove| remove)
        || blocks
            .iter()
            .enumerate()
            .any(|(label, block)| removed_blocks[label] && block.protected())
    {
        return None;
    }
    let remaining_active = active
        .iter()
        .zip(&removed_blocks)
        .map(|(&is_active, &remove)| is_active && !remove)
        .collect::<Vec<_>>();
    let remaining_bounds = bounds_for_active_blocks(blocks, &remaining_active)?;
    let mut next = current;
    match side {
        TrimSide::Left => next.left = remaining_bounds.left,
        TrimSide::Top => next.top = remaining_bounds.top,
        TrimSide::Right => next.right = remaining_bounds.right,
        TrimSide::Bottom => next.bottom = remaining_bounds.bottom,
    }
    let thickness = side.strip_thickness(current, next);
    if thickness == 0 {
        return None;
    }
    let removed_area = blocks
        .iter()
        .enumerate()
        .filter(|(label, _)| removed_blocks[*label])
        .map(|(_, block)| block.ink_area)
        .sum::<usize>();
    let remaining_area = blocks
        .iter()
        .enumerate()
        .filter(|(label, _)| remaining_active[*label])
        .map(|(_, block)| block.ink_area)
        .sum::<usize>();
    let minimum_strip = calibration.content_minimum_band_rows();
    if thickness >= minimum_strip && removed_area as f64 > 0.3 * remaining_area as f64 {
        return None;
    }
    let (minimum_width, minimum_height, narrow_width) = calibration.content_trim_geometry();
    if next.width() < minimum_width
        || next.height() < minimum_height
        || (next.width() < narrow_width && next.height() > next.width().saturating_mul(20))
    {
        return None;
    }

    Some(TrimGeometry {
        removed_blocks,
        next_bounds: next,
    })
}

fn garbage_influence(width: usize, height: usize, labels: &[u32]) -> Option<InfluenceMap> {
    labels
        .iter()
        .any(|&label| label != 0)
        .then(|| InfluenceMap::from_seed_labels(width, height, labels))
}

fn trimming_bias(side: TrimSide, text_area: usize, text_area_cap: usize) -> f64 {
    let (without_text, with_text) = match side {
        TrimSide::Top | TrimSide::Bottom => (0.4, 0.5),
        TrimSide::Left | TrimSide::Right => (0.5, 0.65),
    };
    let capped = text_area.min(text_area_cap) as f64;
    let increase = (capped + 1.0).ln() / (text_area_cap.max(1) as f64 + 1.0).ln();
    without_text + (with_text - without_text) * increase
}

fn mark_removed_strip(
    labels: &mut [u32],
    width: usize,
    previous: PixelBounds,
    next: PixelBounds,
    side: TrimSide,
    protected: &BinaryImage,
) {
    let (left, top, right, bottom) = match side {
        TrimSide::Left => (previous.left, previous.top, next.left - 1, previous.bottom),
        TrimSide::Top => (previous.left, previous.top, previous.right, next.top - 1),
        TrimSide::Right => (
            next.right + 1,
            previous.top,
            previous.right,
            previous.bottom,
        ),
        TrimSide::Bottom => (
            previous.left,
            next.bottom + 1,
            previous.right,
            previous.bottom,
        ),
    };
    match side {
        TrimSide::Left => {
            for y in top..=bottom {
                for x in left..=right {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Top => {
            for x in left..=right {
                for y in top..=bottom {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Right => {
            for y in top..=bottom {
                for x in (left..=right).rev() {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Bottom => {
            for x in left..=right {
                for y in (top..=bottom).rev() {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
    }
}

fn bounds_for_active_blocks(blocks: &[BlockStats], active: &[bool]) -> Option<PixelBounds> {
    blocks
        .iter()
        .zip(active)
        .filter(|(block, is_active)| **is_active && block.initialized)
        .fold(None, |bounds: Option<PixelBounds>, (block, _)| {
            Some(match bounds {
                None => PixelBounds {
                    left: block.left,
                    top: block.top,
                    right: block.right,
                    bottom: block.bottom,
                },
                Some(bounds) => PixelBounds {
                    left: bounds.left.min(block.left),
                    top: bounds.top.min(block.top),
                    right: bounds.right.max(block.right),
                    bottom: bounds.bottom.max(block.bottom),
                },
            })
        })
}

fn binary_bounds(image: &BinaryImage) -> Option<PixelBounds> {
    let mut bounds: Option<PixelBounds> = None;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !image.get(x, y) {
                continue;
            }
            bounds = Some(match bounds {
                None => PixelBounds {
                    left: x,
                    top: y,
                    right: x,
                    bottom: y,
                },
                Some(bounds) => PixelBounds {
                    left: bounds.left.min(x),
                    top: bounds.top.min(y),
                    right: bounds.right.max(x),
                    bottom: bounds.bottom.max(y),
                },
            });
        }
    }
    bounds
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
    content_with_margins_for_dimensions(
        source.width(),
        source.height(),
        dpi,
        content,
        margins_mm,
        margins_pixels,
    )
}

pub(crate) fn content_with_margins_for_dimensions(
    width: usize,
    height: usize,
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
    let base = content.unwrap_or(Rect::new(0.0, 0.0, width as f64, height as f64));
    let expanded = base.expand(margins[0], margins[1], margins[2], margins[3]);
    // Cropping is a selection, not a geometric transform. Fractional
    // millimetre margins previously made an otherwise unrotated raster pass
    // through subpixel interpolation (5 mm at 100 DPI starts at .685 px),
    // changing every antialiased glyph before it was placed back on the
    // matched canvas. Round outward so the requested margin is never reduced
    // and integer-aligned scans retain their exact sample grid.
    // A margin may extend past the physical page edge. Keep the crop rect in
    // page coordinates: downstream PDF assembly clips negative-origin rasters
    // before placing them on the matched canvas, which can remove authored ink
    // at the top or left edge even though the requested margin was meant to
    // preserve it.
    let page_width = width as f64;
    let page_height = height as f64;
    let left = expanded.x.floor().clamp(0.0, page_width);
    let top = expanded.y.floor().clamp(0.0, page_height);
    let right = expanded.right().ceil().clamp(left, page_width);
    let bottom = expanded.bottom().ceil().clamp(top, page_height);
    let output_rect = Rect::new(left, top, right - left, bottom - top);
    ContentResult {
        content,
        output_rect,
        margins,
        diagnostics: None,
    }
}

#[cfg(test)]
mod tests {
    /// Developer diagnostic: run content detection on an external page image.
    /// `EVB_CONTENT_IMAGE=/path.png EVB_SCAN_CLEANUP_TRACE_CONTENT=1
    /// cargo test -p evb-scan-cleanup dump_external_content_box -- --ignored --nocapture`
    #[test]
    #[ignore = "requires EVB_CONTENT_IMAGE"]
    fn dump_external_content_box() {
        let path = std::env::var("EVB_CONTENT_IMAGE").unwrap();
        let image =
            crate::io::raster::read_image(std::path::Path::new(&path), 40_000_000, 10_000).unwrap();
        let dpi = std::env::var("EVB_CONTENT_DPI")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(360.0);
        let result = detect_content_and_margins(&image.gray, dpi, Some([5.0; 4]), None);
        eprintln!("content result: {:?}", result.content);
    }

    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    const CENSUS_NEIGHBORHOOD: (usize, usize) = (40, 24);

    #[test]
    fn physical_margins_expand_outward_to_an_integer_raster_crop() {
        let image = GrayImage::new(850, 1_100, 255);
        let result = content_with_margins(
            &image,
            100.0,
            Some(Rect::new(56.0, 46.0, 745.0, 947.0)),
            Some([5.0; 4]),
            None,
        );

        assert_eq!(result.output_rect, Rect::new(36.0, 26.0, 785.0, 987.0));
        assert_eq!(result.margins, [5.0 / 25.4 * 100.0; 4]);
    }

    #[test]
    fn physical_margins_clamp_at_page_edges_without_negative_crop_origin() {
        let image = GrayImage::new(2_199, 3_279, 255);
        let result = content_with_margins(
            &image,
            400.0,
            Some(Rect::new(50.64, 34.66, 2_097.71, 3_145.71)),
            Some([5.0; 4]),
            None,
        );

        assert_eq!(result.output_rect, Rect::new(0.0, 0.0, 2_199.0, 3_260.0));
        assert!(result.output_rect.x >= 0.0);
        assert!(result.output_rect.y >= 0.0);
        assert!(result.output_rect.right() <= image.width() as f64);
        assert!(result.output_rect.bottom() <= image.height() as f64);
    }

    fn component_census(columns: usize, rows: usize) -> Vec<Component> {
        let mut components = Vec::with_capacity(columns * rows);
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut jitter = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((state >> 33) % bound) as usize
        };
        for row in 0..rows {
            for column in 0..columns {
                let left = column * 9 + jitter(5);
                let top = row * 7 + jitter(4);
                components.push(Component {
                    label: components.len() as u32 + 1,
                    area: 4,
                    left,
                    top,
                    right: left + 1,
                    bottom: top + 1,
                });
            }
        }
        components
    }

    fn all_pairs_neighbor_count(components: &[Component], index: usize) -> usize {
        let component = &components[index];
        let (center_x, center_y) = component_center(component);
        components
            .iter()
            .filter(|other| {
                if other.label == component.label {
                    return false;
                }
                let (other_x, other_y) = component_center(other);
                center_x.abs_diff(other_x) <= CENSUS_NEIGHBORHOOD.0
                    && center_y.abs_diff(other_y) <= CENSUS_NEIGHBORHOOD.1
            })
            .count()
    }

    #[test]
    fn grid_neighbor_counts_match_the_all_pairs_scan() {
        let components = component_census(102, 102);
        assert!(components.len() > 10_000);
        let grid =
            ComponentCenterGrid::build(&components, CENSUS_NEIGHBORHOOD.0, CENSUS_NEIGHBORHOOD.1);
        for index in 0..components.len() {
            assert_eq!(
                grid.neighbor_count(&components, index),
                all_pairs_neighbor_count(&components, index),
                "component {index} at {:?}",
                component_center(&components[index])
            );
        }
    }

    #[test]
    fn grid_neighbor_counts_survive_degenerate_geometries() {
        let empty: Vec<Component> = Vec::new();
        ComponentCenterGrid::build(&empty, 40, 24);

        let stacked = vec![
            Component {
                label: 1,
                area: 1,
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            Component {
                label: 2,
                area: 1,
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            Component {
                label: 3,
                area: 1,
                left: 4_000,
                top: 3_000,
                right: 4_000,
                bottom: 3_000,
            },
        ];
        for (neighborhood_x, neighborhood_y) in [(0usize, 0usize), (1, 1), (40, 24)] {
            let grid = ComponentCenterGrid::build(&stacked, neighborhood_x, neighborhood_y);
            assert_eq!(grid.neighbor_count(&stacked, 0), 1);
            assert_eq!(grid.neighbor_count(&stacked, 1), 1);
            assert_eq!(grid.neighbor_count(&stacked, 2), 0);
        }
    }

    #[test]
    fn a_dense_component_census_does_not_pay_an_all_pairs_neighbor_scan() {
        const DEADLINE: Duration = Duration::from_secs(60);
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let components = component_census(500, 400);
            let started = Instant::now();
            let grid = ComponentCenterGrid::build(
                &components,
                CENSUS_NEIGHBORHOOD.0,
                CENSUS_NEIGHBORHOOD.1,
            );
            let mut nearby = 0usize;
            for index in 0..components.len() {
                nearby += grid.neighbor_count(&components, index);
            }
            let _ = sender.send((components.len(), nearby, started.elapsed()));
        });
        let (count, nearby, elapsed) = receiver.recv_timeout(DEADLINE).unwrap_or_else(|_| {
            panic!(
                "counting neighbours for 200 000 components did not finish within {DEADLINE:?}: \
                 the query is scanning every component for every component \
                 (4 x 10^10 centre comparisons) instead of a 3x3 block of centre-bucketed cells"
            )
        });
        assert!(nearby > count * 10, "the census produced no neighbours");
        assert!(
            elapsed < DEADLINE,
            "{count} components took {elapsed:?} to count neighbours"
        );
    }

    fn draw_glyph_line(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        glyph_width: usize,
        glyph_height: usize,
        gap: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * (glyph_width + gap);
            for y in top..top + glyph_height {
                for x in glyph_left..glyph_left + glyph_width {
                    if x == glyph_left
                        || x + 1 == glyph_left + glyph_width
                        || y == top
                        || y + 1 == top + glyph_height
                    {
                        image.set(x, y, 24);
                    }
                }
            }
        }
    }

    fn direct_trim_fixture(
        artifact_top: usize,
        artifact_bottom: usize,
    ) -> (Option<PixelBounds>, Vec<ContentAcceptedTrim>) {
        let width = 200;
        let height = 200;
        let mut content = BinaryImage::new(width, height);
        for y in artifact_top..=artifact_bottom {
            for x in 20..31 {
                content.set(x, y, true);
            }
        }
        for y in 80..161 {
            for x in 60..141 {
                content.set(x, y, true);
            }
        }
        let component_map = ComponentMap::from_binary(&content);
        let artifact_label = component_map.label_at(20, artifact_top) as usize;
        let body_label = component_map.label_at(60, 80) as usize;
        let artifact = &component_map.components()[artifact_label - 1];
        let body = &component_map.components()[body_label - 1];
        let mut blocks = vec![BlockStats::default(); component_map.components().len() + 1];
        blocks[artifact_label] = BlockStats {
            component_count: 1,
            ink_area: artifact.area,
            left: artifact.left,
            top: artifact.top,
            right: artifact.right,
            bottom: artifact.bottom,
            initialized: true,
            labels: vec![artifact.label],
            ..BlockStats::default()
        };
        blocks[body_label] = BlockStats {
            component_count: 1,
            ink_area: body.area,
            left: body.left,
            top: body.top,
            right: body.right,
            bottom: body.bottom,
            initialized: true,
            labels: vec![body.label],
            ..BlockStats::default()
        };
        let mut component_blocks = vec![0usize; component_map.components().len() + 1];
        component_blocks[artifact_label] = artifact_label;
        component_blocks[body_label] = body_label;
        let mut garbage_labels = vec![0u32; width * height];
        for y in artifact_top..=artifact_bottom {
            for x in 20..31 {
                garbage_labels[y * width + x] = HORIZONTAL_GARBAGE;
            }
        }
        let text_mask = BinaryImage::new(width, height);
        let protected_mask = BinaryImage::new(width, height);
        let calibration =
            PageCalibration::estimate_from_binary(&content, 150.0, CalibrationConfig::default());
        let (bounds, _, accepted_trims) = trim_content_bounds(
            &content,
            &component_map,
            &blocks,
            &component_blocks,
            &text_mask,
            &protected_mask,
            garbage_labels,
            calibration,
        );
        (bounds, accepted_trims)
    }

    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }

    #[test]
    fn recursively_splits_balanced_histogram_valleys() {
        let histogram = [8, 9, 8, 9, 8, 9, 0, 0, 0, 10, 9, 10, 9, 10, 9];
        let mut bands = Vec::new();
        split_histogram_bands(&histogram, 0, histogram.len(), 6, &mut bands);
        assert_eq!(bands, vec![(0, 6), (6, 15)]);

        let unbalanced = [1, 1, 1, 1, 1, 1, 0, 0, 0, 30, 30, 30, 30, 30, 30];
        bands.clear();
        split_histogram_bands(&unbalanced, 0, unbalanced.len(), 6, &mut bands);
        assert_eq!(bands, vec![(0, unbalanced.len())]);
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
    fn competing_fields_trim_a_remote_long_stain_strip() {
        let mut image = GrayImage::new(420, 320, 245);
        for y in (70..245).step_by(16) {
            for x in 92..300 {
                if x % 31 < 20 {
                    for stroke_y in y..y + 4 {
                        image.set(x, stroke_y, 20);
                    }
                }
            }
        }
        for y in 55..275 {
            for x in 404..412 {
                image.set(x, y, 18);
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.right() < 350.0, "remote stain survived: {bounds:?}");
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

    #[test]
    fn display_heading_is_hard_protected_above_body_text() {
        let mut image = GrayImage::new(520, 560, 245);
        for x in 30..490 {
            image.set(x, 24, 18);
            image.set(x, 25, 18);
        }
        draw_glyph_line(&mut image, 196, 116, 8, 11, 24, 6);
        for row in 0..14 {
            let top = 210 + row * 19;
            draw_glyph_line(&mut image, 62, top, 13, 6, 10, 4);
            draw_glyph_line(&mut image, 292, top, 13, 6, 10, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.y <= 116.0, "display heading was trimmed: {bounds:?}");
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.heading_evidence && block.bounds.y_px <= 116),
            "heading evidence was not recorded: {diagnostics:?}"
        );
    }

    #[test]
    fn running_head_is_protected_by_the_page_frame_policy() {
        let mut image = GrayImage::new(700, 1000, 200);
        for y in 40..52 {
            for x in 60..75 {
                image.set(x, y, 20);
            }
            for x in 560..640 {
                image.set(x, y, 20);
            }
        }
        for y in 58..61 {
            for x in 60..641 {
                image.set(x, y, 20);
            }
        }
        for y in (120..900).step_by(18) {
            for line_y in y..y + 2 {
                for x in 60..641 {
                    image.set(x, line_y, 20);
                }
            }
        }

        let result = detect_content_and_margins(&image, 120.0, None, Some([0.0; 4]));
        let bounds = result.content.expect("running head and body are content");
        assert!(bounds.y <= 45.0, "running head was trimmed: {bounds:?}");
        let diagnostics = result.diagnostics.expect("content diagnostics");
        assert!(
            diagnostics
                .accepted_trims
                .iter()
                .flat_map(|trim| trim.removed_blocks.iter())
                .all(|block| block.bounds.y_px > 60),
            "the in-frame running head entered an accepted trim: {diagnostics:?}"
        );
    }

    #[test]
    fn edge_attached_band_remains_trimmable_beyond_the_border_zone() {
        let (bounds, accepted_trims) = direct_trim_fixture(0, 30);
        let bounds = bounds.expect("edge-attached artifact and body are content");

        assert!(accepted_trims
            .iter()
            .any(|trim| { trim.side == ContentTrimSide::Top && trim.iteration == 1 }));
        assert!(bounds.top >= 80, "edge-attached band survived: {bounds:?}");
    }

    #[test]
    fn in_frame_floating_artifact_is_not_trimmable_even_with_high_garbage_score() {
        // Every artifact pixel is a garbage seed, so the score would be maximal
        // without the page-frame admissibility filter.
        let (bounds, accepted_trims) = direct_trim_fixture(25, 55);
        let bounds = bounds.expect("floating artifact and body are content");

        assert!(accepted_trims.is_empty());
        assert_eq!(bounds.top, 25, "floating artifact was trimmed: {bounds:?}");
    }

    #[test]
    fn recognized_text_blocks_cannot_be_consumed_by_a_cascading_edge_trim() {
        let mut image = GrayImage::new(620, 760, 245);
        // A scanner-edge rule and running header are legitimate trim
        // candidates. The body above the next chapter is not: once recognized
        // as text it must remain protected even if the first trim makes it the
        // block nearest the same edge.
        for x in 28..592 {
            image.set(x, 24, 18);
            image.set(x, 25, 18);
        }
        draw_glyph_line(&mut image, 52, 46, 18, 5, 8, 3);
        for row in 0..6 {
            let top = 104 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }
        draw_glyph_line(&mut image, 226, 322, 8, 11, 24, 6);
        for row in 0..16 {
            let top = 388 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(
            bounds.y <= 104.0,
            "recognized body text was lost in an edge-trim cascade: {bounds:?}"
        );
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.text_evidence && block.bounds.y_px <= 104),
            "text protection was not recorded: {diagnostics:?}"
        );
    }

    #[test]
    fn text_evidence_belongs_to_component_ink_not_an_overlapping_block_box() {
        let mut components = BinaryImage::new(10, 10);
        components.set(1, 1, true);
        components.set(4, 4, true);
        components.set(8, 8, true);
        let map = ComponentMap::from_binary(&components);

        let mut blocks = vec![BlockStats::default(); 3];
        blocks[1] = BlockStats {
            left: 1,
            top: 1,
            right: 8,
            bottom: 8,
            initialized: true,
            labels: vec![1, 3],
            ..BlockStats::default()
        };
        blocks[2] = BlockStats {
            left: 4,
            top: 4,
            right: 4,
            bottom: 4,
            initialized: true,
            labels: vec![2],
            ..BlockStats::default()
        };
        let component_blocks = vec![0, 1, 2, 1];
        let mut text_mask = BinaryImage::new(10, 10);
        text_mask.set(4, 4, true);

        annotate_text_evidence(&map, &component_blocks, &mut blocks, &text_mask);

        assert!(
            !blocks[1].text_evidence,
            "a block must not inherit text protection merely because its bounding box contains text"
        );
        assert!(blocks[2].text_evidence);
    }

    #[test]
    fn accepted_artifact_trim_cannot_cascade_through_picture_or_heading() {
        let mut image = GrayImage::new(620, 760, 245);
        for y in 8..18 {
            for x in 32..588 {
                image.set(x, y, 16);
            }
        }
        for y in 44..62 {
            for x in 286..304 {
                image.set(x, y, 20);
            }
        }
        for panel in 0..4 {
            let left = 150 + panel * 74;
            for y in 132..280 {
                for x in left..left + 52 {
                    image.set(x, y, 45 + ((x * 17 + y * 11 + panel * 23) % 165) as u8);
                }
            }
        }
        draw_glyph_line(&mut image, 226, 342, 8, 11, 24, 6);
        for row in 0..16 {
            let top = 408 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        for y in 126..286 {
            for x in 144..430 {
                picture_mask.set(x, y, true);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());
        let result = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let bounds = result.content.unwrap();
        assert!(
            bounds.y <= 132.0 && bounds.bottom() >= 695.0,
            "protected content was lost after artifact trimming: {bounds:?}"
        );
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .accepted_trims
                .iter()
                .any(|trim| trim.side == ContentTrimSide::Top && trim.iteration == 1),
            "top artifact was not removed first: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| { block.picture_mask_overlap_pixels > 0 && block.bounds.y_px <= 132 }),
            "picture evidence was not retained: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.heading_evidence),
            "heading evidence was not retained: {diagnostics:?}"
        );
    }

    #[test]
    fn vetted_picture_geometry_contributes_its_full_extent_to_content_bounds() {
        let mut image = GrayImage::new(320, 420, 245);
        draw_glyph_line(&mut image, 96, 170, 8, 8, 14, 5);
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        for y in 48..382 {
            for x in 34..286 {
                picture_mask.set(x, y, true);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());

        let result = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let bounds = result.content.expect("picture geometry is content");

        assert!(bounds.x <= 34.0);
        assert!(bounds.y <= 48.0);
        assert!(bounds.right() >= 286.0);
        assert!(bounds.bottom() >= 382.0);
    }
}
