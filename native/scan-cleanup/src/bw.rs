use crate::{
    background::{normalize_illumination, smooth_for_binarization},
    calibration::{CalibrationConfig, PageCalibration},
    BinarizationMode, CleanupOptions, DespeckleLevel,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, dilate_gray, erode_gray},
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
const TILE_PAPER_DELTA: u8 = 48;
const TILE_PAPER_FRACTION_FLOOR: f64 = 0.97;
const MIN_QUALIFYING_PAPER_TILES: usize = 4;

// A rule is preserved only when the source itself contains a long, thin run
// of dark pixels. The geometry is intentionally shared with the render-side
// fallback, while the raw plane remains the authority for every candidate.
pub(crate) const RULE_RAW_DEPTH: u8 = 72;
const RULE_MINIMUM_SPAN_MM: f64 = 15.0;
// Running-head rules in the reference scans run up to ~3.5 mm; above
// 2 mm the aspect requirement tightens to 8:1 so short thick blocks
// (caption fragments, stamps) cannot ride the exemption.
const RULE_MAXIMUM_THICKNESS_MM: f64 = 4.0;
const RULE_THIN_THICKNESS_MM: f64 = 2.0;

// These are shared with the final bleed filter. A rescue may recover a raw
// candidate only when it has the same crisp-or-deep evidence that the final
// filter trusts for retaining a printed component. The filter still gets the
// last word, because a rescued component can merge with a shallow strike.
pub(crate) const BLEED_CRISPNESS_FLOOR: u16 = 32;
pub(crate) const BLEED_SHALLOW_DEPTH: u8 = 80;
const RESCUE_CANDIDATE_DEPTH: u8 = 24;
const RESCUE_ROW_SIGNAL_DEPTH: u8 = 24;
const RESCUE_ROW_SIGNAL_CRISPNESS: u16 = 18;
// Must classify only genuinely dark missing body pixels, not a healthy stroke's gray halo.
const RESCUE_SOLID_DEPTH: u8 = 128;
// Must recognize captured healthy ink while leaving pale captured skeletons rescue-eligible.
const RESCUE_SOLID_CAPTURED_MEDIAN: u8 = 96;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spread_plan: Option<SpreadBinarizationPlanDiagnostics>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadBinarizationPlanDiagnostics {
    pub route: BinarizationMode,
    pub threshold_anchor: u8,
    pub threshold_radius: usize,
    pub stroke_width_anchor_px: f64,
    pub x_height_anchor_px: f64,
    pub document_anchor: bool,
    pub joint_candidate_route: BinarizationMode,
    pub left_candidate_route: BinarizationMode,
    pub right_candidate_route: BinarizationMode,
    pub decision: SpreadBinarizationPlanDecision,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpreadBinarizationPlanDecision {
    SharedJoint,
    PerLeafRouteMismatch,
    PerLeafAnchorDrift,
    PerLeafRadiusDrift,
    PerLeafFaintInkDrift,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SpreadBinarizationPlan {
    route: BinarizationMode,
    threshold_anchor: u8,
    threshold_radius: usize,
    x_height_anchor_px: f64,
    diagnostics: SpreadBinarizationPlanDiagnostics,
}

impl SpreadBinarizationPlan {
    pub(crate) fn route(self) -> BinarizationMode {
        self.route
    }

    pub(crate) fn diagnostics_for(
        self,
        routing_sample: &GrayImage,
        options: &CleanupOptions,
    ) -> BinarizationDiagnostics {
        let mut diagnostics = measure_binarization_diagnostics(routing_sample, options);
        diagnostics.route = self.route;
        diagnostics.spread_plan = Some(self.diagnostics);
        diagnostics
    }

    pub(crate) fn uses_per_leaf_fallback(self) -> bool {
        self.diagnostics.decision != SpreadBinarizationPlanDecision::SharedJoint
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SpreadBinarizationPlans {
    pub left: SpreadBinarizationPlan,
    pub right: SpreadBinarizationPlan,
}

impl SpreadBinarizationPlans {
    pub(crate) fn for_half(
        self,
        half: crate::domain::geometry::PageHalf,
    ) -> SpreadBinarizationPlan {
        match half {
            crate::domain::geometry::PageHalf::Left => self.left,
            crate::domain::geometry::PageHalf::Right => self.right,
            crate::domain::geometry::PageHalf::Full => self.left,
        }
    }
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
    let (binary, mode) =
        binarize_normalized_calibrated(&normalized, source, options, calibration, None, None);
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
    binarize_normalized_calibrated(normalized, normalized, options, calibration, None, None)
}

fn binarize_normalized_calibrated(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
) -> (BinaryImage, BinarizationMode) {
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(&threshold_input, options);
    let mode = diagnostics.route;
    (
        binarize_with_mode(
            &threshold_input,
            normalized,
            raw_source,
            options,
            mode,
            calibration,
            picture_mask,
            text_vicinity,
        ),
        mode,
    )
}

pub(crate) fn binarize_normalized_with_diagnostics(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    routing_sample: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> (
    BinaryImage,
    BinarizationDiagnostics,
    bool,
    BinarizationStageTimings,
) {
    let mut timings = BinarizationStageTimings::default();
    let preparation_started = Instant::now();
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = spread_plan.map_or_else(
        || resolve_binarization_diagnostics(routing_sample, options),
        |plan| plan.diagnostics_for(routing_sample, options),
    );
    timings.preparation_ms += preparation_started.elapsed().as_secs_f64() * 1_000.0;
    let thresholding_started = Instant::now();
    let binary = threshold_with_mode(
        &threshold_input,
        normalized,
        global_threshold_source,
        options,
        diagnostics.route,
        calibration,
        spread_plan,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback) = postprocess_binary_with_diagnostics_and_raw(
        &binary,
        Some(normalized),
        Some(raw_source),
        options,
        calibration,
    );
    let binary = rescue_component_scoped_faint_strokes(
        &binary,
        raw_source,
        picture_mask,
        text_vicinity,
        None,
        options.binarization,
        diagnostics.route,
        options.dpi,
        should_rescue_spread_fallback(spread_plan, &diagnostics),
    );
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (binary, diagnostics, despeckle_fallback, timings)
}

/// Mixed-mode binarization with picture pixels omitted from threshold
/// statistics and held white through despeckling and morphological smoothing.
pub(crate) fn binarize_normalized_with_diagnostics_excluding(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: &BinaryImage,
    text_vicinity: Option<&BinaryImage>,
    spread_plan: Option<&SpreadBinarizationPlan>,
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
    let diagnostics = spread_plan.map_or_else(
        || resolve_binarization_diagnostics(&masked_input, options),
        |plan| plan.diagnostics_for(&masked_input, options),
    );
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
        spread_plan,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback) = postprocess_binary_with_diagnostics_and_raw(
        &binary,
        Some(normalized),
        Some(raw_source),
        options,
        calibration,
    );
    let binary = rescue_component_scoped_faint_strokes(
        &binary,
        raw_source,
        Some(picture_mask),
        text_vicinity,
        None,
        options.binarization,
        diagnostics.route,
        options.dpi,
        should_rescue_spread_fallback(spread_plan, &diagnostics),
    )
    .subtract(&protected_picture_mask);
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (binary, diagnostics, despeckle_fallback, timings)
}

pub(crate) fn picture_protection_radius(dpi: f64) -> usize {
    (dpi * 0.35 / 25.4).round().clamp(1.0, 12.0) as usize
}

fn should_rescue_spread_fallback(
    spread_plan: Option<&SpreadBinarizationPlan>,
    diagnostics: &BinarizationDiagnostics,
) -> bool {
    let Some(plan) = spread_plan else {
        return false;
    };
    if !plan.uses_per_leaf_fallback() {
        return false;
    }

    // Local routes already have their own faint-stroke rescue. A divergent
    // Otsu leaf needs the same protection only when its evidence is sparse;
    // dense Otsu leaves must retain ordinary Otsu mass (the joint plan's
    // fallback rescue can otherwise add a visible amount of extra ink).
    matches!(
        diagnostics.route,
        BinarizationMode::Sauvola | BinarizationMode::Wolf
    ) || (diagnostics.route == BinarizationMode::Otsu && diagnostics.edge_density <= 0.32)
}

fn binarize_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    raw_source: &GrayImage,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
) -> BinaryImage {
    let binary = threshold_with_mode(
        threshold_input,
        normalized,
        None,
        options,
        mode,
        calibration,
        None,
    );
    let binary = postprocess_binary_with_raw(
        &binary,
        Some(normalized),
        Some(raw_source),
        options,
        calibration,
    );
    rescue_component_scoped_faint_strokes(
        &binary,
        raw_source,
        picture_mask,
        text_vicinity,
        None,
        options.binarization,
        mode,
        options.dpi,
        false,
    )
}

fn threshold_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> BinaryImage {
    let radius = spread_plan.map_or_else(
        || calibration.threshold_radius(options.dpi),
        |plan| plan.threshold_radius,
    );
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            let threshold = spread_plan.map_or_else(
                || paper_ink_midpoint_threshold(source, None),
                |plan| plan.threshold_anchor,
            );
            threshold_global_biased(source, threshold, bias)
        }
        BinarizationMode::Sauvola => threshold_local_for_route(
            threshold_input,
            normalized,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
            calibration,
            options.dpi,
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
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
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
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
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> BinaryImage {
    let radius = spread_plan.map_or_else(
        || calibration.threshold_radius(options.dpi),
        |plan| plan.threshold_radius,
    );
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            let threshold = spread_plan.map_or_else(
                || paper_ink_midpoint_threshold(source, Some(picture_mask)),
                |plan| plan.threshold_anchor,
            );
            threshold_global_biased(source, threshold, bias).subtract(picture_mask)
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
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
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
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
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
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
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
    let [small_radius, medium_radius, large_radius] = multiscale_threshold_radii(
        calibration,
        raster_dpi,
        shared_threshold_radius,
        shared_x_height_px,
    );
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
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
) -> BinaryImage {
    if !calibration.config.multiscale_local_threshold {
        return threshold_local_biased(threshold_input, legacy_radius, method, bias);
    }

    let integrals = IntegralImages::new(threshold_input);
    let [small_radius, medium_radius, large_radius] = multiscale_threshold_radii(
        calibration,
        raster_dpi,
        shared_threshold_radius,
        shared_x_height_px,
    );
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

fn multiscale_threshold_radii(
    calibration: PageCalibration,
    raster_dpi: f64,
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
) -> [usize; 3] {
    shared_threshold_radius.map_or_else(
        || calibration.multiscale_threshold_radii(raster_dpi),
        |base_radius| {
            let shared_x_height = shared_x_height_px.unwrap_or_else(|| {
                // Legacy callers without a spread plan have no explicit
                // x-height. Keep their old radius-derived behavior, while
                // spread plans carry the unclamped document/leaf estimate.
                base_radius as f64 / 1.5
            }) * raster_dpi.max(1.0)
                / calibration.effective_dpi.max(1.0);
            [1.0, 2.5, 5.0]
                .map(|scale| (scale * shared_x_height).round() as usize)
                .map(|radius| radius.clamp(8, 256))
        },
    )
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

fn postprocess_binary_with_raw(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> BinaryImage {
    postprocess_binary_with_diagnostics_and_raw(binary, normalized, raw, options, calibration).0
}

pub(crate) fn postprocess_binary_with_diagnostics_and_raw(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> (BinaryImage, bool) {
    let level = options.effective_despeckle_level();
    let rule_components = raw
        .filter(|image| image.width() == binary.width() && image.height() == binary.height())
        .map(|image| rule_scale_component_flags(binary, image, options.dpi));
    let (despeckled, despeckle_fallback) = if level != DespeckleLevel::Off {
        let outcome = despeckle_connected_impl_with_protection(
            binary,
            normalized,
            rule_components.as_deref(),
            options.dpi,
            calibration,
            level,
            true,
        );
        (outcome.image, outcome.fallback)
    } else {
        (binary.clone(), false)
    };
    let smoothed = smooth_edges_for_page(&despeckled, options.dpi);
    let preserved_rules = rule_components.map(|flags| {
        ComponentMap::from_binary(binary).retain(|component| flags[component.label as usize])
    });
    let output = match preserved_rules {
        Some(rules) => smoothed.or(&rules),
        None => smoothed,
    };
    (output, despeckle_fallback)
}

pub(crate) fn resolve_binarization_diagnostics(
    image: &GrayImage,
    options: &CleanupOptions,
) -> BinarizationDiagnostics {
    let mut diagnostics = measure_binarization_diagnostics(image, options);
    diagnostics.route = match options.binarization {
        BinarizationMode::Auto => choose_mode(
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ),
        explicit => explicit,
    };
    diagnostics
}

fn measure_binarization_diagnostics(
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
    BinarizationDiagnostics {
        route: options.binarization,
        robust_contrast,
        illumination_deviation,
        edge_density,
        estimated_stroke_width_px,
        dark_border_coverage,
        otsu_adaptive_agreement,
        spread_plan: None,
    }
}

/// Resolves a symmetric spread candidate first, then keeps each leaf's own
/// route/threshold scale whenever the evidence is materially different. The
/// joint route is evidence from the whole spread, not a left-leaf tie-breaker;
/// it is only allowed to control both leaves after the leaf agreement gates
/// pass.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_spread_binarization_plans(
    normalized: &GrayImage,
    left: &GrayImage,
    right: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    left_picture_mask: Option<&BinaryImage>,
    right_picture_mask: Option<&BinaryImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    document_stroke_width_px: Option<f64>,
    document_x_height_px: Option<f64>,
) -> SpreadBinarizationPlans {
    let joint_input = masked_spread_input(normalized, picture_mask, options);
    let left_input = masked_spread_input(left, left_picture_mask, options);
    let right_input = masked_spread_input(right, right_picture_mask, options);
    let joint = measure_binarization_diagnostics(&joint_input, options);
    let left_candidate = measure_binarization_diagnostics(&left_input, options);
    let right_candidate = measure_binarization_diagnostics(&right_input, options);
    let joint_route = match options.binarization {
        BinarizationMode::Auto => resolve_route_for_diagnostics(&joint, options),
        explicit => explicit,
    };
    let left_route = resolve_route_for_diagnostics(&left_candidate, options);
    let right_route = resolve_route_for_diagnostics(&right_candidate, options);
    let left_protected_picture_mask =
        left_picture_mask.map(|mask| protected_picture_mask(mask, options));
    let right_protected_picture_mask =
        right_picture_mask.map(|mask| protected_picture_mask(mask, options));
    let left_anchor = paper_ink_midpoint_threshold(left, left_protected_picture_mask.as_ref());
    let right_anchor = paper_ink_midpoint_threshold(right, right_protected_picture_mask.as_ref());
    // `left` and `right` are the full working-resolution leaves, while the
    // calibration carried into this function was measured on the bounded
    // analysis raster (normally 150 DPI).  Measuring a full leaf with the
    // analysis DPI makes its pixel x-height look twice as large physically;
    // the resulting radius then clamps at 64 and destroys the thinner leaf on
    // a route-mismatch fallback.  Measure leaf evidence in working pixels,
    // then express it in the analysis calibration's reference pixels below.
    let working_dpi = options.dpi.max(1.0);
    let left_calibration = PageCalibration::estimate(left, working_dpi, calibration.config);
    let right_calibration = PageCalibration::estimate(right, working_dpi, calibration.config);
    // Agreement is measured from each leaf's own calibration. The document
    // prior anchors a shared plan, but must not mask a real per-leaf radius
    // drift and thereby force a damaging shared threshold onto one leaf.
    let left_x_height = leaf_x_height(left_calibration, None, calibration, working_dpi);
    let right_x_height = leaf_x_height(right_calibration, None, calibration, working_dpi);
    let left_radius = threshold_radius_for_x_height(left_x_height, options, calibration);
    let right_radius = threshold_radius_for_x_height(right_x_height, options, calibration);
    let route_mismatch = left_route != right_route;
    let anchor_drift = relative_difference(f64::from(left_anchor), f64::from(right_anchor)) > 0.20;
    let radius_drift = relative_difference(left_radius as f64, right_radius as f64) > 0.20;
    let faint_ink_drift = relative_difference(
        faint_ink_fraction(&left_input),
        faint_ink_fraction(&right_input),
    ) > 0.20;
    let decision = if route_mismatch {
        SpreadBinarizationPlanDecision::PerLeafRouteMismatch
    } else if anchor_drift {
        SpreadBinarizationPlanDecision::PerLeafAnchorDrift
    } else if radius_drift {
        SpreadBinarizationPlanDecision::PerLeafRadiusDrift
    } else if faint_ink_drift {
        SpreadBinarizationPlanDecision::PerLeafFaintInkDrift
    } else {
        SpreadBinarizationPlanDecision::SharedJoint
    };
    if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_SPREAD_PLAN").is_some() {
        eprintln!(
            "spread-plan left-anchor={} right-anchor={} left-radius={} right-radius={} left-route={:?} right-route={:?} decision={decision:?}",
            left_anchor, right_anchor, left_radius, right_radius, left_route, right_route,
        );
    }

    let shared_x_height = document_x_height_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or((left_x_height + right_x_height) / 2.0);
    let shared_anchor = midpoint_u8(left_anchor, right_anchor);
    let shared_stroke_width = document_stroke_width_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            let left_stroke = leaf_stroke_width(
                left_calibration,
                left_candidate.estimated_stroke_width_px,
                calibration,
                working_dpi,
            );
            let right_stroke = leaf_stroke_width(
                right_calibration,
                right_candidate.estimated_stroke_width_px,
                calibration,
                working_dpi,
            );
            (left_stroke + right_stroke) / 2.0
        });
    let common_diagnostics =
        |route: BinarizationMode,
         threshold_anchor: u8,
         threshold_radius: usize,
         x_height_anchor_px: f64,
         document_anchor: bool,
         decision: SpreadBinarizationPlanDecision| {
            SpreadBinarizationPlanDiagnostics {
                route,
                threshold_anchor,
                threshold_radius,
                stroke_width_anchor_px: shared_stroke_width,
                x_height_anchor_px,
                document_anchor,
                joint_candidate_route: joint_route,
                left_candidate_route: left_route,
                right_candidate_route: right_route,
                decision,
            }
        };
    let shared_plan = SpreadBinarizationPlan {
        route: joint_route,
        threshold_anchor: shared_anchor,
        threshold_radius: threshold_radius_for_x_height(shared_x_height, options, calibration),
        x_height_anchor_px: shared_x_height,
        diagnostics: common_diagnostics(
            joint_route,
            shared_anchor,
            threshold_radius_for_x_height(shared_x_height, options, calibration),
            shared_x_height,
            document_x_height_px.is_some() || document_stroke_width_px.is_some(),
            decision,
        ),
    };
    if decision == SpreadBinarizationPlanDecision::SharedJoint {
        return SpreadBinarizationPlans {
            left: shared_plan,
            right: shared_plan,
        };
    }

    let left_plan = leaf_plan(
        left_route,
        left_anchor,
        left_calibration,
        left_candidate.estimated_stroke_width_px,
        options,
        calibration,
        working_dpi,
        document_stroke_width_px,
        document_x_height_px,
        common_diagnostics,
        decision,
    );
    let right_plan = leaf_plan(
        right_route,
        right_anchor,
        right_calibration,
        right_candidate.estimated_stroke_width_px,
        options,
        calibration,
        working_dpi,
        document_stroke_width_px,
        document_x_height_px,
        common_diagnostics,
        decision,
    );
    SpreadBinarizationPlans {
        left: left_plan,
        right: right_plan,
    }
}

#[allow(clippy::too_many_arguments)]
fn leaf_plan<F>(
    route: BinarizationMode,
    threshold_anchor: u8,
    leaf_calibration: PageCalibration,
    estimated_stroke_width_px: f64,
    options: &CleanupOptions,
    spread_calibration: PageCalibration,
    working_dpi: f64,
    document_stroke_width_px: Option<f64>,
    document_x_height_px: Option<f64>,
    diagnostics: F,
    decision: SpreadBinarizationPlanDecision,
) -> SpreadBinarizationPlan
where
    F: Fn(
        BinarizationMode,
        u8,
        usize,
        f64,
        bool,
        SpreadBinarizationPlanDecision,
    ) -> SpreadBinarizationPlanDiagnostics,
{
    let x_height_anchor_px = if leaf_calibration.valid {
        leaf_x_height(leaf_calibration, None, spread_calibration, working_dpi)
    } else {
        document_x_height_px
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or_else(|| {
                leaf_x_height(leaf_calibration, None, spread_calibration, working_dpi)
            })
    };
    let threshold_radius =
        threshold_radius_for_x_height(x_height_anchor_px, options, spread_calibration);
    let stroke_width_anchor_px = document_stroke_width_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            leaf_stroke_width(
                leaf_calibration,
                estimated_stroke_width_px,
                spread_calibration,
                working_dpi,
            )
        });
    let mut plan_diagnostics = diagnostics(
        route,
        threshold_anchor,
        threshold_radius,
        x_height_anchor_px,
        document_x_height_px.is_some() || document_stroke_width_px.is_some(),
        decision,
    );
    plan_diagnostics.stroke_width_anchor_px = stroke_width_anchor_px;
    SpreadBinarizationPlan {
        route,
        threshold_anchor,
        threshold_radius,
        x_height_anchor_px,
        diagnostics: plan_diagnostics,
    }
}

fn masked_spread_input(
    image: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    options: &CleanupOptions,
) -> GrayImage {
    let Some(picture_mask) = picture_mask else {
        return image.clone();
    };
    let protected = protected_picture_mask(picture_mask, options);
    let mut masked = image.clone();
    for y in 0..masked.height() {
        for x in 0..masked.width() {
            if protected.get(x, y) {
                masked.set(x, y, 255);
            }
        }
    }
    masked
}

fn faint_ink_fraction(image: &GrayImage) -> f64 {
    let paper = paper_reference(image);
    let threshold = paper.saturating_sub(24);
    let total = image.width().saturating_mul(image.height()).max(1);
    image
        .data()
        .iter()
        .filter(|&&value| value < threshold)
        .count() as f64
        / total as f64
}

fn protected_picture_mask(mask: &BinaryImage, options: &CleanupOptions) -> BinaryImage {
    dilate(
        mask,
        picture_protection_radius(options.dpi),
        picture_protection_radius(options.dpi),
    )
}

fn leaf_x_height(
    leaf_calibration: PageCalibration,
    document_x_height_px: Option<f64>,
    spread_calibration: PageCalibration,
    working_dpi: f64,
) -> f64 {
    document_x_height_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            leaf_calibration
                .valid
                .then_some(
                    leaf_calibration.x_height_px * spread_calibration.effective_dpi.max(1.0)
                        / working_dpi.max(1.0),
                )
                .filter(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(17.0 * spread_calibration.effective_dpi.max(1.0) / 300.0)
}

fn leaf_stroke_width(
    leaf_calibration: PageCalibration,
    estimated_stroke_width_px: f64,
    spread_calibration: PageCalibration,
    working_dpi: f64,
) -> f64 {
    leaf_calibration
        .valid
        .then_some(
            leaf_calibration.stroke_width_px * spread_calibration.effective_dpi.max(1.0)
                / working_dpi.max(1.0),
        )
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            (estimated_stroke_width_px.is_finite() && estimated_stroke_width_px > 0.0)
                .then_some(estimated_stroke_width_px)
        })
        .unwrap_or_else(|| spread_calibration.stroke_width_px.max(1.0))
}

fn threshold_radius_for_x_height(
    x_height_anchor_px: f64,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> usize {
    (1.5 * x_height_anchor_px * options.dpi.max(1.0) / calibration.effective_dpi.max(1.0))
        .round()
        .clamp(8.0, 64.0) as usize
}

fn relative_difference(left: f64, right: f64) -> f64 {
    (left - right).abs() / left.abs().max(right.abs()).max(f64::EPSILON)
}

fn midpoint_u8(left: u8, right: u8) -> u8 {
    ((u16::from(left) + u16::from(right)) / 2) as u8
}

fn resolve_route_for_diagnostics(
    diagnostics: &BinarizationDiagnostics,
    options: &CleanupOptions,
) -> BinarizationMode {
    match options.binarization {
        BinarizationMode::Auto => choose_mode(
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ),
        explicit => explicit,
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
    // On a flat-lit sheet Wolf has no illumination to correct and its local
    // contrast normalization erases faint strokes outright, so the agreement
    // guard must not be the deciding vote there: the disagreement it measures
    // on such pages IS Wolf dropping faint text, and routing by it sends the
    // page into the very mode that damages it. Flat pages accept a lower
    // agreement before giving up on the global threshold.
    let agreement_floor = if illumination_deviation <= 2.0 {
        0.95
    } else {
        0.975
    };
    let clean_uniform = illumination_deviation <= 8.0
        && dark_border_coverage <= 0.08
        && otsu_adaptive_agreement >= agreement_floor
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
    let paper = paper_reference(image);
    let paper_floor = paper.saturating_sub(TILE_PAPER_DELTA);
    let filtered_paper = tile_paper_values(image, Some(paper_floor));
    if filtered_paper.len() >= MIN_QUALIFYING_PAPER_TILES {
        return paper_spread(&filtered_paper);
    }
    paper_spread(&tile_paper_values(image, None))
}

pub(crate) fn paper_reference(image: &GrayImage) -> u8 {
    let mut histogram = [0usize; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let target = image.data().len().saturating_sub(1) * 3 / 4;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|frequency| {
            cumulative += frequency;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

/// Recover faint print that a selected local threshold dropped, but only as
/// compact raw-plane components aligned with an independent text-row signal.
/// This deliberately does not run for Auto: the guarded Auto route is a
/// byte-sensitive regression path, while explicit Wolf/Sauvola need the
/// engine-level text-preservation invariant.
pub(crate) fn rescue_component_scoped_faint_strokes(
    damaged: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    row_evidence_exclusion: Option<&BinaryImage>,
    requested_mode: BinarizationMode,
    selected_mode: BinarizationMode,
    dpi: f64,
    spread_fallback: bool,
) -> BinaryImage {
    if (!spread_fallback
        && (!matches!(
            requested_mode,
            BinarizationMode::Sauvola | BinarizationMode::Wolf
        ) || !matches!(
            selected_mode,
            BinarizationMode::Sauvola | BinarizationMode::Wolf
        )))
        || damaged.width() == 0
        || damaged.height() == 0
    {
        return damaged.clone();
    }
    assert_eq!(
        (damaged.width(), damaged.height()),
        (raw.width(), raw.height())
    );
    debug_assert!(picture_mask.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));
    debug_assert!(text_vicinity.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));
    debug_assert!(row_evidence_exclusion.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));

    let paper = paper_reference(raw);
    let picture_owner = picture_mask.map(|mask| {
        dilate(
            mask,
            picture_protection_radius(dpi),
            picture_protection_radius(dpi),
        )
    });
    let candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= paper.saturating_sub(RESCUE_CANDIDATE_DEPTH)
            && !picture_owner.as_ref().is_some_and(|owner| owner.get(x, y))
    });
    if candidates.count_black() == 0 {
        return damaged.clone();
    }

    let components = ComponentMap::from_binary(&candidates);
    let gradient_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    let (raw_max, raw_min) = rayon::join(
        || erode_gray(raw, gradient_radius, gradient_radius),
        || dilate_gray(raw, gradient_radius, gradient_radius),
    );
    // The crispness window is intentionally small, but depth must see past a
    // complete glyph interior to the nearby paper. A wider local paper field
    // does that for text while leaving a broad shadow's interior shallow.
    let paper_radius = (dpi * 0.80 / 25.4).round().clamp(3.0, 12.0) as usize;
    let local_paper = erode_gray(raw, paper_radius, paper_radius);
    let row_tolerance = (dpi * 0.65 / 25.4).round().clamp(1.0, 8.0) as usize;
    let row_signal = text_vicinity.map(|mask| {
        let horizontal = (dpi * 3.0 / 25.4).round().max(2.0) as usize;
        dilate(mask, horizontal, row_tolerance)
    });
    let raw_row_profile = row_signal.is_none().then(|| {
        raw_text_row_profile(
            raw,
            picture_owner.as_ref(),
            row_evidence_exclusion,
            &raw_max,
            &raw_min,
            paper,
            dpi,
        )
    });
    let minimum_independent_row_support = (dpi * 0.30 / 25.4).round().max(4.0) as usize;
    let mut rescued = BinaryImage::new(damaged.width(), damaged.height());

    for component in components.components() {
        if !is_text_like_rescue_component(component, dpi) {
            continue;
        }
        let mut missing = 0usize;
        let mut deep_missing = 0usize;
        let mut qualifying_missing = 0usize;
        let mut captured_raw = Vec::new();
        let mut component_rows = vec![0usize; component.bottom - component.top + 1];
        let mut row_aligned = false;
        let mut touches_picture_owner = false;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label {
                    continue;
                }
                component_rows[y - component.top] += 1;
                if picture_owner.as_ref().is_some_and(|owner| owner.get(x, y)) {
                    touches_picture_owner = true;
                }
                if row_signal.as_ref().is_some_and(|signal| signal.get(x, y)) {
                    row_aligned = true;
                }
                if damaged.get(x, y) {
                    captured_raw.push(raw.get(x, y));
                    continue;
                }
                missing += 1;
                if raw.get(x, y) <= local_paper.get(x, y).saturating_sub(RESCUE_SOLID_DEPTH) {
                    deep_missing += 1;
                }
                let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
                if is_crisp_or_deep_sample(raw.get(x, y), local_paper.get(x, y), gradient) {
                    qualifying_missing += 1;
                }
            }
        }
        captured_raw.sort_unstable();
        let captured_median_raw = (!captured_raw.is_empty()).then(|| {
            let middle = captured_raw.len() / 2;
            if captured_raw.len() % 2 == 0 {
                ((u16::from(captured_raw[middle - 1]) + u16::from(captured_raw[middle])) / 2) as u8
            } else {
                captured_raw[middle]
            }
        });
        if let Some(profile) = raw_row_profile.as_ref() {
            row_aligned = (component.top..=component.bottom).any(|y| {
                profile[y] >= minimum_independent_row_support + component_rows[y - component.top]
            });
        }
        if touches_picture_owner
            || !row_aligned
            || missing == 0
            || captured_median_raw.is_some_and(|median| {
                median <= RESCUE_SOLID_CAPTURED_MEDIAN && deep_missing.saturating_mul(16) < missing
            })
            || qualifying_missing < 2
            || qualifying_missing.saturating_mul(4) < missing
        {
            continue;
        }
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label
                    || damaged.get(x, y)
                    || picture_owner.as_ref().is_some_and(|owner| owner.get(x, y))
                {
                    continue;
                }
                let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
                if is_crisp_or_deep_sample(raw.get(x, y), local_paper.get(x, y), gradient) {
                    rescued.set(x, y, true);
                }
            }
        }
    }
    damaged.or(&rescued)
}

fn raw_text_row_profile(
    raw: &GrayImage,
    picture_owner: Option<&BinaryImage>,
    row_evidence_exclusion: Option<&BinaryImage>,
    raw_max: &GrayImage,
    raw_min: &GrayImage,
    paper: u8,
    dpi: f64,
) -> Vec<usize> {
    let mut profile = vec![0usize; raw.height()];
    for (y, row_count) in profile.iter_mut().enumerate() {
        for x in 0..raw.width() {
            if picture_owner.is_some_and(|owner| owner.get(x, y))
                || row_evidence_exclusion.is_some_and(|excluded| excluded.get(x, y))
            {
                continue;
            }
            let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
            if raw.get(x, y) <= paper.saturating_sub(RESCUE_ROW_SIGNAL_DEPTH)
                || u16::from(gradient) >= RESCUE_ROW_SIGNAL_CRISPNESS
            {
                *row_count += 1;
            }
        }
    }
    let band_radius = (dpi * 0.45 / 25.4).round().clamp(1.0, 6.0) as usize;
    let mut banded = vec![0usize; raw.height()];
    for (y, target) in banded.iter_mut().enumerate() {
        *target = (y.saturating_sub(band_radius)
            ..=y.saturating_add(band_radius)
                .min(raw.height().saturating_sub(1)))
            .map(|sample_y| profile[sample_y])
            .max()
            .unwrap_or(0);
    }
    banded
}

fn is_text_like_rescue_component(component: &scan_primitives::Component, dpi: f64) -> bool {
    let px_per_mm = dpi.max(1.0) / 25.4;
    let width = component.right - component.left + 1;
    let height = component.bottom - component.top + 1;
    let major = width.max(height);
    let minor = width.min(height);
    let aspect = major as f64 / minor.max(1) as f64;
    let average_stroke = component.area as f64 / major.max(1) as f64;
    let maximum_extent = (px_per_mm * 8.0).round().max(4.0) as usize;
    let maximum_area = (px_per_mm * 4.5).round().max(16.0).powf(2.0) as usize;
    let minimum_stroke = (px_per_mm * 0.08).max(0.75);
    let maximum_stroke = (px_per_mm * 2.5).max(2.0);

    component.area >= 2
        && major <= maximum_extent
        && minor >= 1
        && aspect <= 10.0
        && component.area <= maximum_area
        && average_stroke >= minimum_stroke
        && average_stroke <= maximum_stroke
}

pub(crate) fn is_crisp_or_deep_sample(sample: u8, local_paper: u8, gradient: u8) -> bool {
    sample < local_paper.saturating_sub(BLEED_SHALLOW_DEPTH)
        || u16::from(gradient) >= BLEED_CRISPNESS_FLOOR
}

fn tile_paper_values(image: &GrayImage, paper_floor: Option<u8>) -> Vec<f64> {
    let mut paper = Vec::with_capacity(16);
    for tile_y in 0..4 {
        let top = tile_y * image.height() / 4;
        let bottom = ((tile_y + 1) * image.height() / 4).max(top + 1);
        for tile_x in 0..4 {
            let left = tile_x * image.width() / 4;
            let right = ((tile_x + 1) * image.width() / 4).max(left + 1);
            let mut histogram = [0usize; 256];
            let mut count = 0usize;
            let mut visible_paper = 0usize;
            for y in top..bottom.min(image.height()) {
                for x in left..right.min(image.width()) {
                    let value = image.get(x, y);
                    histogram[value as usize] += 1;
                    visible_paper += usize::from(paper_floor.is_none_or(|floor| value >= floor));
                    count += 1;
                }
            }
            if paper_floor.is_some()
                && visible_paper as f64 / (count.max(1) as f64) < TILE_PAPER_FRACTION_FLOOR
            {
                continue;
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
    paper
}

fn paper_spread(paper: &[f64]) -> f64 {
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
    let source_ink = source.count_black();
    let profile = resolve_smooth_profile(source, dpi);
    let smoothed = smooth_edges_with_profile(source, profile);
    if !smoothing_exceeds_ink_growth_limit(source_ink, smoothed.count_black()) {
        return smoothed;
    }
    if profile == SmoothProfile::TopologySafe {
        return source.clone();
    }
    let topology_safe = smooth_edges_with_profile(source, SmoothProfile::TopologySafe);
    if smoothing_exceeds_ink_growth_limit(source_ink, topology_safe.count_black()) {
        source.clone()
    } else {
        topology_safe
    }
}

fn smoothing_exceeds_ink_growth_limit(source_ink: usize, smoothed_ink: usize) -> bool {
    (smoothed_ink as u128) * 100 > (source_ink as u128) * 108
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

fn rule_scale_component_flags(source: &BinaryImage, raw: &GrayImage, dpi: f64) -> Vec<bool> {
    debug_assert_eq!(
        (source.width(), source.height()),
        (raw.width(), raw.height())
    );
    let components = ComponentMap::from_binary(source);
    let mut raw_dark_pixels = vec![0usize; components.components().len() + 1];
    let paper = paper_reference(raw);
    let dark_floor = paper.saturating_sub(RULE_RAW_DEPTH);
    for y in 0..source.height() {
        for x in 0..source.width() {
            if source.get(x, y) && raw.get(x, y) <= dark_floor {
                raw_dark_pixels[components.label_at(x, y) as usize] += 1;
            }
        }
    }
    let minimum_span = (dpi.max(1.0) * RULE_MINIMUM_SPAN_MM / 25.4)
        .round()
        .max(24.0) as usize;
    let maximum_thickness = (dpi.max(1.0) * RULE_MAXIMUM_THICKNESS_MM / 25.4)
        .round()
        .max(2.0) as usize;
    let mut flags = vec![false; components.components().len() + 1];
    for component in components.components() {
        let label = component.label as usize;
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let thin_thickness = (dpi.max(1.0) * RULE_THIN_THICKNESS_MM / 25.4)
            .round()
            .max(2.0) as usize;
        let aspect_floor = if height <= thin_thickness { 4 } else { 8 };
        let geometry = width >= minimum_span
            && width >= height.saturating_mul(aspect_floor)
            && height <= maximum_thickness;
        let raw_support = raw_dark_pixels[label] >= minimum_span
            && raw_dark_pixels[label].saturating_mul(2) >= component.area;
        flags[label] = geometry && raw_support;
    }
    flags
}

fn despeckle_connected_impl(
    source: &BinaryImage,
    normalized: Option<&GrayImage>,
    dpi: f64,
    calibration: PageCalibration,
    level: DespeckleLevel,
    use_attachment_graph: bool,
) -> DespeckleOutcome {
    despeckle_connected_impl_with_protection(
        source,
        normalized,
        None,
        dpi,
        calibration,
        level,
        use_attachment_graph,
    )
}

fn despeckle_connected_impl_with_protection(
    source: &BinaryImage,
    normalized: Option<&GrayImage>,
    protected_rule_components: Option<&[bool]>,
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
    if let Some(protected) = protected_rule_components {
        debug_assert_eq!(protected.len(), components.components().len() + 1);
        for component in components.components() {
            let label = component.label as usize;
            if protected[label] {
                keep[label] = true;
            }
        }
    }
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
    fn spread_plan_is_symmetric_and_overrides_leaf_route_selection() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let mut left = GrayImage::new(256, 256, 242);
        let mut right = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    left.set(x, y, 54);
                    right.set(x, y, if x < 128 { 54 } else { 92 });
                }
            }
        }
        let mut normalized = GrayImage::new(512, 256, 242);
        for y in 0..256 {
            for x in 0..256 {
                normalized.set(x, y, left.get(x, y));
                normalized.set(x + 256, y, right.get(x, y));
            }
        }
        let calibration =
            PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &normalized,
            &left,
            &right,
            None,
            None,
            None,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );
        let swapped = resolve_spread_binarization_plans(
            &normalized,
            &right,
            &left,
            None,
            None,
            None,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(plans.left.route(), swapped.right.route());
        assert_eq!(plans.right.route(), swapped.left.route());
        assert_eq!(plans.left.threshold_anchor, swapped.right.threshold_anchor);
        assert_eq!(plans.left.threshold_radius, 27);
        assert_eq!(plans.left.threshold_radius, swapped.right.threshold_radius);
        assert!(plans.left.diagnostics.document_anchor);
        assert_eq!(
            plans.left.diagnostics.left_candidate_route,
            swapped.right.diagnostics.right_candidate_route
        );
        assert_eq!(
            plans.left.diagnostics.right_candidate_route,
            swapped.right.diagnostics.left_candidate_route
        );

        let (_, left_diagnostics, _, _) = binarize_normalized_with_diagnostics(
            &left,
            &left,
            &left,
            None,
            &options,
            calibration,
            None,
            None,
            Some(&plans.left),
        );
        let (_, right_diagnostics, _, _) = binarize_normalized_with_diagnostics(
            &right,
            &right,
            &right,
            None,
            &options,
            calibration,
            None,
            None,
            Some(&plans.right),
        );
        assert_eq!(left_diagnostics.route, plans.left.route());
        assert_eq!(right_diagnostics.route, plans.right.route());
        assert_eq!(
            left_diagnostics.spread_plan.unwrap().threshold_radius,
            plans.left.threshold_radius
        );
        assert_eq!(
            right_diagnostics.spread_plan.unwrap().threshold_radius,
            plans.right.threshold_radius
        );
    }

    #[test]
    fn spread_plan_falls_back_to_leaf_anchors_when_threshold_evidence_drifts() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let mut left = GrayImage::new(256, 256, 242);
        let mut right = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    left.set(x, y, 48);
                    right.set(x, y, 156);
                }
            }
        }
        let mut normalized = GrayImage::new(512, 256, 242);
        for y in 0..256 {
            for x in 0..256 {
                normalized.set(x, y, left.get(x, y));
                normalized.set(x + 256, y, right.get(x, y));
            }
        }
        let calibration =
            PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &normalized,
            &left,
            &right,
            None,
            None,
            None,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(plans.left.route(), BinarizationMode::Otsu);
        assert_eq!(plans.right.route(), BinarizationMode::Otsu);
        assert_eq!(
            plans.left.diagnostics.decision,
            SpreadBinarizationPlanDecision::PerLeafAnchorDrift
        );
        assert_eq!(
            plans.right.diagnostics.decision,
            SpreadBinarizationPlanDecision::PerLeafAnchorDrift
        );
        assert_ne!(
            plans.left.threshold_anchor, plans.right.threshold_anchor,
            "the fallback must retain each leaf's measured threshold anchor"
        );
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

    fn faint_text_fixture() -> (GrayImage, BinaryImage) {
        let mut raw = GrayImage::new(240, 100, 232);
        let mut text_vicinity = BinaryImage::new(240, 100);
        for y in 34..49 {
            text_vicinity.set(20, y, true);
            for x in 20..220 {
                if x % 19 < 2 {
                    raw.set(x, y, 198);
                }
            }
        }
        (raw, text_vicinity)
    }

    #[test]
    fn explicit_wolf_and_sauvola_rescue_faint_text_rows_dropped_by_thresholding() {
        let (raw, text_vicinity) = faint_text_fixture();
        let normalized = GrayImage::new(raw.width(), raw.height(), 232);
        for mode in [BinarizationMode::Wolf, BinarizationMode::Sauvola] {
            let options = CleanupOptions {
                dpi: 300.0,
                binarization: mode,
                normalize_illumination: false,
                despeckle: false,
                ..CleanupOptions::default()
            };
            let calibration =
                PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
            let damaged = postprocess_binary_with_raw(
                &threshold_with_mode(
                    &normalized,
                    &normalized,
                    None,
                    &options,
                    mode,
                    calibration,
                    None,
                ),
                Some(&normalized),
                Some(&normalized),
                &options,
                calibration,
            );
            assert!(!damaged.get(38, 40));
            let (routed, diagnostics, _, _) = binarize_normalized_with_diagnostics(
                &normalized,
                &raw,
                &raw,
                None,
                &options,
                calibration,
                None,
                Some(&text_vicinity),
                None,
            );
            assert_eq!(diagnostics.route, mode);
            assert!(
                routed.get(38, 40),
                "{mode:?} binarizer did not recover the row-aligned faint stroke"
            );
            let rescued = rescue_component_scoped_faint_strokes(
                &damaged,
                &raw,
                None,
                Some(&text_vicinity),
                None,
                mode,
                mode,
                options.dpi,
                false,
            );
            assert!(
                rescued.get(38, 40),
                "{mode:?} did not recover the row-aligned faint stroke"
            );
            assert!(rescued.count_black() > damaged.count_black());
        }
    }

    #[test]
    fn postprocess_exempts_a_raw_supported_horizontal_rule_component() {
        let mut raw = GrayImage::new(420, 120, 220);
        let mut binary = BinaryImage::new(420, 120);
        for y in 58..60 {
            for x in 48..372 {
                raw.set(x, y, 120);
                binary.set(x, y, true);
            }
        }
        // A nearby isolated mark remains eligible for normal despeckling; the
        // rule exemption must not turn the whole page into a pass-through.
        raw.set(12, 12, 210);
        binary.set(12, 12, true);
        let options = CleanupOptions {
            dpi: 300.0,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&raw, options.dpi, CalibrationConfig::default());
        let (cleaned, _) = postprocess_binary_with_diagnostics_and_raw(
            &binary,
            Some(&raw),
            Some(&raw),
            &options,
            calibration,
        );

        assert!((48..372).all(|x| (58..60).all(|y| cleaned.get(x, y))));
        assert!(
            !cleaned.get(12, 12),
            "ordinary speckle must remain removable"
        );
    }

    #[test]
    fn faint_rescue_rejects_an_isolated_raw_component_without_a_text_row() {
        let mut raw = GrayImage::new(160, 100, 232);
        for y in 45..70 {
            for x in 84..108 {
                raw.set(x, y, 198);
            }
        }
        let damaged = BinaryImage::new(160, 100);
        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );
        assert_eq!(rescued.count_black(), 0);
    }

    #[test]
    fn faint_rescue_skips_a_solid_stroke_component_with_a_full_gray_halo() {
        let mut raw = GrayImage::new(120, 80, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 23..57 {
            for x in 49..56 {
                raw.set(x, y, 170);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 24..56 {
            for x in 50..55 {
                raw.set(x, y, 40);
                damaged.set(x, y, true);
            }
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Otsu,
            BinarizationMode::Otsu,
            300.0,
            true,
        );

        assert_eq!(
            rescued, damaged,
            "a healthy stroke's halo must not become ink"
        );
    }

    #[test]
    fn faint_rescue_keeps_a_pale_captured_skeleton_with_a_deep_missing_body() {
        let mut raw = GrayImage::new(120, 80, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 24..56 {
            for x in 50..56 {
                raw.set(x, y, 60);
                text_vicinity.set(x, y, true);
            }
            raw.set(52, y, 90);
            damaged.set(52, y, true);
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Otsu,
            BinarizationMode::Otsu,
            300.0,
            true,
        );

        assert!(rescued.get(50, 40));
        assert!(rescued.get(55, 40));
        assert!(rescued.count_black() > damaged.count_black());
    }

    #[test]
    fn row_evidence_exclusion_prevents_a_scanner_rail_from_supporting_specks() {
        let mut raw = GrayImage::new(160, 100, 232);
        let mut rail = BinaryImage::new(160, 100);
        for y in 0..raw.height() {
            for x in 0..8 {
                raw.set(x, y, 80);
                rail.set(x, y, true);
            }
        }
        for y in 48..52 {
            for x in 84..86 {
                raw.set(x, y, 198);
            }
        }
        let damaged = BinaryImage::new(raw.width(), raw.height());
        let rescued_with_rail = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );
        let rescued_without_rail = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            Some(&rail),
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        assert!(
            rescued_with_rail.get(84, 49),
            "the fixture must prove that the unmasked rail supplies row evidence",
        );
        assert_eq!(rescued_without_rail.count_black(), 0);
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
                None,
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

        let (cleaned, fallback) = postprocess_binary_with_diagnostics_and_raw(
            &binary,
            Some(&normalized),
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
    fn page_edge_smoothing_rejects_legacy_dilation_over_eight_percent() {
        let mut image = BinaryImage::new(96, 96);
        for y in 16..80 {
            for x in 20..33 {
                image.set(x, y, true);
            }
            if y % 2 == 0 {
                image.set(20, y, false);
                image.set(32, y, false);
            }
        }
        assert_eq!(resolve_smooth_profile(&image, 300.0), SmoothProfile::Legacy);

        let source_ink = image.count_black();
        let legacy = smooth_edges_with_profile(&image, SmoothProfile::Legacy);
        assert!(smoothing_exceeds_ink_growth_limit(
            source_ink,
            legacy.count_black()
        ));
        let topology_safe = smooth_edges_with_profile(&image, SmoothProfile::TopologySafe);
        let expected =
            if smoothing_exceeds_ink_growth_limit(source_ink, topology_safe.count_black()) {
                image.clone()
            } else {
                topology_safe
            };

        assert_eq!(smooth_edges_for_page(&image, 300.0), expected);
    }

    #[test]
    fn page_edge_smoothing_passes_through_neutral_legacy_result() {
        let mut image = BinaryImage::new(48, 48);
        for y in 12..36 {
            for x in 12..36 {
                image.set(x, y, true);
            }
        }
        assert_eq!(resolve_smooth_profile(&image, 300.0), SmoothProfile::Legacy);

        let legacy = smooth_edges_with_profile(&image, SmoothProfile::Legacy);
        assert_eq!(legacy, image);
        assert_eq!(smooth_edges_for_page(&image, 300.0), legacy);
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
