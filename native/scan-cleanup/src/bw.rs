use crate::{background::normalize_illumination, BinarizationMode, CleanupOptions};
use scan_primitives::{
    threshold::{otsu_threshold, threshold_global_biased, threshold_local_biased, LocalThreshold},
    BinaryImage, ComponentMap, GrayImage,
};

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
    let mode = match options.binarization {
        BinarizationMode::Auto => choose_mode(normalized),
        explicit => explicit,
    };
    let radius = ((options.dpi * 25.5 / 300.0).round() as usize).clamp(8, 64);
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    let binary = match mode {
        BinarizationMode::Otsu => {
            threshold_global_biased(normalized, otsu_threshold(normalized), bias)
        }
        BinarizationMode::Sauvola => threshold_local_biased(
            normalized,
            radius,
            LocalThreshold::Sauvola { k: 0.34 },
            bias,
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_biased(
            normalized,
            radius,
            LocalThreshold::Wolf {
                k: 0.2,
                deviation_floor: 2.0,
            },
            bias,
        ),
    };
    let smoothed = smooth_edges(&binary);
    let binary = if options.despeckle {
        despeckle_connected(&smoothed, options.dpi)
    } else {
        smoothed
    };
    (binary, mode)
}

fn choose_mode(image: &GrayImage) -> BinarizationMode {
    let sample = image.downscale_to_fit(64, 64);
    let mut sum = 0.0;
    let mut square = 0.0;
    let mut count = 0.0;
    for y in 0..sample.height() {
        for &value in sample.row(y) {
            let value = f64::from(value);
            sum += value;
            square += value * value;
            count += 1.0;
        }
    }
    let deviation = (square / count - (sum / count).powi(2)).max(0.0).sqrt();
    if deviation > 28.0 {
        BinarizationMode::Wolf
    } else {
        BinarizationMode::Otsu
    }
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
    if source.width() < 3 || source.height() < 3 {
        return source.clone();
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
    let mut graph = vec![Vec::<usize>::new(); components.components().len() + 1];
    populate_attachment_graph(components.components(), expansion_limit, &mut graph);
    let mut keep = vec![false; graph.len()];
    let mut stack = Vec::new();
    for component in components.components() {
        if component.area >= substantial_area {
            keep[component.label as usize] = true;
            stack.push(component.label as usize);
        }
    }
    if use_attachment_graph {
        while let Some(label) = stack.pop() {
            for &neighbor in &graph[label] {
                if !keep[neighbor] {
                    keep[neighbor] = true;
                    stack.push(neighbor);
                }
            }
        }
    }
    components.retain(|component| keep[component.label as usize])
}

fn populate_attachment_graph(
    components: &[scan_primitives::Component],
    expansion_limit: u32,
    graph: &mut [Vec<usize>],
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
            if component_gap_cost(left, right) <= expansion_limit {
                graph[left.label as usize].push(right.label as usize);
                graph[right.label as usize].push(left.label as usize);
            }
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
}
