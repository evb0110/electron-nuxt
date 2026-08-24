use crate::{dewarp::DewarpModel, DewarpOptions};
use scan_primitives::{
    blur::gaussian_blur_f32,
    distance::{find_peaks, squared_euclidean_distance},
    morphology::{close, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage, Point,
};
use std::collections::BTreeSet;

const WORKING_DPI: f64 = 200.0;
const WOLF_RADIUS: usize = 15;
const BOUND_ANGLE_WINDOW_DEGREES: f64 = 4.0;
const BAND_BLUR_SIGMA: f64 = 6.0;
const OBSTACLE_BLUR_SIGMA: f64 = 12.0;
const BAND_THRESHOLD_FRACTION: f32 = 15.0 / 255.0;
const BAND_CLOSE_RADIUS: usize = 10;
const MIN_KNOT_DISTANCE: f64 = 10.0;
const TRACE_ENDPOINT_GAP_FRACTION: f64 = 0.3;
const SNAKE_SPACING: f64 = 20.0;
const SNAKE_RIB_HALF_LENGTH: isize = 4;
const SNAKE_MAX_ITERATIONS: usize = 100;
const SNAKE_ELASTICITY: f64 = 0.2;
const SNAKE_BENDING: f64 = 1.8;
const SNAKE_EXTERNAL: f64 = 1.0;
const MIN_TRACED_LINES: usize = 5;
const MIN_MEDIAN_LENGTH_FRACTION: f64 = 0.4;
const MIN_RELATIVE_IMPROVEMENT: f64 = 0.15;
const MIN_ABSOLUTE_IMPROVEMENT: f64 = 0.001;
const SLOPE_PENALTY: f64 = 0.2;
const DEPTHS: [f64; 5] = [1.0, 1.5, 2.0, 2.5, 3.0];
const TEXT_COMPONENT_MIN_ASPECT_RATIO: f64 = 0.1;
const TEXT_COMPONENT_MAX_ASPECT_RATIO: f64 = 10.0;
const MODEL_CONTAINMENT_VERTICAL_PADDING: f64 = 10.0;
// Ridge tracing can stop a few glyphs short of the physical text edge when a
// glyph's horizontal stroke does not support the band response. Keep this
// allowance horizontal only. The vertical envelope remains tight so a narrow
// model cannot hide a separate text block above or below it.
const MODEL_CONTAINMENT_HORIZONTAL_PADDING: f64 = 24.0;

#[derive(Clone, Debug)]
pub struct AutoDewarpResult {
    pub model: Option<DewarpOptions>,
    pub confidence: f64,
}

#[derive(Clone, Debug)]
struct TracedLine {
    points: Vec<Point>,
    length: f64,
    mean_y: f64,
}

#[derive(Clone, Copy, Debug)]
struct FittedBound {
    x_per_y: f64,
    intercept: f64,
}

impl FittedBound {
    fn x_at(self, y: f64) -> f64 {
        self.intercept + self.x_per_y * y
    }
}

#[derive(Clone, Debug)]
struct ContentGeometry {
    left: FittedBound,
    right: FittedBound,
    top: Vec<f64>,
    bottom: Vec<f64>,
    top_y: f64,
    bottom_y: f64,
    width: f64,
    raster_width: f64,
}

/// Detects dewarp directrices with 200-DPI constants. Callers that know the
/// raster DPI should use [`detect_curves_at_dpi`] so high-resolution pages are
/// reduced to the intended analysis scale.
pub fn detect_curves(source: &GrayImage) -> AutoDewarpResult {
    detect_curves_at_dpi(source, WORKING_DPI)
}

pub fn detect_curves_at_dpi(source: &GrayImage, effective_dpi: f64) -> AutoDewarpResult {
    detect_curves_at_dpi_with_depth(source, effective_dpi, None)
}

pub fn detect_curves_at_dpi_with_depth(
    source: &GrayImage,
    effective_dpi: f64,
    fixed_depth: Option<f64>,
) -> AutoDewarpResult {
    if source.width() < 80 || source.height() < 80 {
        return no_model(0.0);
    }
    let scale = (WORKING_DPI / effective_dpi.max(1.0)).min(1.0);
    let target_width = ((source.width() as f64 * scale).round() as usize).max(1);
    let target_height = ((source.height() as f64 * scale).round() as usize).max(1);
    let working = source.downscale_to_fit(target_width, target_height);
    if working.width() < 80 || working.height() < 80 {
        return no_model(0.0);
    }

    let binary = threshold_local(
        &working,
        WOLF_RADIUS,
        LocalThreshold::Wolf {
            k: 0.34,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 24,
            hard_paper: 248,
        },
    );
    let Some((text, geometry)) = text_seed_and_geometry(&binary) else {
        return no_model(0.0);
    };
    if !has_text_component_distribution(&text, geometry.width) {
        return no_model(0.0);
    }

    let (bands, probability) = extract_text_bands(&working, &text, &geometry);
    let mut lines = trace_lines(&working, &bands, &probability, &geometry);
    lines.sort_by(|left, right| {
        left.mean_y
            .total_cmp(&right.mean_y)
            .then_with(|| left.points.len().cmp(&right.points.len()))
    });
    deduplicate_lines(&mut lines);

    let line_gate = (lines.len() as f64 / MIN_TRACED_LINES as f64).min(1.0);
    if lines.len() < MIN_TRACED_LINES {
        return no_model(line_gate * 0.35);
    }
    let mut lengths = lines.iter().map(|line| line.length).collect::<Vec<_>>();
    lengths.sort_by(f64::total_cmp);
    let median_length = lengths[lengths.len() / 2];
    let length_fraction = median_length / geometry.width.max(1.0);
    if length_fraction < MIN_MEDIAN_LENGTH_FRACTION {
        return no_model((line_gate * length_fraction).clamp(0.0, 1.0) * 0.5);
    }

    let identity_score = score_identity(&lines, &geometry);
    let Some((working_options, model_score)) = select_model(&lines, &geometry, fixed_depth) else {
        return no_model(0.0);
    };
    // Model straightness alone cannot tell whether select_model chose a narrow
    // pair of lines. Keep the guard in working-raster coordinates so every
    // component used to build the envelope is checked before publication.
    let plausible_components = plausible_text_components(&text, geometry.width);
    if !contains_text_components(&working_options, &plausible_components) {
        return no_model(0.0);
    }
    let absolute_improvement = identity_score - model_score;
    let relative_improvement = absolute_improvement / identity_score.max(1e-9);
    if identity_score <= MIN_ABSOLUTE_IMPROVEMENT
        || absolute_improvement < MIN_ABSOLUTE_IMPROVEMENT
        || relative_improvement < MIN_RELATIVE_IMPROVEMENT
    {
        return no_model(
            (relative_improvement.max(0.0) / MIN_RELATIVE_IMPROVEMENT).min(1.0) * 0.45,
        );
    }

    let scale_x = working.width() as f64 / source.width() as f64;
    let scale_y = working.height() as f64 / source.height() as f64;
    let options = DewarpOptions {
        top_curve: working_options
            .top_curve
            .iter()
            .map(|point| Point::new(point.x / scale_x, point.y / scale_y))
            .collect(),
        bottom_curve: working_options
            .bottom_curve
            .iter()
            .map(|point| Point::new(point.x / scale_x, point.y / scale_y))
            .collect(),
        depth: working_options.depth,
    };
    let model = validated_candidate(Some(options));
    let confidence = if model.is_some() {
        (line_gate * (length_fraction / 0.7).min(1.0) * (relative_improvement / 0.5).min(1.0))
            .clamp(0.0, 1.0)
    } else {
        0.0
    };
    AutoDewarpResult { model, confidence }
}

fn no_model(confidence: f64) -> AutoDewarpResult {
    AutoDewarpResult {
        model: None,
        confidence: confidence.clamp(0.0, 1.0),
    }
}

fn text_seed_and_geometry(binary: &BinaryImage) -> Option<(BinaryImage, ContentGeometry)> {
    let components = ComponentMap::from_binary(binary);
    let interior = components.retain(|component| {
        component.left > 0
            && component.top > 0
            && component.right + 1 < binary.width()
            && component.bottom + 1 < binary.height()
    });
    let marker = opening_rect(&interior, 2, 3).or(&opening_rect(&interior, 3, 2));
    let text = reconstruct_binary(&marker, &interior);
    if text.count_black() < 64 {
        return None;
    }

    let mut left_points = Vec::new();
    let mut right_points = Vec::new();
    for y in 0..text.height() {
        let first = (0..text.width()).find(|&x| text.get(x, y));
        let last = (0..text.width()).rev().find(|&x| text.get(x, y));
        if let (Some(left), Some(right)) = (first, last) {
            left_points.push(Point::new(left as f64, y as f64));
            right_points.push(Point::new(right as f64, y as f64));
        }
    }
    let left = robust_vertical_bound(&left_points)?;
    let right = robust_vertical_bound(&right_points)?;

    // Preserve the old envelope detector as a cheap sanity prior, but derive
    // it from explicit per-column extrema after border-component removal.
    let column_extrema = (0..text.width())
        .map(|x| {
            let first = (0..text.height()).find(|&y| text.get(x, y));
            let last = (0..text.height()).rev().find(|&y| text.get(x, y));
            first.zip(last)
        })
        .collect::<Vec<_>>();
    let samples = 17usize;
    let mut top = vec![f64::NAN; samples];
    let mut bottom = vec![f64::NAN; samples];
    let bin_width = text.width() as f64 / samples as f64;
    let mut valid = 0usize;
    for bin in 0..samples {
        let x0 = (bin as f64 * bin_width).floor() as usize;
        let x1 = (((bin + 1) as f64 * bin_width).ceil() as usize).min(text.width());
        let first = column_extrema[x0..x1]
            .iter()
            .filter_map(|extent| extent.map(|value| value.0))
            .min();
        let last = column_extrema[x0..x1]
            .iter()
            .filter_map(|extent| extent.map(|value| value.1))
            .max();
        if let (Some(first), Some(last)) = (first, last) {
            top[bin] = first as f64;
            bottom[bin] = last as f64;
            valid += 1;
        }
    }
    if valid < 12 {
        return None;
    }
    fill_missing_samples(&mut top);
    fill_missing_samples(&mut bottom);
    smooth_samples(&mut top);
    smooth_samples(&mut bottom);
    let top_y = top.iter().copied().fold(f64::INFINITY, f64::min);
    let bottom_y = bottom.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let middle_y = (top_y + bottom_y) * 0.5;
    let width = right.x_at(middle_y) - left.x_at(middle_y);
    if width < text.width() as f64 * 0.25 || bottom_y - top_y < text.height() as f64 * 0.15 {
        return None;
    }
    Some((
        text,
        ContentGeometry {
            left,
            right,
            top,
            bottom,
            top_y,
            bottom_y,
            width,
            raster_width: binary.width() as f64,
        },
    ))
}

fn opening_rect(source: &BinaryImage, kernel_width: usize, kernel_height: usize) -> BinaryImage {
    let mut eroded = BinaryImage::new(source.width(), source.height());
    let left = (kernel_width - 1) / 2;
    let top = (kernel_height - 1) / 2;
    for y in 0..source.height() {
        for x in 0..source.width() {
            let fits = x >= left
                && y >= top
                && x + kernel_width - left <= source.width()
                && y + kernel_height - top <= source.height()
                && (0..kernel_height)
                    .all(|ky| (0..kernel_width).all(|kx| source.get(x + kx - left, y + ky - top)));
            eroded.set(x, y, fits);
        }
    }
    let mut opened = BinaryImage::new(source.width(), source.height());
    for y in 0..source.height() {
        for x in 0..source.width() {
            if !eroded.get(x, y) {
                continue;
            }
            for ky in 0..kernel_height {
                for kx in 0..kernel_width {
                    let output_x = x as isize + kx as isize - left as isize;
                    let output_y = y as isize + ky as isize - top as isize;
                    if output_x >= 0
                        && output_y >= 0
                        && output_x < source.width() as isize
                        && output_y < source.height() as isize
                    {
                        opened.set(output_x as usize, output_y as usize, true);
                    }
                }
            }
        }
    }
    opened
}

fn robust_vertical_bound(points: &[Point]) -> Option<FittedBound> {
    if points.len() < 12 {
        return None;
    }
    let stride = (points.len() / 48).max(1);
    let sampled = points.iter().step_by(stride).copied().collect::<Vec<_>>();
    let angle_window = BOUND_ANGLE_WINDOW_DEGREES.to_radians().tan();
    let mut segments = Vec::new();
    for (left_index, left) in sampled.iter().enumerate() {
        for right in sampled.iter().skip(left_index + 1) {
            let dy = right.y - left.y;
            if dy.abs() < points.len() as f64 * 0.15 {
                continue;
            }
            let slope = (right.x - left.x) / dy;
            if slope.abs() <= angle_window * 2.0 {
                segments.push((slope, dy.abs()));
            }
        }
    }
    if segments.is_empty() {
        return None;
    }
    let mut best = (f64::NEG_INFINITY, 0.0f64);
    for &(candidate, _) in &segments {
        let score = segments
            .iter()
            .filter(|(slope, _)| (*slope - candidate).abs() <= angle_window)
            .map(|(_, length)| *length)
            .sum::<f64>();
        if score > best.0 || (score == best.0 && candidate.total_cmp(&best.1).is_lt()) {
            best = (score, candidate);
        }
    }
    let agreed = segments
        .iter()
        .filter(|(slope, _)| (*slope - best.1).abs() <= angle_window)
        .copied()
        .collect::<Vec<_>>();
    let total_weight = agreed.iter().map(|(_, weight)| weight).sum::<f64>();
    let slope = agreed
        .iter()
        .map(|(slope, weight)| slope * weight)
        .sum::<f64>()
        / total_weight.max(1.0);
    let mut intercepts = points
        .iter()
        .map(|point| point.x - slope * point.y)
        .collect::<Vec<_>>();
    intercepts.sort_by(f64::total_cmp);
    Some(FittedBound {
        x_per_y: slope,
        intercept: intercepts[intercepts.len() / 2],
    })
}

fn fill_missing_samples(samples: &mut [f64]) {
    for index in 0..samples.len() {
        if samples[index].is_finite() {
            continue;
        }
        let left = (0..index)
            .rev()
            .find(|&candidate| samples[candidate].is_finite());
        let right = (index + 1..samples.len()).find(|&candidate| samples[candidate].is_finite());
        samples[index] = match (left, right) {
            (Some(left), Some(right)) => {
                let amount = (index - left) as f64 / (right - left) as f64;
                samples[left] + (samples[right] - samples[left]) * amount
            }
            (Some(left), None) => samples[left],
            (None, Some(right)) => samples[right],
            (None, None) => 0.0,
        };
    }
}

fn smooth_samples(samples: &mut [f64]) {
    let original = samples.to_vec();
    for index in 2..samples.len() - 2 {
        samples[index] = (original[index - 2]
            + 2.0 * original[index - 1]
            + 3.0 * original[index]
            + 2.0 * original[index + 1]
            + original[index + 2])
            / 9.0;
    }
}

fn has_text_component_distribution(text: &BinaryImage, content_width: f64) -> bool {
    let components = ComponentMap::from_binary(text);
    let plausible = plausible_text_components(text, content_width);
    let mut row_centers = plausible
        .iter()
        .map(|component| (component.top + component.bottom) / 2)
        .collect::<Vec<_>>();
    row_centers.sort_unstable();
    let row_gap = (text.height() / 40).max(4);
    let mut row_count = 0usize;
    let mut previous_center = None;
    for center in row_centers {
        if previous_center.is_none_or(|previous| center.abs_diff(previous) >= row_gap) {
            row_count += 1;
            previous_center = Some(center);
        }
    }
    plausible.len() >= 20
        && row_count >= 2
        && plausible.len() * 2 >= components.components().len().min(plausible.len() * 3)
}

fn plausible_text_components(text: &BinaryImage, content_width: f64) -> Vec<Component> {
    let components = ComponentMap::from_binary(text);
    components
        .components()
        .iter()
        .filter(|component| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let aspect_ratio = width as f64 / height as f64;
            component.left > 0
                && component.top > 0
                && component.right + 1 < text.width()
                && component.bottom + 1 < text.height()
                && width >= 2
                && height >= 2
                && width as f64 <= content_width * 0.2
                && height <= text.height().max(1) / 8
                && component.area >= 6
                && (TEXT_COMPONENT_MIN_ASPECT_RATIO..=TEXT_COMPONENT_MAX_ASPECT_RATIO)
                    .contains(&aspect_ratio)
        })
        .cloned()
        .collect()
}

fn contains_text_components(model: &DewarpOptions, components: &[Component]) -> bool {
    let Some(top_first) = model.top_curve.first() else {
        return false;
    };
    let Some(top_last) = model.top_curve.last() else {
        return false;
    };
    let Some(bottom_first) = model.bottom_curve.first() else {
        return false;
    };
    let Some(bottom_last) = model.bottom_curve.last() else {
        return false;
    };
    let left = top_first.x.max(bottom_first.x);
    let right = top_last.x.min(bottom_last.x);
    if !left.is_finite() || !right.is_finite() || left >= right {
        return false;
    }
    // Directrices follow text-line centers. The component half-size accounts
    // for the glyph box on either side of that center, while the fixed slack
    // covers a few analysis pixels. Every retained component is checked.
    components.iter().all(|component| {
        let center_x = (component.left + component.right) as f64 * 0.5;
        let center_y = (component.top + component.bottom) as f64 * 0.5;
        let padding_x = (component.right - component.left + 1) as f64 * 0.5
            + MODEL_CONTAINMENT_HORIZONTAL_PADDING;
        let padding_y = (component.bottom - component.top + 1) as f64 * 0.5
            + MODEL_CONTAINMENT_VERTICAL_PADDING;
        if center_x < left - padding_x || center_x > right + padding_x {
            return false;
        }
        let top_y = sample_curve_y(&model.top_curve, center_x);
        let bottom_y = sample_curve_y(&model.bottom_curve, center_x);
        center_y >= top_y - padding_y && center_y <= bottom_y + padding_y
    })
}

fn sample_curve_y(curve: &[Point], x: f64) -> f64 {
    let first = curve[0];
    let last = *curve.last().unwrap();
    if x <= first.x {
        return first.y;
    }
    if x >= last.x {
        return last.y;
    }
    let pair = curve
        .windows(2)
        .find(|pair| pair[1].x >= x)
        .unwrap_or_else(|| curve.windows(2).next_back().unwrap());
    let amount = (x - pair[0].x) / (pair[1].x - pair[0].x).max(1e-9);
    pair[0].y + (pair[1].y - pair[0].y) * amount
}

fn extract_text_bands(
    source: &GrayImage,
    text: &BinaryImage,
    geometry: &ContentGeometry,
) -> (BinaryImage, Vec<f32>) {
    let width = source.width();
    let height = source.height();
    let darkness = source
        .data()
        .chunks(source.stride())
        .take(height)
        .flat_map(|row| {
            row[..width]
                .iter()
                .map(|value| f32::from(255 - *value) / 255.0)
        })
        .collect::<Vec<_>>();
    let bound_slope = (geometry.left.x_per_y + geometry.right.x_per_y) * 0.5;
    let normal_length = (1.0 + bound_slope * bound_slope).sqrt();
    let normal = (bound_slope / normal_length, 1.0 / normal_length);
    let tangent = (normal.1, -normal.0);
    let first = directional_sobel(&darkness, width, height, normal, tangent);
    let first = gaussian_blur_f32(&first, width, height, BAND_BLUR_SIGMA);
    let second = directional_derivative(&first, width, height, normal);
    let response = second
        .iter()
        .map(|value| (-*value).max(0.0))
        .collect::<Vec<_>>();
    let maximum = response.iter().copied().fold(0.0f32, f32::max);
    if maximum <= f32::EPSILON {
        return (BinaryImage::new(width, height), response);
    }
    let absolute_second = second.iter().map(|value| value.abs()).collect::<Vec<_>>();
    let blurred_obstacle = gaussian_blur_f32(&absolute_second, width, height, OBSTACLE_BLUR_SIGMA);
    let obstacle_values = blurred_obstacle
        .iter()
        .zip(&second)
        .map(|(blurred, value)| *blurred + 2.0 * (-*value).max(0.0))
        .collect::<Vec<_>>();
    let obstacle_threshold = obstacle_values.iter().copied().fold(0.0f32, f32::max) * 0.72;
    let mut core = BinaryImage::new(width, height);
    let mut obstacles = BinaryImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            core.set(x, y, response[index] >= maximum * BAND_THRESHOLD_FRACTION);
            obstacles.set(x, y, obstacle_values[index] > obstacle_threshold);
        }
    }
    let text_support = close(text, BAND_CLOSE_RADIUS, 3);
    core = core.and(&text_support);
    let closed = close(&core, BAND_CLOSE_RADIUS, BAND_CLOSE_RADIUS);
    let allowed = closed.and(&text_support).subtract(&obstacles);
    let bands = reconstruct_binary(&core.and(&allowed), &allowed);
    let probability = response
        .iter()
        .map(|value| (*value / maximum).clamp(0.0, 1.0))
        .collect();
    (bands, probability)
}

fn directional_sobel(
    source: &[f32],
    width: usize,
    height: usize,
    normal: (f64, f64),
    tangent: (f64, f64),
) -> Vec<f32> {
    let mut output = vec![0.0; source.len()];
    for y in 0..height {
        for x in 0..width {
            let point = (x as f64, y as f64);
            let mut derivative = 0.0;
            for (offset, weight) in [(-1.0, 1.0f32), (0.0, 2.0), (1.0, 1.0)] {
                let center_x = point.0 + tangent.0 * offset;
                let center_y = point.1 + tangent.1 * offset;
                let positive = sample_field(
                    source,
                    width,
                    height,
                    center_x + normal.0,
                    center_y + normal.1,
                );
                let negative = sample_field(
                    source,
                    width,
                    height,
                    center_x - normal.0,
                    center_y - normal.1,
                );
                derivative += (positive - negative) * weight;
            }
            output[y * width + x] = derivative * 0.125;
        }
    }
    output
}

fn directional_derivative(
    source: &[f32],
    width: usize,
    height: usize,
    direction: (f64, f64),
) -> Vec<f32> {
    let mut output = vec![0.0; source.len()];
    for y in 0..height {
        for x in 0..width {
            let positive = sample_field(
                source,
                width,
                height,
                x as f64 + direction.0,
                y as f64 + direction.1,
            );
            let negative = sample_field(
                source,
                width,
                height,
                x as f64 - direction.0,
                y as f64 - direction.1,
            );
            output[y * width + x] = (positive - negative) * 0.5;
        }
    }
    output
}

fn sample_field(source: &[f32], width: usize, height: usize, x: f64, y: f64) -> f32 {
    let x = x.clamp(0.0, width.saturating_sub(1) as f64);
    let y = y.clamp(0.0, height.saturating_sub(1) as f64);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let fx = (x - x0 as f64) as f32;
    let fy = (y - y0 as f64) as f32;
    let top = source[y0 * width + x0] * (1.0 - fx) + source[y0 * width + x1] * fx;
    let bottom = source[y1 * width + x0] * (1.0 - fx) + source[y1 * width + x1] * fx;
    top * (1.0 - fy) + bottom * fy
}

fn trace_lines(
    source: &GrayImage,
    bands: &BinaryImage,
    probability: &[f32],
    geometry: &ContentGeometry,
) -> Vec<TracedLine> {
    let outside = bands.invert();
    let distances = squared_euclidean_distance(&outside);
    let middle_y = (geometry.top_y + geometry.bottom_y) * 0.5;
    let middle_x = ((geometry.left.x_at(middle_y) + geometry.right.x_at(middle_y)) * 0.5)
        .round()
        .clamp(0.0, bands.width().saturating_sub(1) as f64) as usize;
    let profile = (0..bands.height())
        .map(|y| distances[y * bands.width() + middle_x])
        .collect::<Vec<_>>();
    let mut seeds = find_peaks(&profile, 1, bands.height())
        .into_iter()
        .map(|(_, y)| y)
        .filter(|&y| profile[y] >= 4 && bands.get(middle_x, y))
        .collect::<Vec<_>>();
    seeds.sort_by(|&left, &right| {
        profile[right]
            .cmp(&profile[left])
            .then_with(|| left.cmp(&right))
    });
    let mut selected = Vec::new();
    for seed in seeds {
        if selected
            .iter()
            .all(|existing: &usize| existing.abs_diff(seed) >= 10)
        {
            selected.push(seed);
        }
    }
    selected.sort_unstable();

    let darkness = source
        .data()
        .chunks(source.stride())
        .take(source.height())
        .flat_map(|row| {
            row[..source.width()]
                .iter()
                .map(|value| f32::from(255 - *value) / 255.0)
        })
        .collect::<Vec<_>>();
    let gradient_4 = gradient_magnitude(
        &gaussian_blur_f32(&darkness, source.width(), source.height(), 4.0),
        source.width(),
        source.height(),
    );
    let gradient_2 = gradient_magnitude(
        &gaussian_blur_f32(&darkness, source.width(), source.height(), 2.0),
        source.width(),
        source.height(),
    );

    selected
        .into_iter()
        .filter_map(|seed_y| {
            let left = trace_ridge(
                middle_x,
                seed_y,
                -1,
                bands,
                &distances,
                probability,
                geometry,
            );
            let mut right = trace_ridge(
                middle_x,
                seed_y,
                1,
                bands,
                &distances,
                probability,
                geometry,
            );
            let mut points = left;
            right.drain(..).skip(1).for_each(|point| points.push(point));
            if points.len() < 3 {
                return None;
            }
            let chord = distance(points[0], *points.last().unwrap());
            let left_gap = (points[0].x - geometry.left.x_at(points[0].y)).abs();
            let right_gap =
                (geometry.right.x_at(points.last().unwrap().y) - points.last().unwrap().x).abs();
            if chord <= 0.0 || left_gap + right_gap > chord * TRACE_ENDPOINT_GAP_FRACTION {
                return None;
            }
            let points = resample_polyline(&points, SNAKE_SPACING);
            let points = refine_snake(points, &gradient_4, source.width(), source.height(), 50);
            let points = refine_snake(points, &gradient_2, source.width(), source.height(), 50);
            if points.len() < 3 || has_mixed_significant_curvature(&points) {
                return None;
            }
            let length = polyline_length(&points);
            let mean_y = points.iter().map(|point| point.y).sum::<f64>() / points.len() as f64;
            Some(TracedLine {
                points,
                length,
                mean_y,
            })
        })
        .collect()
}

fn trace_ridge(
    start_x: usize,
    start_y: usize,
    direction: isize,
    bands: &BinaryImage,
    distances: &[u32],
    probability: &[f32],
    geometry: &ContentGeometry,
) -> Vec<Point> {
    let mut dense = vec![Point::new(start_x as f64, start_y as f64)];
    let mut x = start_x as isize;
    let mut y = start_y;
    let mut misses = 0usize;
    loop {
        let bound = if direction < 0 {
            geometry.left.x_at(y as f64)
        } else {
            geometry.right.x_at(y as f64)
        };
        if (direction < 0 && x as f64 <= bound) || (direction > 0 && x as f64 >= bound) {
            break;
        }
        let next_x = x + direction;
        if next_x < 0 || next_x >= bands.width() as isize {
            break;
        }
        let mut best = None::<(u32, u32, usize, usize)>;
        for candidate_y in y.saturating_sub(3)..=(y + 3).min(bands.height() - 1) {
            if !bands.get(next_x as usize, candidate_y) {
                continue;
            }
            let index = candidate_y * bands.width() + next_x as usize;
            let candidate = (
                distances[index],
                (probability[index] * 1_000_000.0).round() as u32,
                usize::MAX - candidate_y.abs_diff(y),
                usize::MAX - candidate_y,
            );
            if best.is_none_or(|current| candidate > current) {
                best = Some(candidate);
            }
        }
        x = next_x;
        if let Some((_, _, _, inverse_y)) = best {
            y = usize::MAX - inverse_y;
            misses = 0;
            dense.push(Point::new(x as f64, y as f64));
        } else {
            misses += 1;
            if misses > 4 {
                break;
            }
        }
    }
    if direction < 0 {
        dense.reverse();
    }
    let mut knots = vec![dense[0]];
    for &point in dense.iter().skip(1) {
        if distance(*knots.last().unwrap(), point) > MIN_KNOT_DISTANCE {
            knots.push(point);
        }
    }
    let last = *dense.last().unwrap();
    if distance(*knots.last().unwrap(), last) > 1.0 {
        knots.push(last);
    }
    knots
}

fn gradient_magnitude(source: &[f32], width: usize, height: usize) -> Vec<f32> {
    let mut output = vec![0.0; source.len()];
    let mut maximum = 0.0f32;
    for y in 0..height {
        for x in 0..width {
            let dx = sample_field(source, width, height, x as f64 + 1.0, y as f64)
                - sample_field(source, width, height, x as f64 - 1.0, y as f64);
            let dy = sample_field(source, width, height, x as f64, y as f64 + 1.0)
                - sample_field(source, width, height, x as f64, y as f64 - 1.0);
            let value = (dx * dx + dy * dy).sqrt();
            output[y * width + x] = value;
            maximum = maximum.max(value);
        }
    }
    if maximum > 0.0 {
        for value in &mut output {
            *value /= maximum;
        }
    }
    output
}

fn refine_snake(
    mut points: Vec<Point>,
    attraction: &[f32],
    width: usize,
    height: usize,
    iteration_limit: usize,
) -> Vec<Point> {
    if points.len() < 3 {
        return points;
    }
    let limit = iteration_limit.min(SNAKE_MAX_ITERATIONS);
    for _ in 0..limit {
        let previous = points.clone();
        let mut moved = false;
        for index in 1..points.len() - 1 {
            let tangent_x = previous[index + 1].x - previous[index - 1].x;
            let tangent_y = previous[index + 1].y - previous[index - 1].y;
            let tangent_length = (tangent_x * tangent_x + tangent_y * tangent_y)
                .sqrt()
                .max(1e-9);
            let normal = (-tangent_y / tangent_length, tangent_x / tangent_length);
            let mut best = (
                snake_energy(previous[index], index, &previous, attraction, width, height),
                0isize,
            );
            for offset in -SNAKE_RIB_HALF_LENGTH..=SNAKE_RIB_HALF_LENGTH {
                let candidate = Point::new(
                    (previous[index].x + normal.0 * offset as f64)
                        .clamp(0.0, width.saturating_sub(1) as f64),
                    (previous[index].y + normal.1 * offset as f64)
                        .clamp(0.0, height.saturating_sub(1) as f64),
                );
                let energy = snake_energy(candidate, index, &previous, attraction, width, height);
                if energy < best.0 - 1e-9
                    || ((energy - best.0).abs() <= 1e-9 && offset.abs() < best.1.abs())
                {
                    best = (energy, offset);
                }
            }
            if best.1 != 0 {
                points[index] = Point::new(
                    previous[index].x + normal.0 * best.1 as f64,
                    previous[index].y + normal.1 * best.1 as f64,
                );
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    points
}

fn snake_energy(
    point: Point,
    index: usize,
    points: &[Point],
    attraction: &[f32],
    width: usize,
    height: usize,
) -> f64 {
    let previous = points[index - 1];
    let next = points[index + 1];
    let elastic = ((distance(previous, point) - SNAKE_SPACING).powi(2)
        + (distance(point, next) - SNAKE_SPACING).powi(2))
        / SNAKE_SPACING.powi(2);
    let bend_x = previous.x - 2.0 * point.x + next.x;
    let bend_y = previous.y - 2.0 * point.y + next.y;
    let bending = (bend_x * bend_x + bend_y * bend_y) / SNAKE_SPACING.powi(2);
    let external = f64::from(sample_field(attraction, width, height, point.x, point.y));
    SNAKE_ELASTICITY * elastic + SNAKE_BENDING * bending - SNAKE_EXTERNAL * external
}

fn has_mixed_significant_curvature(points: &[Point]) -> bool {
    if points.len() < 7 {
        return false;
    }
    // Judge broad turns, not alternating pixel-scale ridge noise. Seven
    // arc-length anchors expose an S-shaped trace as persistent curvature of
    // both signs while a cylindrical/parabolic baseline keeps one sign.
    let anchors = (0..=6)
        .map(|index| sample_polyline(points, index as f64 / 6.0))
        .collect::<Vec<_>>();
    let mut positive = 0.0;
    let mut negative = 0.0;
    for triple in anchors.windows(3) {
        let left_dx = (triple[1].x - triple[0].x).max(1e-6);
        let right_dx = (triple[2].x - triple[1].x).max(1e-6);
        let curvature =
            (triple[2].y - triple[1].y) / right_dx - (triple[1].y - triple[0].y) / left_dx;
        if curvature > 0.002 {
            positive += curvature;
        } else if curvature < -0.002 {
            negative += -curvature;
        }
    }
    let total = positive + negative;
    positive > 0.08 && negative > 0.08 && positive.min(negative) / total.max(1e-9) > 0.35
}

fn sample_polyline(points: &[Point], fraction: f64) -> Point {
    let total = polyline_length(points);
    let target = total * fraction.clamp(0.0, 1.0);
    let mut traversed = 0.0;
    for pair in points.windows(2) {
        let segment = distance(pair[0], pair[1]);
        if traversed + segment >= target {
            let amount = if segment > 0.0 {
                (target - traversed) / segment
            } else {
                0.0
            };
            return Point::new(
                pair[0].x + (pair[1].x - pair[0].x) * amount,
                pair[0].y + (pair[1].y - pair[0].y) * amount,
            );
        }
        traversed += segment;
    }
    *points.last().unwrap()
}

fn deduplicate_lines(lines: &mut Vec<TracedLine>) {
    let mut retained = Vec::<TracedLine>::new();
    for line in lines.drain(..) {
        if retained
            .last()
            .is_none_or(|previous| (line.mean_y - previous.mean_y).abs() >= 8.0)
        {
            retained.push(line);
        } else if retained
            .last()
            .is_some_and(|previous| line.length > previous.length)
        {
            *retained.last_mut().unwrap() = line;
        }
    }
    *lines = retained;
}

fn select_model(
    lines: &[TracedLine],
    geometry: &ContentGeometry,
    fixed_depth: Option<f64>,
) -> Option<(DewarpOptions, f64)> {
    let count = lines.len();
    let mut pairs = BTreeSet::new();
    for top in 0..count.min(3) {
        for bottom in count.saturating_sub(3)..count {
            if top < bottom {
                pairs.insert((top, bottom));
            }
        }
    }
    for offset in 0..count.min(4) {
        let bottom = count - 1 - offset;
        if offset < bottom {
            pairs.insert((offset, bottom));
        }
    }

    let mut best_pair = None::<(usize, usize, f64)>;
    for (top_index, bottom_index) in pairs {
        let options = pair_options(&lines[top_index], &lines[bottom_index], geometry, 2.0);
        let Ok(model) = DewarpModel::from_options(&options) else {
            continue;
        };
        let score = score_model(&model, lines)?;
        if best_pair.is_none_or(|(_, _, best_score)| score < best_score) {
            best_pair = Some((top_index, bottom_index, score));
        }
    }
    let (top_index, bottom_index, _) = best_pair?;
    let mut best = None::<(DewarpOptions, f64)>;
    for depth in fixed_depth
        .into_iter()
        .chain(DEPTHS)
        .take(if fixed_depth.is_some() {
            1
        } else {
            DEPTHS.len()
        })
    {
        let options = pair_options(&lines[top_index], &lines[bottom_index], geometry, depth);
        let Ok(model) = DewarpModel::from_options(&options) else {
            continue;
        };
        let score = score_model(&model, lines)?;
        if best
            .as_ref()
            .is_none_or(|(_, best_score)| score < *best_score)
        {
            best = Some((options, score));
        }
    }
    best
}

fn pair_options(
    top_line: &TracedLine,
    bottom_line: &TracedLine,
    geometry: &ContentGeometry,
    depth: f64,
) -> DewarpOptions {
    let mut top_curve = expand_directrix(top_line, geometry, true);
    let mut bottom_curve = expand_directrix(bottom_line, geometry, false);
    let point_count = top_curve.len().min(bottom_curve.len());
    for index in 0..point_count {
        let minimum_separation = (geometry.bottom_y - geometry.top_y) * 0.08;
        if bottom_curve[index].y - top_curve[index].y < minimum_separation {
            let middle = (bottom_curve[index].y + top_curve[index].y) * 0.5;
            top_curve[index].y = middle - minimum_separation * 0.5;
            bottom_curve[index].y = middle + minimum_separation * 0.5;
        }
    }
    DewarpOptions {
        top_curve,
        bottom_curve,
        depth,
    }
}

fn expand_directrix(line: &TracedLine, geometry: &ContentGeometry, top: bool) -> Vec<Point> {
    let mut differences = line
        .points
        .iter()
        .map(|point| {
            if top {
                point.y - envelope_at(&geometry.top, point.x, geometry.raster_width)
            } else {
                envelope_at(&geometry.bottom, point.x, geometry.raster_width) - point.y
            }
        })
        .collect::<Vec<_>>();
    differences.sort_by(f64::total_cmp);
    let shift = differences[differences.len() / 2].max(0.0) * 0.9;
    let mut curve = line
        .points
        .iter()
        .map(|point| {
            let envelope_top = envelope_at(&geometry.top, point.x, geometry.raster_width);
            let envelope_bottom = envelope_at(&geometry.bottom, point.x, geometry.raster_width);
            Point::new(
                point.x,
                if top {
                    (point.y - shift).clamp(envelope_top, envelope_bottom)
                } else {
                    (point.y + shift).clamp(envelope_top, envelope_bottom)
                },
            )
        })
        .collect::<Vec<_>>();
    let first_y = curve[0].y;
    let last_y = curve.last().unwrap().y;
    curve[0].x = geometry.left.x_at(first_y);
    curve.last_mut().unwrap().x = geometry.right.x_at(last_y);
    curve.sort_by(|left, right| left.x.total_cmp(&right.x));
    curve.dedup_by(|left, right| (left.x - right.x).abs() < 1e-6);
    curve
}

fn envelope_at(samples: &[f64], x: f64, content_width: f64) -> f64 {
    let normalized = (x / content_width.max(1.0)).clamp(0.0, 1.0);
    let position = normalized * (samples.len() - 1) as f64;
    let left = position.floor() as usize;
    let right = (left + 1).min(samples.len() - 1);
    let amount = position - left as f64;
    samples[left] + (samples[right] - samples[left]) * amount
}

fn score_identity(lines: &[TracedLine], geometry: &ContentGeometry) -> f64 {
    let height = (geometry.bottom_y - geometry.top_y).max(1.0);
    lines
        .iter()
        .map(|line| {
            let normalized = line
                .points
                .iter()
                .map(|point| {
                    Point::new(
                        (point.x - geometry.left.x_at(point.y)) / geometry.width.max(1.0),
                        (point.y - geometry.top_y) / height,
                    )
                })
                .collect::<Vec<_>>();
            line_fit_score(&normalized)
        })
        .sum::<f64>()
        / lines.len() as f64
}

fn score_model(model: &DewarpModel, lines: &[TracedLine]) -> Option<f64> {
    let mut total = 0.0;
    for line in lines {
        let mapped = line
            .points
            .iter()
            .map(|&point| model.map_source_to_unit_approx(point))
            .collect::<Option<Vec<_>>>()?;
        total += line_fit_score(&mapped);
    }
    Some(total / lines.len() as f64)
}

fn line_fit_score(points: &[Point]) -> f64 {
    if points.len() < 2 {
        return f64::INFINITY;
    }
    let mean_x = points.iter().map(|point| point.x).sum::<f64>() / points.len() as f64;
    let mean_y = points.iter().map(|point| point.y).sum::<f64>() / points.len() as f64;
    let variance_x = points
        .iter()
        .map(|point| (point.x - mean_x).powi(2))
        .sum::<f64>();
    let covariance = points
        .iter()
        .map(|point| (point.x - mean_x) * (point.y - mean_y))
        .sum::<f64>();
    let slope = covariance / variance_x.max(1e-12);
    let intercept = mean_y - slope * mean_x;
    let residual = points
        .iter()
        .map(|point| (point.y - (slope * point.x + intercept)).abs())
        .sum::<f64>()
        / points.len() as f64;
    residual + SLOPE_PENALTY * slope.abs()
}

fn resample_polyline(points: &[Point], spacing: f64) -> Vec<Point> {
    let total = polyline_length(points);
    if total <= spacing || points.len() < 2 {
        return points.to_vec();
    }
    let segment_count = (total / spacing).round().max(2.0) as usize;
    let mut cumulative = vec![0.0];
    for pair in points.windows(2) {
        cumulative.push(cumulative.last().unwrap() + distance(pair[0], pair[1]));
    }
    (0..=segment_count)
        .map(|index| {
            let target = total * index as f64 / segment_count as f64;
            let segment = cumulative
                .partition_point(|value| *value < target)
                .clamp(1, points.len() - 1)
                - 1;
            let length = cumulative[segment + 1] - cumulative[segment];
            let amount = if length > 0.0 {
                (target - cumulative[segment]) / length
            } else {
                0.0
            };
            Point::new(
                points[segment].x + (points[segment + 1].x - points[segment].x) * amount,
                points[segment].y + (points[segment + 1].y - points[segment].y) * amount,
            )
        })
        .collect()
}

fn polyline_length(points: &[Point]) -> f64 {
    points
        .windows(2)
        .map(|pair| distance(pair[0], pair[1]))
        .sum()
}

fn distance(left: Point, right: Point) -> f64 {
    ((right.x - left.x).powi(2) + (right.y - left.y).powi(2)).sqrt()
}

fn validated_candidate(candidate: Option<DewarpOptions>) -> Option<DewarpOptions> {
    candidate.filter(|model| DewarpModel::from_options(model).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_page(curve_amplitude: f64, line_count: usize) -> GrayImage {
        text_page_with_columns(
            curve_amplitude,
            (0..line_count)
                .map(|_| (0, 14))
                .collect::<Vec<_>>()
                .as_slice(),
        )
    }

    fn text_page_with_columns(curve_amplitude: f64, columns: &[(usize, usize)]) -> GrayImage {
        let mut image = GrayImage::new(360, 300, 245);
        for (line, &(first_column, last_column)) in columns.iter().enumerate() {
            for column in first_column..last_column {
                let left = 38 + column * 21;
                let normalized = (left as f64 / 360.0 - 0.5) * 2.0;
                let top =
                    45 + line * 32 + (curve_amplitude * normalized * normalized).round() as usize;
                for y in top..top + 13 {
                    for x in left..left + 9 {
                        if x < left + 3 || y < top + 3 || y >= top + 10 {
                            image.set(x, y, 24);
                        }
                    }
                }
            }
        }
        image
    }

    fn curled_harness_page() -> GrayImage {
        let amplitude = 34.0;
        let baselines = [190.0, 260.0, 330.0, 400.0, 470.0, 540.0, 610.0, 680.0];
        let mut image = GrayImage::new(720, 960, 241);
        for (line, baseline) in baselines.into_iter().enumerate() {
            for column in 0..18 {
                let left = 105 + column * 29;
                let normalized = (left as f64 - 360.0) / 360.0;
                let top = (baseline + amplitude * normalized * normalized).round() as usize;
                let ink = if line % 2 == 0 { 65 } else { 73 };
                for y in top..top + 15 {
                    for x in left..left + 3 {
                        image.set(x, y, ink);
                    }
                }
                for y in top..top + 3 {
                    for x in left..left + 10 {
                        image.set(x, y, ink);
                    }
                }
                for y in top + 7..top + 9 {
                    for x in left..left + 8 {
                        image.set(x, y, ink);
                    }
                }
            }
        }
        image
    }

    #[test]
    fn reports_deterministic_valid_model_for_curved_text_lines() {
        let image = text_page(20.0, 7);
        let first = detect_curves_at_dpi(&image, 200.0);
        let second = detect_curves_at_dpi(&image, 200.0);
        assert!(first.model.is_some(), "confidence={}", first.confidence);
        assert!(DewarpModel::from_options(first.model.as_ref().unwrap()).is_ok());
        assert_eq!(first.confidence, second.confidence);
        assert_eq!(
            first.model.unwrap().top_curve,
            second.model.unwrap().top_curve
        );
    }

    #[test]
    fn accepts_the_curled_harness_fixture() {
        let result = detect_curves_at_dpi(&curled_harness_page(), 200.0);
        assert!(result.model.is_some(), "confidence={}", result.confidence);
    }

    #[test]
    fn fixed_depth_is_respected_by_the_automatic_model_builder() {
        let image = text_page(20.0, 7);
        let result = detect_curves_at_dpi_with_depth(&image, 200.0, Some(0.75));
        assert_eq!(
            result.model.as_ref().map(|model| model.depth),
            Some(0.75),
            "confidence={}",
            result.confidence
        );
    }

    #[test]
    fn confidence_gating_rejects_flat_and_sparse_pages() {
        assert!(detect_curves_at_dpi(&text_page(0.0, 7), 200.0)
            .model
            .is_none());
        assert!(detect_curves_at_dpi(&text_page(20.0, 3), 200.0)
            .model
            .is_none());
    }

    #[test]
    fn silently_discards_invalid_automatic_candidate() {
        let invalid = DewarpOptions {
            top_curve: vec![Point::new(0.0, 0.0), Point::new(100.0, 100.0)],
            bottom_curve: vec![Point::new(0.0, 100.0), Point::new(100.0, 0.0)],
            depth: 2.0,
        };
        assert!(validated_candidate(Some(invalid)).is_none());
    }

    #[test]
    fn rejects_only_broad_curvature_with_both_signs() {
        let parabola = (0..=12)
            .map(|index| {
                let x = index as f64 * 20.0;
                Point::new(x, 0.0015 * (x - 120.0).powi(2))
            })
            .collect::<Vec<_>>();
        let s_curve = (0..=12)
            .map(|index| {
                let x = index as f64 * 20.0;
                let centered = (x - 120.0) / 120.0;
                Point::new(x, 45.0 * centered.powi(3))
            })
            .collect::<Vec<_>>();
        assert!(!has_mixed_significant_curvature(&parabola));
        assert!(has_mixed_significant_curvature(&s_curve));
    }

    fn threshold_text_seed(image: &GrayImage) -> (BinaryImage, ContentGeometry) {
        let binary = threshold_local(
            image,
            WOLF_RADIUS,
            LocalThreshold::Wolf {
                k: 0.34,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 24,
                hard_paper: 248,
            },
        );
        text_seed_and_geometry(&binary).expect("generated page should expose text geometry")
    }

    fn draw_outline_glyph(image: &mut GrayImage, left: usize, top: usize) {
        for y in top..top + 13 {
            for x in left..left + 9 {
                if x < left + 3 || y < top + 3 || y >= top + 10 {
                    image.set(x, y, 24);
                }
            }
        }
    }

    fn draw_outline_component(image: &mut BinaryImage, left: usize, top: usize) {
        for y in top..top + 13 {
            for x in left..left + 9 {
                if x < left + 3 || y < top + 3 || y >= top + 10 {
                    image.set(x, y, true);
                }
            }
        }
    }

    #[test]
    fn containment_guard_rejects_a_narrow_model_with_outside_text() {
        let image = text_page(20.0, 7);
        let (text, geometry) = threshold_text_seed(&image);
        let (bands, probability) = extract_text_bands(&image, &text, &geometry);
        let mut lines = trace_lines(&image, &bands, &probability, &geometry);
        deduplicate_lines(&mut lines);
        lines.sort_by(|left, right| left.mean_y.total_cmp(&right.mean_y));
        let (model, _) = select_model(&lines, &geometry, None).expect("model should be selected");
        let components = plausible_text_components(&text, geometry.width);
        assert!(contains_text_components(&model, &components));

        let mut with_marginal_note = components.clone();
        with_marginal_note.push(Component {
            label: u32::MAX - 1,
            area: 75,
            left: 305,
            top: 230,
            right: 313,
            bottom: 242,
        });
        assert!(contains_text_components(&model, &with_marginal_note));

        let mut with_outside_note = components;
        with_outside_note.push(Component {
            label: u32::MAX,
            area: 75,
            left: 336,
            top: 150,
            right: 344,
            bottom: 162,
        });
        assert!(!contains_text_components(&model, &with_outside_note));
    }

    #[test]
    fn outside_text_uses_the_no_model_fallback() {
        let mut image = text_page(20.0, 7);
        draw_outline_glyph(&mut image, 336, 150);
        let result = detect_curves_at_dpi(&image, 200.0);
        assert!(result.model.is_none(), "confidence={}", result.confidence);
    }

    #[test]
    fn text_component_filter_keeps_marginal_text_and_ignores_edge_shadow() {
        let image = text_page(20.0, 7);
        let (text, geometry) = threshold_text_seed(&image);
        let mut augmented = text.clone();
        draw_outline_component(&mut augmented, 326, 220);
        for y in 100..230 {
            for x in 4..25 {
                augmented.set(x, y, true);
            }
        }

        let components = plausible_text_components(&augmented, geometry.width);
        assert!(components
            .iter()
            .any(|component| component.left == 326 && component.top == 220));
        assert!(!components.iter().any(|component| {
            component.left == 4
                && component.top == 100
                && component.right == 24
                && component.bottom == 229
        }));
    }

    #[test]
    fn edge_shadow_does_not_reject_a_curved_text_page() {
        let mut image = text_page(20.0, 7);
        for y in 0..image.height() {
            for x in 0..24 {
                image.set(x, y, 160);
            }
        }
        let result = detect_curves_at_dpi(&image, 200.0);
        assert!(result.model.is_some(), "confidence={}", result.confidence);
    }
}
