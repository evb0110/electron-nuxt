use crate::{
    background::{normalize_illumination, smooth_for_binarization},
    BinarizationMode, CleanupOptions,
};
use scan_primitives::{
    threshold::{
        otsu_threshold, threshold_global, threshold_global_biased, threshold_local,
        threshold_local_biased, LocalThreshold,
    },
    BinaryImage, ComponentMap, GrayImage,
};
use serde::{Deserialize, Serialize};
use std::{cmp::Reverse, collections::BinaryHeap, sync::OnceLock};

// Corpus calibration keeps Wolf below the 0.3 reference setting: 0.3 erased
// the Stage-B thin-stroke golden, while 0.2 retained it without adding noise.
const WOLF_K: f64 = 0.20;
const SAUVOLA_K: f64 = 0.34;
const WOLF_MINIMUM_PERCENTILE: f64 = 0.01;
const WOLF_HARD_INK: u8 = 48;
const WOLF_HARD_PAPER: u8 = 248;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarizationDiagnostics {
    pub route: BinarizationMode,
    pub robust_contrast: f64,
    pub illumination_deviation: f64,
    pub edge_density: f64,
    pub estimated_stroke_width_px: f64,
    pub dark_border_coverage: f64,
    pub otsu_adaptive_agreement: f64,
}

#[derive(Clone, Debug)]
pub struct BwResult {
    pub normalized: GrayImage,
    pub binary: BinaryImage,
    pub mode: BinarizationMode,
}

pub fn clean_black_and_white(source: &GrayImage, options: &CleanupOptions) -> BwResult {
    let normalized = if options.normalize_illumination {
        normalize_illumination(source, options.dpi)
    } else {
        source.clone()
    };
    let (binary, mode) = binarize_normalized(&normalized, options);
    BwResult {
        normalized,
        binary,
        mode,
    }
}

/// Binarizes an already illumination-normalized image. Keeping normalization out of
/// this step lets callers resample gray tones exactly once before thresholding.
pub fn binarize_normalized(
    normalized: &GrayImage,
    options: &CleanupOptions,
) -> (BinaryImage, BinarizationMode) {
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(&threshold_input, options);
    let mode = diagnostics.route;
    (binarize_with_mode(&threshold_input, options, mode), mode)
}

pub(crate) fn binarize_normalized_with_diagnostics(
    normalized: &GrayImage,
    routing_sample: &GrayImage,
    options: &CleanupOptions,
) -> (BinaryImage, BinarizationDiagnostics) {
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(routing_sample, options);
    let binary = binarize_with_mode(&threshold_input, options, diagnostics.route);
    (binary, diagnostics)
}

fn binarize_with_mode(
    threshold_input: &GrayImage,
    options: &CleanupOptions,
    mode: BinarizationMode,
) -> BinaryImage {
    let radius = ((options.dpi * 25.5 / 300.0).round() as usize).clamp(8, 64);
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    let binary = match mode {
        BinarizationMode::Otsu => {
            threshold_global_biased(threshold_input, otsu_threshold(threshold_input), bias)
        }
        BinarizationMode::Sauvola => threshold_local_biased(
            threshold_input,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_biased(
            threshold_input,
            radius,
            LocalThreshold::Wolf {
                k: WOLF_K,
                deviation_floor: 2.0,
                minimum_percentile: WOLF_MINIMUM_PERCENTILE,
                hard_ink: WOLF_HARD_INK,
                hard_paper: WOLF_HARD_PAPER,
            },
            bias,
        ),
    };
    postprocess_binary(&binary, options)
}

pub(crate) fn postprocess_binary(binary: &BinaryImage, options: &CleanupOptions) -> BinaryImage {
    let despeckled = if options.despeckle {
        despeckle_connected(binary, options.dpi)
    } else {
        binary.clone()
    };
    smooth_edges_for_page(&despeckled, options.dpi)
}

pub(crate) fn resolve_binarization_diagnostics(
    image: &GrayImage,
    options: &CleanupOptions,
) -> BinarizationDiagnostics {
    let sample = image.downscale_to_fit(256, 256);
    let otsu = threshold_global(&sample, otsu_threshold(&sample));
    let adaptive_radius =
        ((sample.width().min(sample.height()) as f64 * 0.035).round() as usize).clamp(4, 12);
    let adaptive = threshold_local(
        &sample,
        adaptive_radius,
        LocalThreshold::Wolf {
            k: WOLF_K,
            deviation_floor: 2.0,
            minimum_percentile: WOLF_MINIMUM_PERCENTILE,
            hard_ink: WOLF_HARD_INK,
            hard_paper: WOLF_HARD_PAPER,
        },
    );
    let robust_contrast =
        f64::from(image_percentile(&sample, 0.95)) - f64::from(image_percentile(&sample, 0.05));
    let illumination_deviation = tile_paper_deviation(&sample);
    let edge_density = edge_density(&sample);
    let sample_scale = (image.width() as f64 / sample.width().max(1) as f64)
        .max(image.height() as f64 / sample.height().max(1) as f64);
    let estimated_stroke_width_px = estimated_stroke_width(&otsu) * sample_scale;
    let dark_border_coverage = dark_border_coverage(&sample, otsu_threshold(&sample));
    let otsu_adaptive_agreement = binary_agreement(&otsu, &adaptive);
    let route = match options.binarization {
        BinarizationMode::Auto => choose_mode(
            robust_contrast,
            illumination_deviation,
            edge_density,
            estimated_stroke_width_px,
            dark_border_coverage,
            otsu_adaptive_agreement,
        ),
        explicit => explicit,
    };
    BinarizationDiagnostics {
        route,
        robust_contrast,
        illumination_deviation,
        edge_density,
        estimated_stroke_width_px,
        dark_border_coverage,
        otsu_adaptive_agreement,
    }
}

fn choose_mode(
    robust_contrast: f64,
    illumination_deviation: f64,
    edge_density: f64,
    estimated_stroke_width_px: f64,
    dark_border_coverage: f64,
    otsu_adaptive_agreement: f64,
) -> BinarizationMode {
    let clean_uniform = illumination_deviation <= 8.0
        && dark_border_coverage <= 0.06
        && otsu_adaptive_agreement >= 0.975
        && (robust_contrast >= 72.0 || edge_density <= 0.16);
    if clean_uniform {
        return BinarizationMode::Otsu;
    }
    let uneven_text = illumination_deviation > 12.0
        && edge_density <= 0.24
        && estimated_stroke_width_px <= 8.0
        && otsu_adaptive_agreement >= 0.84;
    if uneven_text {
        BinarizationMode::Sauvola
    } else {
        BinarizationMode::Wolf
    }
}

fn image_percentile(image: &GrayImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let count = image.width().saturating_mul(image.height());
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

fn tile_paper_deviation(image: &GrayImage) -> f64 {
    let mut paper = Vec::with_capacity(16);
    for tile_y in 0..4 {
        let top = tile_y * image.height() / 4;
        let bottom = ((tile_y + 1) * image.height() / 4).max(top + 1);
        for tile_x in 0..4 {
            let left = tile_x * image.width() / 4;
            let right = ((tile_x + 1) * image.width() / 4).max(left + 1);
            let mut histogram = [0usize; 256];
            let mut count = 0usize;
            for y in top..bottom.min(image.height()) {
                for x in left..right.min(image.width()) {
                    histogram[image.get(x, y) as usize] += 1;
                    count += 1;
                }
            }
            let target = ((count.saturating_sub(1)) as f64 * 0.8).round() as usize;
            let mut cumulative = 0usize;
            let value = histogram
                .into_iter()
                .enumerate()
                .find_map(|(value, frequency)| {
                    cumulative += frequency;
                    (cumulative > target).then_some(value as f64)
                })
                .unwrap_or(255.0);
            paper.push(value);
        }
    }
    let mean = paper.iter().sum::<f64>() / paper.len().max(1) as f64;
    (paper
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / paper.len().max(1) as f64)
        .sqrt()
}

fn edge_density(image: &GrayImage) -> f64 {
    if image.width() < 2 || image.height() < 2 {
        return 0.0;
    }
    let mut edges = 0usize;
    let mut count = 0usize;
    for y in 1..image.height() {
        for x in 1..image.width() {
            let value = image.get(x, y);
            let gradient = value.abs_diff(image.get(x - 1, y)) as usize
                + value.abs_diff(image.get(x, y - 1)) as usize;
            edges += usize::from(gradient >= 32);
            count += 1;
        }
    }
    edges as f64 / count.max(1) as f64
}

fn estimated_stroke_width(binary: &BinaryImage) -> f64 {
    let mut runs = Vec::new();
    for y in 0..binary.height() {
        let mut start = None;
        for x in 0..=binary.width() {
            let black = x < binary.width() && binary.get(x, y);
            match (start, black) {
                (None, true) => start = Some(x),
                (Some(run_start), false) => {
                    let length = x - run_start;
                    if length <= 32 {
                        runs.push(length as f64);
                    }
                    start = None;
                }
                _ => {}
            }
        }
    }
    if runs.is_empty() {
        return 0.0;
    }
    runs.sort_unstable_by(f64::total_cmp);
    runs[runs.len() / 2]
}

fn dark_border_coverage(image: &GrayImage, threshold: u8) -> f64 {
    let band = image.width().min(image.height()).div_ceil(30).max(1);
    let mut dark = 0usize;
    let mut count = 0usize;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if x < band || y < band || x + band >= image.width() || y + band >= image.height() {
                dark += usize::from(image.get(x, y) < threshold);
                count += 1;
            }
        }
    }
    dark as f64 / count.max(1) as f64
}

fn binary_agreement(left: &BinaryImage, right: &BinaryImage) -> f64 {
    let mut matching = 0usize;
    let count = left.width().saturating_mul(left.height());
    for y in 0..left.height() {
        for x in 0..left.width() {
            matching += usize::from(left.get(x, y) == right.get(x, y));
        }
    }
    matching as f64 / count.max(1) as f64
}

pub fn binary_to_gray(binary: &BinaryImage) -> GrayImage {
    let mut output = GrayImage::new(binary.width(), binary.height(), 255);
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if binary.get(x, y) {
                output.set(x, y, 0);
            }
        }
    }
    output
}

pub fn smooth_edges(source: &BinaryImage) -> BinaryImage {
    smooth_edges_with_profile(source, SmoothProfile::Legacy)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SmoothProfile {
    Legacy,
    TopologySafe,
}

fn smooth_edges_for_page(source: &BinaryImage, dpi: f64) -> BinaryImage {
    smooth_edges_with_profile(source, resolve_smooth_profile(source, dpi))
}

fn resolve_smooth_profile(source: &BinaryImage, dpi: f64) -> SmoothProfile {
    let stroke_width = estimated_stroke_width(source);
    if (120.0..=600.0).contains(&dpi) && (1.0..=12.0).contains(&stroke_width) {
        SmoothProfile::TopologySafe
    } else {
        SmoothProfile::Legacy
    }
}

fn smooth_edges_with_profile(source: &BinaryImage, profile: SmoothProfile) -> BinaryImage {
    if source.width() < 3 || source.height() < 3 {
        return source.clone();
    }
    if profile == SmoothProfile::TopologySafe {
        return smooth_edges_with_topology_lut(source);
    }
    let mut output = source.clone();
    for y in 1..source.height() - 1 {
        for x in 1..source.width() - 1 {
            let north = source.get(x, y - 1);
            let south = source.get(x, y + 1);
            let west = source.get(x - 1, y);
            let east = source.get(x + 1, y);
            let diagonals = [
                source.get(x - 1, y - 1),
                source.get(x + 1, y - 1),
                source.get(x - 1, y + 1),
                source.get(x + 1, y + 1),
            ];
            let cardinal_count = [north, south, west, east]
                .into_iter()
                .filter(|value| *value)
                .count();
            let neighbor_count =
                cardinal_count + diagonals.into_iter().filter(|value| *value).count();
            if !source.get(x, y) {
                let bridges_opposites = (north && south) || (west && east);
                if neighbor_count >= 5 && bridges_opposites {
                    output.set(x, y, true);
                }
            } else if neighbor_count <= 1 {
                output.set(x, y, false);
            }
        }
    }
    output
}

static TOPOLOGY_SMOOTH_LUT: OnceLock<[bool; 512]> = OnceLock::new();

fn topology_smooth_lut() -> &'static [bool; 512] {
    TOPOLOGY_SMOOTH_LUT.get_or_init(|| {
        let mut lut = [false; 512];
        for (pattern, output) in lut.iter_mut().enumerate() {
            *output = topology_checked_center(pattern as u16);
        }
        lut
    })
}

fn smooth_edges_with_topology_lut(source: &BinaryImage) -> BinaryImage {
    let lut = topology_smooth_lut();
    let mut output = source.clone();
    for y in 1..source.height() - 1 {
        for x in 1..source.width() - 1 {
            let mut pattern = 0usize;
            for offset_y in 0..3 {
                for offset_x in 0..3 {
                    if source.get(x + offset_x - 1, y + offset_y - 1) {
                        pattern |= 1 << (offset_y * 3 + offset_x);
                    }
                }
            }
            output.set(x, y, lut[pattern]);
        }
    }
    output
}

fn topology_checked_center(pattern: u16) -> bool {
    let center = pattern & (1 << 4) != 0;
    let proposed = legacy_center_decision(pattern);
    if proposed == center {
        return center;
    }
    let neighbor_count = (pattern & !(1 << 4)).count_ones();
    if center && neighbor_count < 2 {
        return center;
    }
    let changed = if proposed {
        pattern | (1 << 4)
    } else {
        pattern & !(1 << 4)
    };
    let preserves_ink = neighborhood_component_count(pattern, true, true)
        == neighborhood_component_count(changed, true, true);
    let preserves_paper = neighborhood_component_count(pattern, false, false)
        == neighborhood_component_count(changed, false, false);
    if preserves_ink && preserves_paper {
        proposed
    } else {
        center
    }
}

fn legacy_center_decision(pattern: u16) -> bool {
    let center = pattern & (1 << 4) != 0;
    let black = |bit: usize| pattern & (1 << bit) != 0;
    let north = black(1);
    let west = black(3);
    let east = black(5);
    let south = black(7);
    let neighbor_count = (pattern & !(1 << 4)).count_ones();
    if !center && neighbor_count >= 5 && ((north && south) || (west && east)) {
        true
    } else if center && neighbor_count <= 1 {
        false
    } else {
        center
    }
}

fn neighborhood_component_count(pattern: u16, black: bool, eight_connected: bool) -> usize {
    let mut visited = [false; 9];
    let mut count = 0usize;
    for start in 0..9 {
        if visited[start] || ((pattern & (1 << start) != 0) != black) {
            continue;
        }
        count += 1;
        let mut stack = [0usize; 9];
        let mut length = 1usize;
        stack[0] = start;
        visited[start] = true;
        while length > 0 {
            length -= 1;
            let current = stack[length];
            let current_x = current % 3;
            let current_y = current / 3;
            for (candidate, candidate_visited) in visited.iter_mut().enumerate() {
                if *candidate_visited || ((pattern & (1 << candidate) != 0) != black) {
                    continue;
                }
                let candidate_x = candidate % 3;
                let candidate_y = candidate / 3;
                let delta_x = current_x.abs_diff(candidate_x);
                let delta_y = current_y.abs_diff(candidate_y);
                let adjacent = if eight_connected {
                    delta_x <= 1 && delta_y <= 1 && delta_x + delta_y > 0
                } else {
                    delta_x + delta_y == 1
                };
                if adjacent {
                    *candidate_visited = true;
                    stack[length] = candidate;
                    length += 1;
                }
            }
        }
    }
    count
}

pub fn despeckle_connected(source: &BinaryImage, dpi: f64) -> BinaryImage {
    despeckle_connected_impl(source, dpi, true)
}

fn despeckle_connected_impl(
    source: &BinaryImage,
    dpi: f64,
    use_attachment_graph: bool,
) -> BinaryImage {
    let components = ComponentMap::from_binary(source);
    if components.components().is_empty() {
        return source.clone();
    }
    let scale = (dpi / 300.0).clamp(0.5, 4.0);
    let substantial_area = (32.0 * scale * scale).round().max(16.0) as usize;
    let expansion_limit = (7.0 * scale).round().max(3.0) as u32 * 4;
    let maximum_attachment_cost = expansion_limit.saturating_mul(2);
    let mut graph = vec![Vec::<AttachmentEdge>::new(); components.components().len() + 1];
    populate_attachment_graph(components.components(), expansion_limit, &mut graph);
    let mut keep = vec![false; graph.len()];
    let mut distance = vec![u32::MAX; graph.len()];
    let mut hops = vec![u8::MAX; graph.len()];
    let mut queue = BinaryHeap::new();
    for component in components.components() {
        if component.area >= substantial_area {
            let label = component.label as usize;
            keep[label] = true;
            distance[label] = 0;
            hops[label] = 0;
            queue.push(Reverse((0u32, 0u8, label)));
        }
    }
    if use_attachment_graph {
        while let Some(Reverse((cost, hop_count, label))) = queue.pop() {
            if cost != distance[label] || hop_count != hops[label] || hop_count >= 3 {
                continue;
            }
            let parent = &components.components()[label - 1];
            for edge in &graph[label] {
                let candidate = &components.components()[edge.neighbor - 1];
                if candidate.area >= substantial_area
                    || !relative_attachment_size_is_safe(parent.area, candidate.area)
                {
                    continue;
                }
                let next_cost = cost.saturating_add(edge.cost);
                let next_hops = hop_count + 1;
                if next_cost > maximum_attachment_cost
                    || (next_cost, next_hops) >= (distance[edge.neighbor], hops[edge.neighbor])
                {
                    continue;
                }
                distance[edge.neighbor] = next_cost;
                hops[edge.neighbor] = next_hops;
                keep[edge.neighbor] = true;
                queue.push(Reverse((next_cost, next_hops, edge.neighbor)));
            }
        }
        protect_line_supported_marks(
            components.components(),
            substantial_area,
            expansion_limit,
            &mut keep,
        );
    }
    components.retain(|component| keep[component.label as usize])
}

#[derive(Clone, Copy, Debug)]
struct AttachmentEdge {
    neighbor: usize,
    cost: u32,
}

fn relative_attachment_size_is_safe(parent_area: usize, candidate_area: usize) -> bool {
    candidate_area <= parent_area.saturating_mul(2)
}

fn populate_attachment_graph(
    components: &[scan_primitives::Component],
    expansion_limit: u32,
    graph: &mut [Vec<AttachmentEdge>],
) {
    let mut by_left = (0..components.len()).collect::<Vec<_>>();
    by_left.sort_unstable_by_key(|&index| components[index].left);
    let horizontal_reach = (expansion_limit / 2) as usize;
    for (position, &left_index) in by_left.iter().enumerate() {
        let left = &components[left_index];
        for &right_index in &by_left[position + 1..] {
            let right = &components[right_index];
            if right.left > left.right.saturating_add(horizontal_reach + 1) {
                break;
            }
            let cost = component_gap_cost(left, right);
            if cost <= expansion_limit {
                graph[left.label as usize].push(AttachmentEdge {
                    neighbor: right.label as usize,
                    cost,
                });
                graph[right.label as usize].push(AttachmentEdge {
                    neighbor: left.label as usize,
                    cost,
                });
            }
        }
    }
}

fn protect_line_supported_marks(
    components: &[scan_primitives::Component],
    substantial_area: usize,
    expansion_limit: u32,
    keep: &mut [bool],
) {
    // Cautious mode treats an entire bracketed text row as supporting evidence.
    // This protects long dot leaders and isolated punctuation without making
    // them graph bridges: they are retained but never added to the Dijkstra queue.
    let horizontal_reach = (expansion_limit as usize).saturating_mul(32);
    let vertical_reach = (expansion_limit as usize / 3).max(2);
    let anchors = components
        .iter()
        .filter(|component| component.area >= substantial_area)
        .collect::<Vec<_>>();
    for mark in components {
        let label = mark.label as usize;
        if keep[label] || mark.area < 2 || mark.area >= substantial_area {
            continue;
        }
        let mark_center_y = (mark.top + mark.bottom) / 2;
        let mut supported_left = false;
        let mut supported_right = false;
        for anchor in &anchors {
            let anchor_center_y = (anchor.top + anchor.bottom) / 2;
            let line_tolerance = vertical_reach.max((anchor.bottom - anchor.top).div_ceil(2));
            if mark_center_y.abs_diff(anchor_center_y) > line_tolerance {
                continue;
            }
            if anchor.right < mark.left && mark.left - anchor.right - 1 <= horizontal_reach {
                supported_left = true;
            }
            if mark.right < anchor.left && anchor.left - mark.right - 1 <= horizontal_reach {
                supported_right = true;
            }
        }
        if supported_left && supported_right {
            keep[label] = true;
        }
    }
}

fn component_gap_cost(
    left: &scan_primitives::Component,
    right: &scan_primitives::Component,
) -> u32 {
    let x_gap = axis_gap(left.left, left.right, right.left, right.right) as u32;
    let y_gap = axis_gap(left.top, left.bottom, right.top, right.bottom) as u32;
    let diagonal = x_gap.min(y_gap);
    diagonal * 4 + (x_gap - diagonal) * 2 + (y_gap - diagonal) * 3
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

#[cfg(test)]
mod tests {
    use super::*;

    fn binary_fixture(bytes: &[u8]) -> BinaryImage {
        let gray = crate::png::decode_gray(bytes, 1_000_000, 2_000).unwrap();
        let mut binary = BinaryImage::new(gray.width(), gray.height());
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                binary.set(x, y, gray.get(x, y) < 128);
            }
        }
        binary
    }

    fn black_count(image: &BinaryImage) -> usize {
        (0..image.height())
            .map(|y| (0..image.width()).filter(|&x| image.get(x, y)).count())
            .sum()
    }

    fn has_ink_near(image: &BinaryImage, point: (usize, usize), radius: usize) -> bool {
        let (x, y) = point;
        (y.saturating_sub(radius)..=(y + radius).min(image.height() - 1)).any(|sample_y| {
            (x.saturating_sub(radius)..=(x + radius).min(image.width() - 1))
                .any(|sample_x| image.get(sample_x, sample_y))
        })
    }

    fn tiny_component_count(image: &BinaryImage, maximum_area: usize) -> usize {
        ComponentMap::from_binary(image)
            .components()
            .iter()
            .filter(|component| component.area <= maximum_area)
            .count()
    }

    #[test]
    fn router_uses_page_features_instead_of_a_single_contrast_statistic() {
        assert_eq!(
            choose_mode(100.0, 4.0, 0.12, 3.0, 0.01, 0.98),
            BinarizationMode::Otsu
        );
        assert_eq!(
            choose_mode(18.0, 2.0, 0.10, 2.0, 0.0, 0.99),
            BinarizationMode::Otsu,
            "sparse clean pages have low percentile contrast but strong agreement"
        );
        assert_eq!(
            choose_mode(100.0, 18.0, 0.12, 3.0, 0.01, 0.90),
            BinarizationMode::Sauvola
        );
        assert_eq!(
            choose_mode(100.0, 4.0, 0.12, 3.0, 0.12, 0.98),
            BinarizationMode::Wolf
        );
        assert_eq!(
            choose_mode(100.0, 18.0, 0.30, 12.0, 0.01, 0.90),
            BinarizationMode::Wolf
        );
    }

    #[test]
    fn router_diagnostics_are_finite_and_bounded() {
        let mut image = GrayImage::new(160, 120, 238);
        for y in 18..102 {
            for x in (14..146).step_by(16) {
                for stroke_x in x..(x + 3) {
                    image.set(stroke_x, y, 42 + (y / 8) as u8);
                }
            }
        }
        let diagnostics = resolve_binarization_diagnostics(&image, &CleanupOptions::default());
        for value in [
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ] {
            assert!(value.is_finite());
            assert!(value >= 0.0);
        }
        assert!(diagnostics.edge_density <= 1.0);
        assert!(diagnostics.dark_border_coverage <= 1.0);
        assert!(diagnostics.otsu_adaptive_agreement <= 1.0);
    }

    #[test]
    fn attachment_graph_preserves_diacritic_but_removes_equal_sized_far_blob() {
        let mut image = BinaryImage::new(80, 45);
        for y in 20..28 {
            for x in 15..28 {
                image.set(x, y, true);
            }
        }
        for y in 15..18 {
            for x in 18..21 {
                image.set(x, y, true);
            }
        }
        for y in 4..7 {
            for x in 55..58 {
                image.set(x, y, true);
            }
        }
        for &(x, y) in &[(2, 2), (70, 38), (45, 22)] {
            image.set(x, y, true);
        }
        let cleaned = despeckle_connected(&image, 300.0);
        let graph_disabled = despeckle_connected_impl(&image, 300.0, false);
        assert!(
            cleaned.get(18, 15),
            "nearby diacritic must remain through attachment graph"
        );
        assert!(
            !graph_disabled.get(18, 15),
            "fixture must prove the attachment graph is load-bearing"
        );
        assert!(
            !cleaned.get(55, 4),
            "equal-sized isolated blob must be removed"
        );
        assert!(!cleaned.get(2, 2));
        assert!(!cleaned.get(70, 38));
    }

    #[test]
    fn cautious_despeckle_caps_transitive_noise_chains() {
        let mut image = BinaryImage::new(90, 50);
        for y in 20..28 {
            for x in 5..13 {
                image.set(x, y, true);
            }
        }
        for left in [27, 41, 55, 69] {
            for y in 23..25 {
                for x in left..left + 2 {
                    image.set(x, y, true);
                }
            }
        }
        let cleaned = despeckle_connected(&image, 300.0);
        assert!(cleaned.get(27, 23), "directly attached mark must remain");
        assert!(cleaned.get(41, 23), "one bounded attachment may remain");
        assert!(
            !cleaned.get(55, 23) && !cleaned.get(69, 23),
            "a speck chain must not propagate arbitrarily far"
        );
    }

    #[test]
    fn cautious_despeckle_protects_bracketed_line_punctuation_only() {
        let mut image = BinaryImage::new(90, 50);
        for left in [10, 60] {
            for y in 20..28 {
                for x in left..left + 8 {
                    image.set(x, y, true);
                }
            }
        }
        for y in 23..25 {
            for x in 40..42 {
                image.set(x, y, true);
            }
        }
        for y in 3..5 {
            for x in 40..42 {
                image.set(x, y, true);
            }
        }
        let cleaned = despeckle_connected(&image, 300.0);
        assert!(cleaned.get(40, 23), "bracketed punctuation must remain");
        assert!(!cleaned.get(40, 3), "unsupported dust must be removed");
    }

    #[test]
    fn corpus_glyph_goldens_preserve_niqqud_and_arabic_dots() {
        let cases = [
            (
                "BHS p126 Hebrew niqqud",
                binary_fixture(include_bytes!(
                    "../tests/fixtures/glyphs/hebrew-bhs-p126-niqqud-input.png"
                )),
                300.0,
                &[(380, 44), (676, 29), (763, 29), (928, 43), (971, 225)][..],
                3,
            ),
            (
                "Wright p82 Arabic dots",
                binary_fixture(include_bytes!(
                    "../tests/fixtures/glyphs/arabic-wright-p82-dots-input.png"
                )),
                150.0,
                &[(189, 75), (457, 75), (757, 216), (634, 248), (1246, 74)][..],
                5,
            ),
        ];
        for (name, source, dpi, protected_points, radius) in cases {
            let despeckled = despeckle_connected(&source, dpi);
            assert_eq!(
                resolve_smooth_profile(&despeckled, dpi),
                SmoothProfile::TopologySafe,
                "{name} must exercise the topology-safe LUT"
            );
            let cleaned = smooth_edges_for_page(&despeckled, dpi);
            for &point in protected_points {
                assert!(
                    has_ink_near(&source, point, radius),
                    "bad {name} annotation"
                );
                assert!(
                    has_ink_near(&cleaned, point, radius),
                    "{name} lost protected mark near {point:?}"
                );
            }
            let retention = black_count(&cleaned) as f64 / black_count(&source).max(1) as f64;
            assert!(
                retention >= 0.985,
                "{name} retained only {:.2}% of ink",
                retention * 100.0
            );
        }
    }

    #[test]
    fn bedjan_corpus_golden_still_removes_isolated_speckles() {
        let source = binary_fixture(include_bytes!(
            "../tests/fixtures/glyphs/bedjan-p2-speckles-input.png"
        ));
        let cleaned = despeckle_connected(&source, 150.0);
        let before_tiny = tiny_component_count(&source, 7);
        let after_tiny = tiny_component_count(&cleaned, 7);
        assert!(
            before_tiny >= 5,
            "Bedjan fixture needs a real speckle load, found {before_tiny}"
        );
        assert!(
            after_tiny * 2 <= before_tiny,
            "Bedjan tiny components were not reduced enough: {before_tiny} -> {after_tiny}"
        );
        let retention = black_count(&cleaned) as f64 / black_count(&source).max(1) as f64;
        assert!(
            retention >= 0.97,
            "Bedjan text ink retention was {retention:.4}"
        );
    }

    #[test]
    fn edge_smoothing_fills_dents_and_trims_isolated_bumps() {
        let mut image = BinaryImage::new(7, 7);
        for y in 2..5 {
            for x in 2..5 {
                image.set(x, y, true);
            }
        }
        image.set(3, 3, false);
        image.set(5, 5, true);
        let smoothed = smooth_edges(&image);
        assert!(smoothed.get(3, 3), "one-pixel dent must be filled");
        assert!(!smoothed.get(5, 5), "one-pixel bump must be trimmed");
    }

    #[test]
    fn topology_lut_exhaustively_preserves_local_components() {
        let lut = topology_smooth_lut();
        let mut changed_patterns = 0usize;
        for pattern in 0u16..512 {
            let center = pattern & (1 << 4) != 0;
            let actual = lut[pattern as usize];
            assert_eq!(actual, topology_checked_center(pattern));
            assert!(actual == center || actual == legacy_center_decision(pattern));
            if actual != center {
                changed_patterns += 1;
                let changed = if actual {
                    pattern | (1 << 4)
                } else {
                    pattern & !(1 << 4)
                };
                assert_eq!(
                    neighborhood_component_count(pattern, true, true),
                    neighborhood_component_count(changed, true, true),
                    "ink topology changed for {pattern:09b}"
                );
                assert_eq!(
                    neighborhood_component_count(pattern, false, false),
                    neighborhood_component_count(changed, false, false),
                    "paper topology changed for {pattern:09b}"
                );
            }
            if center && (pattern & !(1 << 4)).count_ones() <= 1 {
                assert!(
                    actual,
                    "isolated marks and endpoints must survive {pattern:09b}"
                );
            }
            assert_eq!(actual, lut[rotate_pattern_clockwise(pattern) as usize]);
        }
        assert!(
            changed_patterns > 0,
            "topology profile must retain useful smoothing"
        );
        assert!(lut[16], "an isolated punctuation pixel must survive");
        assert!(lut[48], "a one-neighbor stroke endpoint must survive");
        assert!(lut[47], "a topology-safe boundary dent should be filled");
    }

    fn rotate_pattern_clockwise(pattern: u16) -> u16 {
        let mut rotated = 0u16;
        for y in 0..3 {
            for x in 0..3 {
                if pattern & (1 << (y * 3 + x)) != 0 {
                    rotated |= 1 << (x * 3 + (2 - y));
                }
            }
        }
        rotated
    }

    #[test]
    fn edge_smoothing_uses_topology_profile_only_in_calibrated_dpi_stroke_band() {
        let mut image = BinaryImage::new(11, 9);
        for y in 2..7 {
            for x in 2..5 {
                image.set(x, y, true);
            }
        }
        image.set(8, 6, true);
        assert_eq!(estimated_stroke_width(&image), 3.0);
        assert!(
            smooth_edges_for_page(&image, 300.0).get(8, 6),
            "topology profile must retain isolated punctuation"
        );
        assert!(
            !smooth_edges_for_page(&image, 72.0).get(8, 6),
            "legacy profile remains the explicit low-DPI fallback"
        );
    }
}
