use crate::{
    background::{normalize_illumination, smooth_for_binarization},
    calibration::{CalibrationConfig, PageCalibration},
    BinarizationMode, CleanupOptions, DespeckleLevel,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::dilate,
    threshold::{
        otsu_threshold, otsu_threshold_excluding, threshold_global, threshold_global_biased,
        threshold_local, threshold_local_biased, threshold_local_biased_excluding,
        threshold_local_biased_with_integrals_for_consensus,
        threshold_local_multiscale_biased_excluding_with_integrals_for_consensus, IntegralImages,
        LocalThreshold, MaskedIntegralImages,
    },
    BinaryImage, ComponentMap, GrayImage,
};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::OnceLock, time::Instant};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct BinarizationStageTimings {
    pub preparation_ms: f64,
    pub thresholding_ms: f64,
    pub postprocess_ms: f64,
}

// Corpus calibration keeps Wolf below the 0.3 reference setting: 0.3 erased
// the Stage-B thin-stroke golden, while 0.2 retained it without adding noise.
const WOLF_K: f64 = 0.20;
const SAUVOLA_K: f64 = 0.34;
const WOLF_MINIMUM_PERCENTILE: f64 = 0.01;
const WOLF_HARD_INK: u8 = 48;
const WOLF_HARD_PAPER: u8 = 248;
const STROKE_EDGE_THRESHOLD: u16 = 24;

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
    clean_black_and_white_with_calibration_config(source, options, CalibrationConfig::default())
}

#[doc(hidden)]
pub fn clean_black_and_white_with_calibration_config(
    source: &GrayImage,
    options: &CleanupOptions,
    calibration_config: CalibrationConfig,
) -> BwResult {
    let normalized = if options.normalize_illumination {
        normalize_illumination(source, options.dpi)
    } else {
        source.clone()
    };
    let calibration = PageCalibration::estimate(&normalized, options.dpi, calibration_config);
    let (binary, mode) = binarize_normalized_calibrated(&normalized, options, calibration);
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
    let calibration =
        PageCalibration::estimate(normalized, options.dpi, CalibrationConfig::default());
    binarize_normalized_calibrated(normalized, options, calibration)
}

fn binarize_normalized_calibrated(
    normalized: &GrayImage,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> (BinaryImage, BinarizationMode) {
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(&threshold_input, options);
    let mode = diagnostics.route;
    (
        binarize_with_mode(&threshold_input, normalized, options, mode, calibration),
        mode,
    )
}

pub(crate) fn binarize_normalized_with_diagnostics(
    normalized: &GrayImage,
    routing_sample: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> (
    BinaryImage,
    BinarizationDiagnostics,
    bool,
    BinarizationStageTimings,
) {
    let mut timings = BinarizationStageTimings::default();
    let preparation_started = Instant::now();
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(routing_sample, options);
    timings.preparation_ms += preparation_started.elapsed().as_secs_f64() * 1_000.0;
    let thresholding_started = Instant::now();
    let binary = threshold_with_mode(
        &threshold_input,
        normalized,
        global_threshold_source,
        options,
        diagnostics.route,
        calibration,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback) =
        postprocess_binary_with_diagnostics(&binary, Some(normalized), options, calibration);
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (binary, diagnostics, despeckle_fallback, timings)
}

/// Mixed-mode binarization with picture pixels omitted from threshold
/// statistics and held white through despeckling and morphological smoothing.
pub(crate) fn binarize_normalized_with_diagnostics_excluding(
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: &BinaryImage,
) -> (
    BinaryImage,
    BinarizationDiagnostics,
    bool,
    BinarizationStageTimings,
) {
    let mut timings = BinarizationStageTimings::default();
    let preparation_started = Instant::now();
    assert_eq!(
        (normalized.width(), normalized.height()),
        (picture_mask.width(), picture_mask.height())
    );
    if let Some(source) = global_threshold_source {
        assert_eq!(
            (normalized.width(), normalized.height()),
            (source.width(), source.height())
        );
    }
    let protection_radius = picture_protection_radius(options.dpi);
    let protected_picture_mask = dilate(picture_mask, protection_radius, protection_radius);
    let mut masked_input = normalized.clone();
    let masked_width = masked_input.width();
    masked_input
        .data_mut()
        .par_chunks_mut(masked_width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, value) in row.iter_mut().enumerate() {
                if protected_picture_mask.get(x, y) {
                    *value = 255;
                }
            }
        });
    let threshold_input = smooth_for_binarization(&masked_input, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(&masked_input, options);
    timings.preparation_ms += preparation_started.elapsed().as_secs_f64() * 1_000.0;
    let thresholding_started = Instant::now();
    let binary = threshold_with_mode_excluding(
        &threshold_input,
        normalized,
        global_threshold_source,
        options,
        diagnostics.route,
        calibration,
        &protected_picture_mask,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback) =
        postprocess_binary_with_diagnostics(&binary, Some(normalized), options, calibration);
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (
        binary.subtract(&protected_picture_mask),
        diagnostics,
        despeckle_fallback,
        timings,
    )
}

pub(crate) fn picture_protection_radius(dpi: f64) -> usize {
    (dpi * 0.35 / 25.4).round().clamp(1.0, 12.0) as usize
}

fn binarize_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
) -> BinaryImage {
    let binary = threshold_with_mode(
        threshold_input,
        normalized,
        None,
        options,
        mode,
        calibration,
    );
    postprocess_binary(&binary, Some(normalized), options, calibration)
}

fn threshold_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
) -> BinaryImage {
    let radius = calibration.threshold_radius(options.dpi);
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            threshold_global_biased(source, paper_ink_midpoint_threshold(source, None), bias)
        }
        BinarizationMode::Sauvola => threshold_local_for_route(
            threshold_input,
            normalized,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
            calibration,
            options.dpi,
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_for_route(
            threshold_input,
            normalized,
            radius,
            LocalThreshold::Wolf {
                k: WOLF_K,
                deviation_floor: 2.0,
                minimum_percentile: WOLF_MINIMUM_PERCENTILE,
                hard_ink: WOLF_HARD_INK,
                hard_paper: WOLF_HARD_PAPER,
            },
            bias,
            calibration,
            options.dpi,
        ),
    }
}

fn threshold_with_mode_excluding(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    picture_mask: &BinaryImage,
) -> BinaryImage {
    let radius = calibration.threshold_radius(options.dpi);
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            threshold_global_biased(
                source,
                paper_ink_midpoint_threshold(source, Some(picture_mask)),
                bias,
            )
            .subtract(picture_mask)
        }
        BinarizationMode::Sauvola => threshold_local_for_route_excluding(
            threshold_input,
            normalized,
            picture_mask,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
            calibration,
            options.dpi,
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_for_route_excluding(
            threshold_input,
            normalized,
            picture_mask,
            radius,
            LocalThreshold::Wolf {
                k: WOLF_K,
                deviation_floor: 2.0,
                minimum_percentile: WOLF_MINIMUM_PERCENTILE,
                hard_ink: WOLF_HARD_INK,
                hard_paper: WOLF_HARD_PAPER,
            },
            bias,
            calibration,
            options.dpi,
        ),
    }
}

fn paper_ink_midpoint_threshold(image: &GrayImage, exclusion: Option<&BinaryImage>) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for x in 0..image.width() {
            if exclusion.is_some_and(|mask| mask.get(x, y)) {
                continue;
            }
            histogram[image.get(x, y) as usize] += 1;
        }
    }
    let total = histogram.iter().sum::<usize>();
    if total == 0 {
        return 127;
    }
    let otsu = exclusion.map_or_else(
        || otsu_threshold(image),
        |mask| otsu_threshold_excluding(image, mask),
    );
    let dark_count = histogram[..=otsu as usize].iter().sum::<usize>();
    if dark_count < 16 {
        return otsu;
    }
    let percentile = |rank: usize| {
        let mut cumulative = 0usize;
        histogram
            .iter()
            .position(|frequency| {
                cumulative += *frequency;
                cumulative > rank
            })
            .unwrap_or(255) as u8
    };
    // On clean uniform paper, the Otsu boundary is sensitive to how many
    // antialiased edge pixels happen to be present. Anchor the destructive
    // threshold at the physical paper/ink endpoints instead: a low quantile
    // of the Otsu-dark class estimates the ink core, while the page's 70th
    // percentile estimates its dominant paper. Their midpoint preserves the
    // 50% glyph boundary across paper shades and tints.
    let ink_core = percentile(dark_count.saturating_sub(1) / 10);
    let paper = percentile(total.saturating_sub(1) * 7 / 10);
    if paper <= ink_core.saturating_add(8) {
        otsu
    } else {
        ((u16::from(ink_core) + u16::from(paper)) / 2) as u8
    }
}

#[allow(clippy::too_many_arguments)]
fn threshold_local_for_route_excluding(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    picture_mask: &BinaryImage,
    legacy_radius: usize,
    method: LocalThreshold,
    bias: i16,
    calibration: PageCalibration,
    raster_dpi: f64,
) -> BinaryImage {
    if !calibration.config.multiscale_local_threshold {
        return threshold_local_biased_excluding(
            threshold_input,
            picture_mask,
            legacy_radius,
            method,
            bias,
        );
    }
    let integrals = MaskedIntegralImages::new(threshold_input, picture_mask);
    let [small_radius, medium_radius, large_radius] =
        calibration.multiscale_threshold_radii(raster_dpi);
    threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
        threshold_input,
        picture_mask,
        &integrals,
        [small_radius, medium_radius, large_radius],
        method,
        bias,
        |x, y| sobel_gradient_magnitude(normalized, x, y) > STROKE_EDGE_THRESHOLD,
    )
}

fn threshold_local_for_route(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    legacy_radius: usize,
    method: LocalThreshold,
    bias: i16,
    calibration: PageCalibration,
    raster_dpi: f64,
) -> BinaryImage {
    if !calibration.config.multiscale_local_threshold {
        return threshold_local_biased(threshold_input, legacy_radius, method, bias);
    }

    let integrals = IntegralImages::new(threshold_input);
    let [small_radius, medium_radius, large_radius] =
        calibration.multiscale_threshold_radii(raster_dpi);
    let small = threshold_local_biased_with_integrals_for_consensus(
        threshold_input,
        &integrals,
        small_radius,
        method,
        bias,
    );
    let medium = threshold_local_biased_with_integrals_for_consensus(
        threshold_input,
        &integrals,
        medium_radius,
        method,
        bias,
    );
    let large = threshold_local_biased_with_integrals_for_consensus(
        threshold_input,
        &integrals,
        large_radius,
        method,
        bias,
    );
    multiscale_consensus(normalized, &small, &medium, &large)
}

fn multiscale_consensus(
    normalized: &GrayImage,
    small: &BinaryImage,
    medium: &BinaryImage,
    large: &BinaryImage,
) -> BinaryImage {
    assert_eq!(
        (small.width(), small.height()),
        (normalized.width(), normalized.height())
    );
    assert_eq!(medium.width(), small.width());
    assert_eq!(medium.height(), small.height());
    assert_eq!(large.width(), small.width());
    assert_eq!(large.height(), small.height());

    BinaryImage::from_fn_parallel(small.width(), small.height(), |x, y| {
        (medium.get(x, y) && large.get(x, y))
            || (small.get(x, y)
                && sobel_gradient_magnitude(normalized, x, y) > STROKE_EDGE_THRESHOLD)
    })
}

fn sobel_gradient_magnitude(image: &GrayImage, x: usize, y: usize) -> u16 {
    if image.width() == 0 || image.height() == 0 {
        return 0;
    }
    let left = x.saturating_sub(1);
    let right = x.saturating_add(1).min(image.width() - 1);
    let top = y.saturating_sub(1);
    let bottom = y.saturating_add(1).min(image.height() - 1);
    let top_left = i32::from(image.get(left, top));
    let top_center = i32::from(image.get(x, top));
    let top_right = i32::from(image.get(right, top));
    let center_left = i32::from(image.get(left, y));
    let center_right = i32::from(image.get(right, y));
    let bottom_left = i32::from(image.get(left, bottom));
    let bottom_center = i32::from(image.get(x, bottom));
    let bottom_right = i32::from(image.get(right, bottom));
    let gradient_x =
        -top_left + top_right - 2 * center_left + 2 * center_right - bottom_left + bottom_right;
    let gradient_y =
        -top_left - 2 * top_center - top_right + bottom_left + 2 * bottom_center + bottom_right;

    ((gradient_x.unsigned_abs() + gradient_y.unsigned_abs() + 2) / 4).min(u32::from(u16::MAX))
        as u16
}

pub(crate) fn postprocess_binary(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> BinaryImage {
    postprocess_binary_with_diagnostics(binary, normalized, options, calibration).0
}

pub(crate) fn postprocess_binary_with_diagnostics(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> (BinaryImage, bool) {
    let level = options.effective_despeckle_level();
    let (despeckled, despeckle_fallback) = if level != DespeckleLevel::Off {
        let outcome =
            despeckle_connected_impl(binary, normalized, options.dpi, calibration, level, true);
        (outcome.image, outcome.fallback)
    } else {
        (binary.clone(), false)
    };
    (
        smooth_edges_for_page(&despeckled, options.dpi),
        despeckle_fallback,
    )
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
        && dark_border_coverage <= 0.08
        && otsu_adaptive_agreement >= 0.975
        && (robust_contrast >= 64.0 || edge_density <= 0.18);
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
    // Run lengths live in 1..=32, so a fixed histogram replaces collecting
    // and sorting millions of runs; rows accumulate independently.
    let (histogram, total) = (0..binary.height())
        .into_par_iter()
        .map(|y| {
            let mut local = [0usize; 33];
            let mut count = 0usize;
            let mut start = None;
            for x in 0..=binary.width() {
                let black = x < binary.width() && binary.get(x, y);
                match (start, black) {
                    (None, true) => start = Some(x),
                    (Some(run_start), false) => {
                        let length = x - run_start;
                        if length <= 32 {
                            local[length] += 1;
                            count += 1;
                        }
                        start = None;
                    }
                    _ => {}
                }
            }
            (local, count)
        })
        .reduce(
            || ([0usize; 33], 0usize),
            |(mut left, left_count), (right, right_count)| {
                for (target, value) in left.iter_mut().zip(right) {
                    *target += value;
                }
                (left, left_count + right_count)
            },
        );
    if total == 0 {
        return 0.0;
    }
    let mut cumulative = 0usize;
    for (length, &count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative > total / 2 {
            return length as f64;
        }
    }
    0.0
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

fn resolve_smooth_profile(source: &BinaryImage, _dpi: f64) -> SmoothProfile {
    let stroke_width = estimated_stroke_width(source);
    if (1.0..=12.0).contains(&stroke_width) {
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
    BinaryImage::from_fn_parallel(source.width(), source.height(), |x, y| {
        if x == 0 || y == 0 || x + 1 == source.width() || y + 1 == source.height() {
            return source.get(x, y);
        }
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
        let neighbor_count = cardinal_count + diagonals.into_iter().filter(|value| *value).count();
        let center = source.get(x, y);
        if !center {
            neighbor_count >= 5 && ((north && south) || (west && east))
        } else {
            neighbor_count > 1
        }
    })
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
    BinaryImage::from_fn_parallel(source.width(), source.height(), |x, y| {
        if x == 0 || y == 0 || x + 1 == source.width() || y + 1 == source.height() {
            return source.get(x, y);
        }
        let mut pattern = 0usize;
        for offset_y in 0..3 {
            for offset_x in 0..3 {
                if source.get(x + offset_x - 1, y + offset_y - 1) {
                    pattern |= 1 << (offset_y * 3 + offset_x);
                }
            }
        }
        lut[pattern]
    })
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
    despeckle_connected_with_calibration_config(source, dpi, CalibrationConfig::default())
}

#[doc(hidden)]
pub fn despeckle_connected_with_calibration_config(
    source: &BinaryImage,
    dpi: f64,
    calibration_config: CalibrationConfig,
) -> BinaryImage {
    let calibration = PageCalibration::estimate_from_binary(source, dpi, calibration_config);
    despeckle_connected_impl(source, None, dpi, calibration, DespeckleLevel::Normal, true).image
}

pub(crate) fn despeckle_connected_calibrated(
    source: &BinaryImage,
    dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    let outcome =
        despeckle_connected_impl(source, None, dpi, calibration, DespeckleLevel::Normal, true);
    // Content-box preprocessing has no grayscale evidence and treats an all-small
    // page as potential marginalia/photo structure. Keep its historical fail-open
    // behavior; output despeckling still uses the required top-decile anchors.
    if outcome.fallback {
        source.clone()
    } else {
        outcome.image
    }
}

struct DespeckleOutcome {
    image: BinaryImage,
    fallback: bool,
}

fn despeckle_connected_impl(
    source: &BinaryImage,
    normalized: Option<&GrayImage>,
    dpi: f64,
    calibration: PageCalibration,
    level: DespeckleLevel,
    use_attachment_graph: bool,
) -> DespeckleOutcome {
    let components = ComponentMap::from_binary(source);
    if components.components().is_empty() || level == DespeckleLevel::Off {
        return DespeckleOutcome {
            image: source.clone(),
            fallback: false,
        };
    }
    let component_radii = component_maximum_inscribed_radius_squared(source, &components);
    let pixel_count = source.width().saturating_mul(source.height()).max(1);
    let calibration = PageCalibration::estimate_from_components(
        components.components(),
        &component_radii,
        source.count_black() as f64 / pixel_count as f64,
        dpi,
        calibration.config,
    );
    let mut graph = vec![Vec::<AttachmentEdge>::new(); components.components().len() + 1];
    if use_attachment_graph {
        populate_attachment_graph(components.components(), &mut graph);
    }
    let (mut keep, fallback) = despeckle_keep_decision(
        components.components(),
        &component_radii,
        &graph,
        dpi,
        calibration,
        level,
        use_attachment_graph,
    );
    if let Some(gray) =
        normalized.filter(|gray| gray.width() == source.width() && gray.height() == source.height())
    {
        let more_cautious = match level {
            DespeckleLevel::Aggressive => Some(DespeckleLevel::Normal),
            DespeckleLevel::Normal => Some(DespeckleLevel::Cautious),
            DespeckleLevel::Cautious | DespeckleLevel::Off => None,
        };
        let cautious_keep = more_cautious.map(|cautious_level| {
            despeckle_keep_decision(
                components.components(),
                &component_radii,
                &graph,
                dpi,
                calibration,
                cautious_level,
                use_attachment_graph,
            )
            .0
        });
        protect_high_contrast_components(&components, gray, cautious_keep.as_deref(), &mut keep);
    }
    DespeckleOutcome {
        image: components.retain(|component| keep[component.label as usize]),
        fallback,
    }
}

#[derive(Clone, Copy, Debug)]
struct AttachmentEdge {
    neighbor: usize,
    distance_squared: u64,
}

fn despeckle_keep_decision(
    components: &[scan_primitives::Component],
    component_radii: &[u32],
    graph: &[Vec<AttachmentEdge>],
    dpi: f64,
    calibration: PageCalibration,
    requested_level: DespeckleLevel,
    use_attachment_graph: bool,
) -> (Vec<bool>, bool) {
    let (substantial_area, minimum_radius_squared) =
        despeckle_seed_thresholds(calibration, dpi, requested_level);
    let mut seeds = vec![false; components.len() + 1];
    for component in components {
        let label = component.label as usize;
        seeds[label] =
            component.area >= substantial_area && component_radii[label] >= minimum_radius_squared;
    }
    let fallback = !seeds.iter().any(|&seed| seed);
    let level = if fallback {
        let mut areas = components
            .iter()
            .map(|component| component.area)
            .collect::<Vec<_>>();
        areas.sort_unstable();
        let top_decile = areas[(areas.len() * 9) / 10];
        for component in components {
            seeds[component.label as usize] = component.area >= top_decile;
        }
        DespeckleLevel::Cautious
    } else {
        requested_level
    };
    let parameters = DespeckleParameters::for_level(level, dpi);
    let mut keep = seeds.clone();
    if use_attachment_graph {
        let mut hops = vec![u8::MAX; keep.len()];
        let mut queue = VecDeque::new();
        for component in components {
            let label = component.label as usize;
            if seeds[label] {
                hops[label] = 0;
                queue.push_back(label);
            }
        }
        while let Some(label) = queue.pop_front() {
            if hops[label] >= parameters.maximum_hops {
                continue;
            }
            let parent = &components[label - 1];
            for edge in &graph[label] {
                let candidate = &components[edge.neighbor - 1];
                if seeds[edge.neighbor]
                    || (parent.area as f64) < candidate.area as f64 * parameters.parent_area_ratio
                    || edge.distance_squared
                        > (candidate.area as f64 * parameters.distance_factor).round() as u64
                {
                    continue;
                }
                let next_hops = hops[label] + 1;
                if next_hops >= hops[edge.neighbor] {
                    continue;
                }
                hops[edge.neighbor] = next_hops;
                keep[edge.neighbor] = true;
                queue.push_back(edge.neighbor);
            }
        }
        protect_line_supported_marks(components, &seeds, dpi, &mut keep);
    }
    (keep, fallback)
}

#[derive(Clone, Copy)]
struct DespeckleParameters {
    distance_factor: f64,
    parent_area_ratio: f64,
    maximum_hops: u8,
    seed_stroke_area_factor: f64,
}

impl DespeckleParameters {
    fn for_level(level: DespeckleLevel, dpi: f64) -> Self {
        let dpi_factor = (dpi / 300.0).clamp(0.5, 4.0);
        match level {
            DespeckleLevel::Off | DespeckleLevel::Cautious => Self {
                distance_factor: 100.0,
                parent_area_ratio: 0.125 * dpi_factor,
                maximum_hops: 5,
                seed_stroke_area_factor: 0.35,
            },
            DespeckleLevel::Normal => Self {
                distance_factor: 42.0,
                parent_area_ratio: 0.175 * dpi_factor,
                maximum_hops: 3,
                seed_stroke_area_factor: 0.5,
            },
            DespeckleLevel::Aggressive => Self {
                distance_factor: 12.0,
                parent_area_ratio: 0.225 * dpi_factor,
                maximum_hops: 3,
                seed_stroke_area_factor: 0.75,
            },
        }
    }
}

fn despeckle_seed_thresholds(
    calibration: PageCalibration,
    dpi: f64,
    level: DespeckleLevel,
) -> (usize, u32) {
    let scale = (dpi / 300.0).clamp(0.5, 4.0);
    if calibration.config.despeckle_substantial_area && calibration.valid {
        let stroke_width = calibration.stroke_width_px * dpi.max(1.0) / calibration.effective_dpi;
        let area = (DespeckleParameters::for_level(level, dpi).seed_stroke_area_factor
            * stroke_width.powi(2))
        .round()
        .max(16.0) as usize;
        let minimum_radius_squared = (stroke_width * 0.5).powi(2).round().max(1.0) as u32;
        (area, minimum_radius_squared)
    } else {
        (
            calibration.despeckle_substantial_area(dpi),
            scale.powi(2).ceil().max(1.0) as u32,
        )
    }
}

fn component_maximum_inscribed_radius_squared(
    source: &BinaryImage,
    components: &ComponentMap,
) -> Vec<u32> {
    let distances = squared_euclidean_distance(&source.invert());
    components.maximum_values_by_component(&distances)
}

fn protect_high_contrast_components(
    components: &ComponentMap,
    normalized: &GrayImage,
    more_cautious_keep: Option<&[bool]>,
    keep: &mut [bool],
) {
    const INKY_CONTRAST_THRESHOLD: f64 = 40.0;
    let (ink_sums, ink_counts) = components.gray_sums_by_component(normalized);
    for component in components.components() {
        let label = component.label as usize;
        if keep[label]
            || ink_counts[label] == 0
            || more_cautious_keep.is_some_and(|decision| !decision[label])
        {
            continue;
        }
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let radius = width.min(height).div_ceil(2).clamp(2, 12);
        let left = component.left.saturating_sub(radius);
        let right = component
            .right
            .saturating_add(radius)
            .min(normalized.width() - 1);
        let top = component.top.saturating_sub(radius);
        let bottom = component
            .bottom
            .saturating_add(radius)
            .min(normalized.height() - 1);
        let mut paper_sum = 0u64;
        let mut paper_count = 0usize;
        for y in top..=bottom {
            for x in left..=right {
                if components.label_at(x, y) == 0 {
                    paper_sum += u64::from(normalized.get(x, y));
                    paper_count += 1;
                }
            }
        }
        if paper_count == 0 {
            continue;
        }
        let ink_mean = ink_sums[label] as f64 / ink_counts[label] as f64;
        let paper_mean = paper_sum as f64 / paper_count as f64;
        if paper_mean - ink_mean >= INKY_CONTRAST_THRESHOLD {
            keep[label] = true;
        }
    }
}

fn populate_attachment_graph(
    components: &[scan_primitives::Component],
    graph: &mut [Vec<AttachmentEdge>],
) {
    let mut by_left = (0..components.len()).collect::<Vec<_>>();
    by_left.sort_unstable_by_key(|&index| components[index].left);
    let maximum_area = components
        .iter()
        .map(|component| component.area)
        .max()
        .unwrap_or(0);
    let horizontal_reach = (maximum_area as f64 * 100.0).sqrt().ceil() as usize;
    for (position, &left_index) in by_left.iter().enumerate() {
        let left = &components[left_index];
        for &right_index in &by_left[position + 1..] {
            let right = &components[right_index];
            if right.left > left.right.saturating_add(horizontal_reach + 1) {
                break;
            }
            let distance_squared = component_gap_distance_squared(left, right);
            if distance_squared <= left.area.max(right.area) as u64 * 100 {
                graph[left.label as usize].push(AttachmentEdge {
                    neighbor: right.label as usize,
                    distance_squared,
                });
                graph[right.label as usize].push(AttachmentEdge {
                    neighbor: left.label as usize,
                    distance_squared,
                });
            }
        }
    }
}

fn protect_line_supported_marks(
    components: &[scan_primitives::Component],
    seeds: &[bool],
    dpi: f64,
    keep: &mut [bool],
) {
    // Cautious mode treats an entire bracketed text row as supporting evidence.
    // This protects long dot leaders and isolated punctuation without making
    // them graph bridges: they are retained but never added to the Dijkstra queue.
    let scale = (dpi / 300.0).clamp(0.5, 4.0);
    let horizontal_reach = (224.0 * scale).round() as usize;
    let vertical_reach = (9.0 * scale).round().max(2.0) as usize;
    let anchors = components
        .iter()
        .filter(|component| seeds[component.label as usize])
        .collect::<Vec<_>>();
    for mark in components {
        let label = mark.label as usize;
        if keep[label] || mark.area < 2 || seeds[label] {
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

fn component_gap_distance_squared(
    left: &scan_primitives::Component,
    right: &scan_primitives::Component,
) -> u64 {
    let x_gap = axis_gap(left.left, left.right, right.left, right.right) as u64;
    let y_gap = axis_gap(left.top, left.bottom, right.top, right.bottom) as u64;
    x_gap * x_gap + y_gap * y_gap
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
    fn multiscale_consensus_recovers_faint_thin_stroke_only_with_gradient_support() {
        let mut normalized = GrayImage::new(15, 15, 220);
        let mut small = BinaryImage::new(15, 15);
        let medium = BinaryImage::new(15, 15);
        let large = BinaryImage::new(15, 15);
        for y in 2..13 {
            for x in 6..8 {
                normalized.set(x, y, 190);
                small.set(x, y, true);
            }
        }

        let recovered = multiscale_consensus(&normalized, &small, &medium, &large);
        assert!(recovered.get(6, 7));
        assert!(recovered.get(7, 7));

        let flat = GrayImage::new(15, 15, 220);
        let unsupported = multiscale_consensus(&flat, &small, &medium, &large);
        assert!(!unsupported.get(6, 7));
        assert!(!unsupported.get(7, 7));
    }

    #[test]
    fn multiscale_consensus_rejects_isolated_low_variance_noise_from_smallest_window() {
        let mut normalized = GrayImage::new(11, 11, 220);
        normalized.set(5, 5, 219);
        let mut small = BinaryImage::new(11, 11);
        small.set(5, 5, true);
        let medium = BinaryImage::new(11, 11);
        let large = BinaryImage::new(11, 11);

        let consensus = multiscale_consensus(&normalized, &small, &medium, &large);
        assert!(!consensus.get(5, 5));
    }

    #[test]
    fn legacy_calibration_keeps_single_window_thresholding() {
        let mut image = GrayImage::new(61, 43, 232);
        for y in 7..36 {
            for x in (8..53).step_by(9) {
                image.set(x, y, 105 + (x % 4) as u8);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Wolf,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&image, options.dpi, CalibrationConfig::legacy());
        let method = LocalThreshold::Wolf {
            k: WOLF_K,
            deviation_floor: 2.0,
            minimum_percentile: WOLF_MINIMUM_PERCENTILE,
            hard_ink: WOLF_HARD_INK,
            hard_paper: WOLF_HARD_PAPER,
        };
        let expected =
            threshold_local_biased(&image, calibration.threshold_radius(options.dpi), method, 0);

        assert_eq!(
            threshold_with_mode(
                &image,
                &image,
                None,
                &options,
                BinarizationMode::Wolf,
                calibration,
            ),
            expected
        );
    }

    #[test]
    #[ignore = "manual release-mode timing for the A3 report"]
    fn benchmark_multiscale_wolf_against_single_window_bw_route() {
        use std::time::Instant;

        let mut image = GrayImage::new(1_275, 1_650, 238);
        for y in 0..image.height() {
            for x in 0..image.width() {
                image.set(x, y, 232 + ((x * 7 + y * 11 + x * y % 17) % 13) as u8);
            }
        }
        for top in (35..1_610).step_by(24) {
            for left in (30..1_235).step_by(19) {
                for y in top..top + 14 {
                    for x in left..left + 8 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            image.set(x, y, 82 + ((x + y) % 9) as u8);
                        }
                    }
                }
            }
        }
        let options = CleanupOptions {
            binarization: BinarizationMode::Wolf,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let multiscale = CalibrationConfig::default();
        let single_window = CalibrationConfig {
            multiscale_local_threshold: false,
            ..CalibrationConfig::default()
        };

        let _ = clean_black_and_white_with_calibration_config(&image, &options, single_window);
        let _ = clean_black_and_white_with_calibration_config(&image, &options, multiscale);
        let mut single_samples = Vec::new();
        let mut multiscale_samples = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            let single = std::hint::black_box(clean_black_and_white_with_calibration_config(
                &image,
                &options,
                single_window,
            ));
            single_samples.push(started.elapsed());

            let started = Instant::now();
            let multiple = std::hint::black_box(clean_black_and_white_with_calibration_config(
                &image, &options, multiscale,
            ));
            multiscale_samples.push(started.elapsed());
            assert_eq!(single.binary.width(), multiple.binary.width());
            assert_eq!(single.binary.height(), multiple.binary.height());
        }
        single_samples.sort_unstable();
        multiscale_samples.sort_unstable();
        let single = single_samples[1];
        let multiscale = multiscale_samples[1];
        let ratio = multiscale.as_secs_f64() / single.as_secs_f64();
        eprintln!(
            "A3 Wolf BW route 1275x1650: single={single:?} multiscale={multiscale:?} ratio={ratio:.3}x"
        );
        assert!(ratio <= 1.5, "multiscale BW route ratio was {ratio:.3}x");
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
        assert_eq!(
            choose_mode(67.0, 0.5, 0.17, 15.0, 0.064, 0.976),
            BinarizationMode::Otsu,
            "dense text on uniform tinted paper must not be thickened by a local route"
        );
    }

    #[test]
    fn uniform_paper_threshold_is_anchored_at_the_paper_ink_midpoint() {
        for (paper, ink) in [(221u8, 42u8), (218, 46), (192, 28), (112, 8)] {
            let mut image = GrayImage::new(240, 180, paper);
            for y in 20..160 {
                for x in (18..220).step_by(12) {
                    image.set(x, y, ink);
                    image.set(x + 1, y, ((u16::from(ink) + u16::from(paper)) / 2) as u8);
                }
            }
            let threshold = paper_ink_midpoint_threshold(&image, None);
            let expected = ((u16::from(ink) + u16::from(paper)) / 2) as i16;
            assert!(
                (i16::from(threshold) - expected).abs() <= 2,
                "paper={paper}, ink={ink}, threshold={threshold}, expected={expected}"
            );
        }
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
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let graph_disabled = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            false,
        )
        .image;
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
    fn grayscale_contrast_demotes_deletion_to_cautious_attachment() {
        let mut image = BinaryImage::new(70, 40);
        for y in 18..28 {
            for x in 10..20 {
                image.set(x, y, true);
            }
        }
        for y in 21..23 {
            for x in 35..37 {
                image.set(x, y, true);
            }
        }
        let mut normalized = GrayImage::new(70, 40, 235);
        for y in 0..image.height() {
            for x in 0..image.width() {
                if image.get(x, y) {
                    normalized.set(x, y, 25);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let binary_only = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        let contrast_aware = despeckle_connected_impl(
            &image,
            Some(&normalized),
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        assert!(!binary_only.get(35, 21));
        assert!(contrast_aware.get(35, 21));
    }

    #[test]
    fn despeckle_fallback_preserves_pages_without_a_substantial_seed() {
        let mut image = BinaryImage::new(120, 80);
        for index in 0..20 {
            let left = 4 + (index % 10) * 11;
            let top = 5 + (index / 10) * 30;
            let width = 2 + index % 3;
            let height = 2 + (index / 3) % 3;
            for y in top..top + height {
                for x in left..left + width {
                    image.set(x, y, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let outcome = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        );
        assert!(outcome.fallback);
        assert!(black_count(&outcome.image) > 0);
    }

    #[test]
    fn pencil_only_page_survives_top_decile_fallback_anchors() {
        let mut image = BinaryImage::new(140, 90);
        for row in 0..3 {
            for column in 0..12 {
                let left = 6 + column * 11;
                let top = 8 + row * 25;
                for offset in 0..7 {
                    image.set(left + offset, top + offset, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let outcome = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        );
        assert!(outcome.fallback);
        assert_eq!(outcome.image, image);
    }

    #[test]
    fn normal_despeckle_caps_transitive_noise_chains_at_three_hops() {
        let mut image = BinaryImage::new(90, 50);
        for y in 20..28 {
            for x in 5..13 {
                image.set(x, y, true);
            }
        }
        for left in [25, 39, 53, 67] {
            for y in 23..25 {
                for x in left..left + 2 {
                    image.set(x, y, true);
                }
            }
        }
        let cleaned = despeckle_connected(&image, 300.0);
        assert!(cleaned.get(25, 23), "directly attached mark must remain");
        assert!(cleaned.get(39, 23), "the second hop must remain");
        assert!(cleaned.get(53, 23), "the third hop must remain");
        assert!(
            !cleaned.get(67, 23),
            "a speck chain must not propagate arbitrarily far"
        );
    }

    #[test]
    fn aggressive_level_removes_more_pepper_than_normal_without_erasing_page() {
        let mut image = BinaryImage::new(100, 55);
        for y in 20..32 {
            for x in 8..20 {
                image.set(x, y, true);
            }
        }
        for &(left, top) in &[(31, 22), (46, 23), (63, 21), (82, 40)] {
            for y in top..top + 2 {
                for x in left..left + 2 {
                    image.set(x, y, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let normal = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        let aggressive = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Aggressive,
            true,
        )
        .image;
        assert!(black_count(&normal) > black_count(&aggressive));
        assert!(black_count(&aggressive) > 0);
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
    fn supersampled_thin_strokes_use_final_raster_calibration() {
        let mut binary = BinaryImage::new(1_200, 400);
        for y in 40..80 {
            for x in 40..80 {
                binary.set(x, y, true);
            }
        }
        let mut protected_endpoints = Vec::new();
        for column in 0..12 {
            let left = 650 + column * 35;
            let top = 120;
            protected_endpoints.push((left, top));
            for y in top..top + 20 {
                for x in left..left + 2 {
                    binary.set(x, y, true);
                }
                for x in left + 10..left + 12 {
                    binary.set(x, y, true);
                }
            }
            for y in top + 18..top + 20 {
                for x in left..left + 12 {
                    binary.set(x, y, true);
                }
            }
        }
        let normalized = binary_to_gray(&binary);
        let analysis_calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 18.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let options = CleanupOptions {
            dpi: 1_200.0,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            ..CleanupOptions::default()
        };

        let (cleaned, fallback) = postprocess_binary_with_diagnostics(
            &binary,
            Some(&normalized),
            &options,
            analysis_calibration,
        );

        assert!(!fallback);
        for endpoint in protected_endpoints {
            assert!(
                cleaned.get(endpoint.0, endpoint.1),
                "supersampled two-pixel stroke endpoint was erased at {endpoint:?}"
            );
        }
        let retention = black_count(&cleaned) as f64 / black_count(&binary) as f64;
        assert!(
            retention >= 0.99,
            "supersampled thin-stroke retention was only {retention:.4}"
        );
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
    fn edge_smoothing_uses_topology_profile_for_fragile_strokes_at_every_dpi() {
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
            smooth_edges_for_page(&image, 72.0).get(8, 6),
            "low-DPI punctuation must not fall back to destructive legacy smoothing"
        );
    }
}
