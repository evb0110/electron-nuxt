use crate::{
    analysis::build_analysis_level,
    bw::despeckle_connected_calibrated,
    calibration::{CalibrationConfig, PageCalibration},
    protocol::manifest_v2::{
        ContentDiagnosticRect, ContentDiagnostics, ContentSideConfidence, ContentTextMaskSummary,
    },
};
use scan_primitives::{
    distance::{find_peaks, squared_euclidean_distance, InfluenceMap},
    morphology::{dilate, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage, Rect,
};

#[derive(Clone, Copy, Debug)]
pub struct ContentResult {
    pub content: Option<Rect>,
    pub output_rect: Rect,
    pub margins: [f64; 4],
    pub diagnostics: Option<ContentDiagnostics>,
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
    let (detected, diagnostics) = detect_content_at_analysis_scale(&level.image, calibration);
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
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration: PageCalibration,
) -> ContentResult {
    let (content, diagnostics) = detect_content_at_analysis_scale(source, calibration);
    let mut result = content_with_margins(source, dpi, content, margins_mm, margins_pixels);
    result.diagnostics = Some(diagnostics);
    result
}

fn detect_content_at_analysis_scale(
    working: &GrayImage,
    calibration: PageCalibration,
) -> (Option<Rect>, ContentDiagnostics) {
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
    let candidate_image = map.retain(|component| retained[component.label as usize]);
    let (blocks, component_blocks) =
        retained_content_blocks(&map, &candidates, &retained, calibration);
    let text = build_text_line_mask(&candidate_image, &blocks, &distance_to_white, calibration);
    let garbage = garbage_seed_labels(&borders, &cleaned, calibration);
    let (bounds, side_confidence) = trim_content_bounds(
        &candidate_image,
        &map,
        &blocks,
        &component_blocks,
        &text.mask,
        garbage,
        calibration,
    );
    let diagnostics = ContentDiagnostics {
        side_confidence: ContentSideConfidence {
            left: side_confidence[0],
            top: side_confidence[1],
            right: side_confidence[2],
            bottom: side_confidence[3],
        },
        text_mask: text.summary,
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
    )
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
    labels: Vec<u32>,
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

fn retained_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    retained: &[bool],
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
        block.labels.push(component.label);
    }
    (blocks, component_blocks)
}

struct TextLineMask {
    mask: BinaryImage,
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
    calibration: PageCalibration,
) -> Vec<u32> {
    let width = cleaned.width();
    let height = cleaned.height();
    let (long_size, thin_size) = calibration.content_long_opening_size();
    let long_radius = long_size.saturating_sub(1) / 2;
    let thin_radius = thin_size.saturating_sub(1) / 2;
    let horizontal = open(cleaned, long_radius, thin_radius);
    let vertical = open(cleaned, thin_radius, long_radius);
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
}

struct TrimProposal {
    side: TrimSide,
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
    score: f64,
    threshold: f64,
}

struct TrimGeometry {
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
}

#[allow(clippy::too_many_arguments)]
fn trim_content_bounds(
    content: &BinaryImage,
    component_map: &ComponentMap,
    blocks: &[BlockStats],
    component_blocks: &[usize],
    text_mask: &BinaryImage,
    mut garbage_labels: Vec<u32>,
    calibration: PageCalibration,
) -> (Option<PixelBounds>, [f64; 4]) {
    let mut active = blocks
        .iter()
        .map(|block| block.initialized)
        .collect::<Vec<_>>();
    if let Some(first) = active.first_mut() {
        *first = false;
    }
    let Some(mut bounds) = bounds_for_active_blocks(blocks, &active) else {
        return (None, [0.0; 4]);
    };
    let mut confidence = [0.0f64; 4];
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
        );
        bounds = bounds_for_active_blocks(blocks, &active)
            .expect("an accepted trim proposal retains at least one content block");
    }
    (Some(bounds), confidence)
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
            .any(|(label, block)| removed_blocks[label] && block.grayscale_supported)
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
    for y in top..=bottom {
        for x in left..=right {
            labels[y * width + x] = REMOVED_GARBAGE;
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
        diagnostics: None,
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
            for x in 382..390 {
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
}
