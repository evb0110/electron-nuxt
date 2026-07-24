use crate::corpus::{inventory, CorpusEntry, Origin, PixelRect};
use evb_scan_cleanup::{
    auto_dewarp::detect_curves_at_dpi,
    bw::{
        clean_black_and_white_with_calibration_config, despeckle_connected_with_calibration_config,
    },
    calibration::CalibrationConfig,
    dewarp::DewarpModel,
    engine::render::clean_page_with_calibration_config,
    split::LayoutClassification,
    BinarizationMode,
};
use scan_primitives::{BinaryImage, ComponentMap, Point, Rect};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

const CONFIDENT_SKEW_THRESHOLD: f64 = 2.0;
const WRONG_SKEW_ERROR_DEGREES: f64 = 1.0;
const CONTENT_LOSS_FRACTION: f64 = 0.01;
const BLANK_FLOOD_DENSITY: f64 = 0.05;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReport {
    pub comparable: ComparableReport,
    pub non_comparable: NonComparableReport,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparableReport {
    pub schema_version: u32,
    pub corpus: CorpusInventory,
    pub catastrophes: BTreeMap<String, BTreeMap<String, u64>>,
    pub metrics: MetricReport,
    pub stub_hooks: StubHooks,
}

impl ComparableReport {
    pub fn total_catastrophes(&self) -> u64 {
        self.catastrophes
            .values()
            .flat_map(|category| category.values())
            .sum()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusInventory {
    pub total: usize,
    pub real: usize,
    pub synthetic: usize,
    pub real_categories: BTreeMap<String, usize>,
    pub synthetic_categories: BTreeMap<String, usize>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricReport {
    pub split: SplitMetrics,
    pub deskew: DeskewMetrics,
    pub content: ContentMetrics,
    pub despeckle: DespeckleMetrics,
    pub binarization: BinarizationMetrics,
    #[serde(default)]
    pub dewarp: DewarpMetrics,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitMetrics {
    pub evaluated: usize,
    pub correct: usize,
    pub accuracy: f64,
    pub offcut_evaluated: usize,
    pub offcut_misclassifications: usize,
    pub cutter_evaluated: usize,
    pub mean_cutter_error_px: f64,
    pub mean_cutter_error_width_fraction: f64,
    pub max_cutter_error_px: f64,
    pub misclassified_ids: Vec<String>,
    pub cutter_samples: Vec<CutterSample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutterSample {
    pub id: String,
    pub error_px: f64,
    pub error_width_fraction: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskewMetrics {
    pub evaluated: usize,
    pub accepted: usize,
    pub mean_angle_error_degrees: f64,
    pub max_angle_error_degrees: f64,
    pub confident_but_wrong: usize,
    pub samples: Vec<DeskewSample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskewSample {
    pub id: String,
    pub expected_degrees: f64,
    pub detected_degrees: f64,
    pub confidence: f64,
    pub accepted: bool,
    pub error_degrees: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMetrics {
    pub evaluated: usize,
    pub mean_iou: f64,
    pub minimum_iou: f64,
    pub lost_ink_pixels: u64,
    pub content_lost_outside_crop: usize,
    pub samples: Vec<ContentSample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSample {
    pub id: String,
    pub iou: f64,
    pub truth_ink_pixels: usize,
    pub lost_ink_pixels: usize,
    pub lost_ink_fraction: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DespeckleMetrics {
    pub pages_evaluated: usize,
    pub punctuation_markers: usize,
    pub retained_punctuation_markers: usize,
    pub retained_punctuation_rate: f64,
    pub erased_pages: usize,
    pub erased_page_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarizationMetrics {
    pub pages_evaluated: usize,
    pub component_pages_evaluated: usize,
    pub expected_components: u64,
    pub output_components: u64,
    pub component_count_delta: i64,
    pub broken_stroke_delta: u64,
    pub broken_stroke_explosions: usize,
    pub blank_pixels_evaluated: u64,
    pub pepper_pixels: u64,
    pub pepper_density: f64,
    pub blank_region_floods: usize,
    pub route_counts: BTreeMap<String, usize>,
    pub broken_stroke_explosion_ids: Vec<String>,
    pub blank_region_flood_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpMetrics {
    pub curled_evaluated: usize,
    pub curled_models_detected: usize,
    pub curled_non_improvements: usize,
    pub identity_mean_residual_px: f64,
    pub dewarped_mean_residual_px: f64,
    pub residual_improvement_fraction: f64,
    pub flat_guard_evaluated: usize,
    pub flat_guard_models: usize,
    pub photo_sparse_guard_evaluated: usize,
    pub photo_sparse_guard_models: usize,
    pub catastrophic_warps: usize,
    pub guard_model_ids: Vec<String>,
    pub samples: Vec<DewarpSample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpSample {
    pub id: String,
    pub model_detected: bool,
    pub identity_residual_px: f64,
    pub dewarped_residual_px: f64,
    pub improvement_fraction: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StubHooks {
    pub ocr_proxy: String,
    pub curled_truth_fixtures: usize,
    pub curled_truth_amplitudes_px: Vec<f64>,
    pub curled_truth_baseline_count: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonComparableReport {
    pub performance: PerformanceMetrics,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMetrics {
    pub rayon_threads: usize,
    pub total_wall_time_ms: f64,
    pub mean_wall_time_ms_per_page: f64,
    pub pages: Vec<PageTiming>,
    pub auto_dewarp: AutoDewarpTiming,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoDewarpTiming {
    pub pages: usize,
    pub total_wall_time_ms: f64,
    pub mean_wall_time_ms_per_page: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTiming {
    pub id: String,
    pub wall_time_ms: f64,
}

#[derive(Default)]
struct SplitAccumulator {
    evaluated: usize,
    correct: usize,
    offcut_evaluated: usize,
    offcut_misclassifications: usize,
    misclassified_ids: Vec<String>,
    cutter_samples: Vec<CutterSample>,
}

#[derive(Default)]
struct DeskewAccumulator {
    accepted: usize,
    confident_but_wrong: usize,
    samples: Vec<DeskewSample>,
}

#[derive(Default)]
struct ContentAccumulator {
    lost_ink_pixels: u64,
    content_lost_outside_crop: usize,
    samples: Vec<ContentSample>,
}

#[derive(Default)]
struct DespeckleAccumulator {
    pages_evaluated: usize,
    punctuation_markers: usize,
    retained_punctuation_markers: usize,
    erased_page_ids: Vec<String>,
}

#[derive(Default)]
struct BinarizationAccumulator {
    pages_evaluated: usize,
    component_pages_evaluated: usize,
    expected_components: u64,
    output_components: u64,
    component_count_delta: i64,
    broken_stroke_delta: u64,
    blank_pixels_evaluated: u64,
    pepper_pixels: u64,
    route_counts: BTreeMap<String, usize>,
    broken_stroke_explosion_ids: Vec<String>,
    blank_region_flood_ids: Vec<String>,
}

pub fn evaluate_corpus(
    entries: &[CorpusEntry],
    rayon_threads: usize,
    calibration: CalibrationConfig,
) -> Result<HarnessReport, String> {
    let (real_categories, synthetic_categories) = inventory(entries);
    let real = entries
        .iter()
        .filter(|entry| entry.origin == Origin::Real)
        .count();
    let mut split = SplitAccumulator::default();
    let mut deskew = DeskewAccumulator::default();
    let mut content = ContentAccumulator::default();
    let mut despeckle = DespeckleAccumulator::default();
    let mut binarization = BinarizationAccumulator::default();
    let mut timings = Vec::with_capacity(entries.len());

    for (index, entry) in entries.iter().enumerate() {
        let start = Instant::now();
        let rendered =
            clean_page_with_calibration_config(&entry.image, &entry.options, index, calibration)
                .map_err(|error| format!("{} pipeline failed: {error}", entry.id))?;
        timings.push(PageTiming {
            id: entry.id.clone(),
            wall_time_ms: start.elapsed().as_secs_f64() * 1_000.0,
        });

        evaluate_split(entry, &rendered, &mut split);
        if let Some(output) = rendered.outputs.first() {
            evaluate_deskew(entry, output, &mut deskew);
            evaluate_content(entry, output.metadata.content_box, &mut content);
        } else if entry.truth.skew_degrees.is_some() {
            record_missing_deskew(entry, &mut deskew);
        }
        evaluate_despeckle(entry, calibration, &mut despeckle);
        evaluate_binarization(entry, calibration, &mut binarization);
    }

    let split_metrics = finish_split(split);
    let deskew_metrics = finish_deskew(deskew);
    let content_metrics = finish_content(content);
    let despeckle_metrics = finish_despeckle(despeckle);
    let binarization_metrics = finish_binarization(binarization);
    let (dewarp_metrics, auto_dewarp_timing) = evaluate_dewarp(entries);
    let catastrophes = catastrophe_map(
        &split_metrics,
        &deskew_metrics,
        &content_metrics,
        &despeckle_metrics,
        &binarization_metrics,
        &dewarp_metrics,
    );
    let total_wall_time_ms = timings
        .iter()
        .map(|timing| timing.wall_time_ms)
        .sum::<f64>();
    let curled_truth_amplitudes_px = entries
        .iter()
        .filter_map(|entry| {
            entry
                .truth
                .warp
                .as_ref()
                .map(|warp| round6(warp.amplitude_px))
        })
        .collect::<Vec<_>>();
    let curled_truth_baseline_count = entries
        .iter()
        .filter_map(|entry| entry.truth.warp.as_ref())
        .map(|warp| warp.baseline_rows.len())
        .sum();

    Ok(HarnessReport {
        comparable: ComparableReport {
            schema_version: 2,
            corpus: CorpusInventory {
                total: entries.len(),
                real,
                synthetic: entries.len() - real,
                real_categories,
                synthetic_categories,
            },
            catastrophes,
            metrics: MetricReport {
                split: split_metrics,
                deskew: deskew_metrics,
                content: content_metrics,
                despeckle: despeckle_metrics,
                binarization: binarization_metrics,
                dewarp: dewarp_metrics,
            },
            stub_hooks: StubHooks {
                ocr_proxy: "stub: optional Tesseract CER is deferred".into(),
                curled_truth_fixtures: curled_truth_amplitudes_px.len(),
                curled_truth_amplitudes_px,
                curled_truth_baseline_count,
            },
        },
        non_comparable: NonComparableReport {
            performance: PerformanceMetrics {
                rayon_threads,
                total_wall_time_ms: round3(total_wall_time_ms),
                mean_wall_time_ms_per_page: round3(ratio(total_wall_time_ms, entries.len())),
                pages: timings
                    .into_iter()
                    .map(|timing| PageTiming {
                        wall_time_ms: round3(timing.wall_time_ms),
                        ..timing
                    })
                    .collect(),
                auto_dewarp: auto_dewarp_timing,
            },
        },
    })
}

pub fn compare_catastrophes(
    current: &ComparableReport,
    baseline: &ComparableReport,
) -> Result<Vec<String>, String> {
    let categories = current
        .catastrophes
        .keys()
        .chain(baseline.catastrophes.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut regressions = Vec::new();
    for category in categories {
        let current_counters = current.catastrophes.get(&category);
        let baseline_counters = baseline.catastrophes.get(&category);
        let counter_names = current_counters
            .into_iter()
            .flat_map(|counters| counters.keys())
            .chain(
                baseline_counters
                    .into_iter()
                    .flat_map(|counters| counters.keys()),
            )
            .cloned()
            .collect::<BTreeSet<_>>();
        for counter in counter_names {
            let current_value = current_counters
                .and_then(|counters| counters.get(&counter))
                .copied()
                .unwrap_or_default();
            let baseline_value = baseline_counters
                .and_then(|counters| counters.get(&counter))
                .copied()
                .unwrap_or_default();
            if current_value > baseline_value {
                regressions.push(format!(
                    "{category}.{counter}: {current_value} > baseline {baseline_value}"
                ));
            }
        }
    }
    Ok(regressions)
}

fn evaluate_split(
    entry: &CorpusEntry,
    rendered: &evb_scan_cleanup::engine::render::PageCleanupResult,
    accumulator: &mut SplitAccumulator,
) {
    let Some(expected) = entry.truth.layout else {
        return;
    };
    accumulator.evaluated += 1;
    if expected == LayoutClassification::PageWithOffcut {
        accumulator.offcut_evaluated += 1;
    }
    if rendered.classification == expected {
        accumulator.correct += 1;
    } else {
        accumulator.misclassified_ids.push(entry.id.clone());
        if expected == LayoutClassification::PageWithOffcut {
            accumulator.offcut_misclassifications += 1;
        }
    }
    if let (Some(expected_x), Some(actual_x)) = (entry.truth.cutter_x, rendered.cutter_x) {
        let error_px = (actual_x - expected_x).abs();
        accumulator.cutter_samples.push(CutterSample {
            id: entry.id.clone(),
            error_px: round6(error_px),
            error_width_fraction: round6(error_px / entry.image.width().max(1) as f64),
        });
    }
}

fn evaluate_deskew(
    entry: &CorpusEntry,
    output: &evb_scan_cleanup::engine::render::CleanupResult,
    accumulator: &mut DeskewAccumulator,
) {
    let Some(expected) = entry.truth.skew_degrees else {
        return;
    };
    let detected = output.metadata.detected_skew_degrees;
    let error = (detected - expected).abs();
    let accepted = output.metadata.skew_confidence >= CONFIDENT_SKEW_THRESHOLD;
    if accepted {
        accumulator.accepted += 1;
    }
    if accepted && error > WRONG_SKEW_ERROR_DEGREES {
        accumulator.confident_but_wrong += 1;
    }
    accumulator.samples.push(DeskewSample {
        id: entry.id.clone(),
        expected_degrees: round6(expected),
        detected_degrees: round6(detected),
        confidence: round6(output.metadata.skew_confidence),
        accepted,
        error_degrees: round6(error),
    });
}

fn record_missing_deskew(entry: &CorpusEntry, accumulator: &mut DeskewAccumulator) {
    let expected = entry.truth.skew_degrees.unwrap_or_default();
    accumulator.samples.push(DeskewSample {
        id: entry.id.clone(),
        expected_degrees: round6(expected),
        detected_degrees: 0.0,
        confidence: 0.0,
        accepted: false,
        error_degrees: round6(expected.abs()),
    });
}

fn evaluate_content(
    entry: &CorpusEntry,
    detected: Option<Rect>,
    accumulator: &mut ContentAccumulator,
) {
    if entry.truth.layout != Some(LayoutClassification::SingleUncutPage) {
        return;
    }
    let (Some(expected_box), Some(mask)) = (entry.truth.content_box, &entry.truth.content_mask)
    else {
        return;
    };
    if mask.count_black() == 0 {
        return;
    }
    let iou = detected.map_or(0.0, |rect| rect_iou(expected_box, rect));
    let lost = mask_pixels_outside(mask, detected);
    let truth_pixels = mask.count_black();
    let lost_fraction = lost as f64 / truth_pixels.max(1) as f64;
    let loss_limit = ((truth_pixels as f64 * CONTENT_LOSS_FRACTION).ceil() as usize).max(4);
    if lost > loss_limit {
        accumulator.content_lost_outside_crop += 1;
    }
    accumulator.lost_ink_pixels += lost as u64;
    accumulator.samples.push(ContentSample {
        id: entry.id.clone(),
        iou: round6(iou),
        truth_ink_pixels: truth_pixels,
        lost_ink_pixels: lost,
        lost_ink_fraction: round6(lost_fraction),
    });
}

fn evaluate_despeckle(
    entry: &CorpusEntry,
    calibration: CalibrationConfig,
    accumulator: &mut DespeckleAccumulator,
) {
    let Some(source) = &entry.truth.content_mask else {
        return;
    };
    if source.count_black() == 0 {
        return;
    }
    accumulator.pages_evaluated += 1;
    let cleaned = despeckle_connected_with_calibration_config(source, entry.dpi, calibration);
    if cleaned.count_black() == 0 {
        accumulator.erased_page_ids.push(entry.id.clone());
    }
    for marker in &entry.truth.punctuation {
        if has_ink_near(source, marker.x, marker.y, marker.radius) {
            accumulator.punctuation_markers += 1;
            if has_ink_near(&cleaned, marker.x, marker.y, marker.radius) {
                accumulator.retained_punctuation_markers += 1;
            }
        }
    }
}

fn evaluate_binarization(
    entry: &CorpusEntry,
    calibration: CalibrationConfig,
    accumulator: &mut BinarizationAccumulator,
) {
    let mut options = entry.options.clone();
    options.despeckle = false;
    let result = clean_black_and_white_with_calibration_config(&entry.image, &options, calibration);
    accumulator.pages_evaluated += 1;
    *accumulator
        .route_counts
        .entry(binarization_name(result.mode).into())
        .or_default() += 1;

    if let Some(expected_components) = entry.truth.expected_components {
        accumulator.component_pages_evaluated += 1;
        let output_components = ComponentMap::from_binary(&result.binary).components().len();
        let delta = output_components as i64 - expected_components as i64;
        let broken_delta = output_components.saturating_sub(expected_components);
        accumulator.expected_components += expected_components as u64;
        accumulator.output_components += output_components as u64;
        accumulator.component_count_delta += delta;
        accumulator.broken_stroke_delta += broken_delta as u64;
        let explosion_limit = (expected_components / 2).max(10);
        if broken_delta > explosion_limit {
            accumulator
                .broken_stroke_explosion_ids
                .push(entry.id.clone());
        }
    }

    if !entry.truth.blank_regions.is_empty() {
        let (blank_pixels, pepper_pixels) =
            pepper_counts(&result.binary, &entry.truth.blank_regions);
        accumulator.blank_pixels_evaluated += blank_pixels;
        accumulator.pepper_pixels += pepper_pixels;
        if blank_pixels > 0 && pepper_pixels as f64 / blank_pixels as f64 > BLANK_FLOOD_DENSITY {
            accumulator.blank_region_flood_ids.push(entry.id.clone());
        }
    }
}

fn finish_split(accumulator: SplitAccumulator) -> SplitMetrics {
    let cutter_evaluated = accumulator.cutter_samples.len();
    let total_px = accumulator
        .cutter_samples
        .iter()
        .map(|sample| sample.error_px)
        .sum::<f64>();
    let total_fraction = accumulator
        .cutter_samples
        .iter()
        .map(|sample| sample.error_width_fraction)
        .sum::<f64>();
    let maximum = accumulator
        .cutter_samples
        .iter()
        .map(|sample| sample.error_px)
        .fold(0.0, f64::max);
    SplitMetrics {
        evaluated: accumulator.evaluated,
        correct: accumulator.correct,
        accuracy: round6(ratio(accumulator.correct as f64, accumulator.evaluated)),
        offcut_evaluated: accumulator.offcut_evaluated,
        offcut_misclassifications: accumulator.offcut_misclassifications,
        cutter_evaluated,
        mean_cutter_error_px: round6(ratio(total_px, cutter_evaluated)),
        mean_cutter_error_width_fraction: round6(ratio(total_fraction, cutter_evaluated)),
        max_cutter_error_px: round6(maximum),
        misclassified_ids: accumulator.misclassified_ids,
        cutter_samples: accumulator.cutter_samples,
    }
}

fn finish_deskew(accumulator: DeskewAccumulator) -> DeskewMetrics {
    let evaluated = accumulator.samples.len();
    let total = accumulator
        .samples
        .iter()
        .map(|sample| sample.error_degrees)
        .sum::<f64>();
    let maximum = accumulator
        .samples
        .iter()
        .map(|sample| sample.error_degrees)
        .fold(0.0, f64::max);
    DeskewMetrics {
        evaluated,
        accepted: accumulator.accepted,
        mean_angle_error_degrees: round6(ratio(total, evaluated)),
        max_angle_error_degrees: round6(maximum),
        confident_but_wrong: accumulator.confident_but_wrong,
        samples: accumulator.samples,
    }
}

fn finish_content(accumulator: ContentAccumulator) -> ContentMetrics {
    let evaluated = accumulator.samples.len();
    let total_iou = accumulator
        .samples
        .iter()
        .map(|sample| sample.iou)
        .sum::<f64>();
    let minimum_iou = accumulator
        .samples
        .iter()
        .map(|sample| sample.iou)
        .reduce(f64::min)
        .unwrap_or_default();
    ContentMetrics {
        evaluated,
        mean_iou: round6(ratio(total_iou, evaluated)),
        minimum_iou: round6(minimum_iou),
        lost_ink_pixels: accumulator.lost_ink_pixels,
        content_lost_outside_crop: accumulator.content_lost_outside_crop,
        samples: accumulator.samples,
    }
}

fn finish_despeckle(accumulator: DespeckleAccumulator) -> DespeckleMetrics {
    DespeckleMetrics {
        pages_evaluated: accumulator.pages_evaluated,
        punctuation_markers: accumulator.punctuation_markers,
        retained_punctuation_markers: accumulator.retained_punctuation_markers,
        retained_punctuation_rate: round6(ratio(
            accumulator.retained_punctuation_markers as f64,
            accumulator.punctuation_markers,
        )),
        erased_pages: accumulator.erased_page_ids.len(),
        erased_page_ids: accumulator.erased_page_ids,
    }
}

fn finish_binarization(accumulator: BinarizationAccumulator) -> BinarizationMetrics {
    BinarizationMetrics {
        pages_evaluated: accumulator.pages_evaluated,
        component_pages_evaluated: accumulator.component_pages_evaluated,
        expected_components: accumulator.expected_components,
        output_components: accumulator.output_components,
        component_count_delta: accumulator.component_count_delta,
        broken_stroke_delta: accumulator.broken_stroke_delta,
        broken_stroke_explosions: accumulator.broken_stroke_explosion_ids.len(),
        blank_pixels_evaluated: accumulator.blank_pixels_evaluated,
        pepper_pixels: accumulator.pepper_pixels,
        pepper_density: round6(ratio(
            accumulator.pepper_pixels as f64,
            accumulator.blank_pixels_evaluated as usize,
        )),
        blank_region_floods: accumulator.blank_region_flood_ids.len(),
        route_counts: accumulator.route_counts,
        broken_stroke_explosion_ids: accumulator.broken_stroke_explosion_ids,
        blank_region_flood_ids: accumulator.blank_region_flood_ids,
    }
}

fn evaluate_dewarp(entries: &[CorpusEntry]) -> (DewarpMetrics, AutoDewarpTiming) {
    let mut metrics = DewarpMetrics::default();
    let mut analysis_pages = 0usize;
    let mut total_wall_time_ms = 0.0;
    for entry in entries
        .iter()
        .filter(|entry| entry.origin == Origin::Synthetic)
    {
        let is_curled = entry.truth.warp.is_some();
        let is_flat_guard = !is_curled;
        let is_photo_sparse = entry.categories.iter().any(|category| {
            matches!(
                category.as_str(),
                "halftone-photo" | "sparse-text" | "page-number-only"
            )
        });
        if !is_curled && !is_flat_guard && !is_photo_sparse {
            continue;
        }

        let start = Instant::now();
        let detection = detect_curves_at_dpi(&entry.image, entry.dpi);
        total_wall_time_ms += start.elapsed().as_secs_f64() * 1_000.0;
        analysis_pages += 1;

        if is_flat_guard {
            metrics.flat_guard_evaluated += 1;
            if detection.model.is_some() {
                metrics.flat_guard_models += 1;
                metrics.guard_model_ids.push(entry.id.clone());
            }
        }
        if is_photo_sparse {
            metrics.photo_sparse_guard_evaluated += 1;
            if detection.model.is_some() {
                metrics.photo_sparse_guard_models += 1;
                if !metrics.guard_model_ids.contains(&entry.id) {
                    metrics.guard_model_ids.push(entry.id.clone());
                }
            }
        }

        let Some(warp) = entry.truth.warp.as_ref() else {
            continue;
        };
        metrics.curled_evaluated += 1;
        let source_lines = warp
            .baseline_rows
            .iter()
            .map(|&baseline| {
                (0..=32)
                    .map(|step| {
                        let x = entry.image.width() as f64 * (0.15 + 0.7 * step as f64 / 32.0);
                        let normalized = (x - entry.image.width() as f64 * 0.5)
                            / (entry.image.width() as f64 * 0.5);
                        Point::new(x, baseline + warp.amplitude_px * normalized * normalized)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let identity_residual = source_lines
            .iter()
            .map(|line| straightness_residual(line))
            .sum::<f64>()
            / source_lines.len().max(1) as f64;
        let mut dewarped_residual = identity_residual;
        if let Some(options) = detection.model.as_ref() {
            metrics.curled_models_detected += 1;
            match DewarpModel::from_options(options) {
                Ok(model) => {
                    metrics.catastrophic_warps += model.sampled_jacobian_failures();
                    let mapped = source_lines
                        .iter()
                        .map(|line| {
                            line.iter()
                                .filter_map(|&point| model.map_source_to_unit_approx(point))
                                .map(|point| {
                                    Point::new(
                                        point.x * entry.image.width() as f64,
                                        point.y * entry.image.height() as f64,
                                    )
                                })
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>();
                    if mapped
                        .iter()
                        .all(|line| line.len() == source_lines[0].len())
                    {
                        dewarped_residual = mapped
                            .iter()
                            .map(|line| straightness_residual(line))
                            .sum::<f64>()
                            / mapped.len().max(1) as f64;
                    } else {
                        metrics.catastrophic_warps += 1;
                    }
                }
                Err(_) => metrics.catastrophic_warps += 1,
            }
        }
        let improvement = (identity_residual - dewarped_residual) / identity_residual.max(1e-9);
        if detection.model.is_none() || improvement <= 0.0 {
            metrics.curled_non_improvements += 1;
        }
        metrics.samples.push(DewarpSample {
            id: entry.id.clone(),
            model_detected: detection.model.is_some(),
            identity_residual_px: round6(identity_residual),
            dewarped_residual_px: round6(dewarped_residual),
            improvement_fraction: round6(improvement),
        });
    }
    metrics.guard_model_ids.sort();
    metrics.identity_mean_residual_px = round6(
        metrics
            .samples
            .iter()
            .map(|sample| sample.identity_residual_px)
            .sum::<f64>()
            / metrics.samples.len().max(1) as f64,
    );
    metrics.dewarped_mean_residual_px = round6(
        metrics
            .samples
            .iter()
            .map(|sample| sample.dewarped_residual_px)
            .sum::<f64>()
            / metrics.samples.len().max(1) as f64,
    );
    metrics.residual_improvement_fraction = round6(
        (metrics.identity_mean_residual_px - metrics.dewarped_mean_residual_px)
            / metrics.identity_mean_residual_px.max(1e-9),
    );
    (
        metrics,
        AutoDewarpTiming {
            pages: analysis_pages,
            total_wall_time_ms: round3(total_wall_time_ms),
            mean_wall_time_ms_per_page: round3(total_wall_time_ms / analysis_pages.max(1) as f64),
        },
    )
}

fn straightness_residual(points: &[Point]) -> f64 {
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
    points
        .iter()
        .map(|point| (point.y - (slope * point.x + intercept)).abs())
        .sum::<f64>()
        / points.len() as f64
}

fn catastrophe_map(
    split: &SplitMetrics,
    deskew: &DeskewMetrics,
    content: &ContentMetrics,
    despeckle: &DespeckleMetrics,
    binarization: &BinarizationMetrics,
    dewarp: &DewarpMetrics,
) -> BTreeMap<String, BTreeMap<String, u64>> {
    BTreeMap::from([
        (
            "binarization".into(),
            BTreeMap::from([
                (
                    "blankRegionFloods".into(),
                    binarization.blank_region_floods as u64,
                ),
                (
                    "brokenStrokeExplosions".into(),
                    binarization.broken_stroke_explosions as u64,
                ),
            ]),
        ),
        (
            "content".into(),
            BTreeMap::from([(
                "contentLostOutsideCrop".into(),
                content.content_lost_outside_crop as u64,
            )]),
        ),
        (
            "deskew".into(),
            BTreeMap::from([(
                "confidentButWrong".into(),
                deskew.confident_but_wrong as u64,
            )]),
        ),
        (
            "dewarp".into(),
            BTreeMap::from([
                ("catastrophicWarps".into(), dewarp.catastrophic_warps as u64),
                (
                    "curledNonImprovements".into(),
                    dewarp.curled_non_improvements as u64,
                ),
                ("flatPageModels".into(), dewarp.flat_guard_models as u64),
                (
                    "photoSparseModels".into(),
                    dewarp.photo_sparse_guard_models as u64,
                ),
            ]),
        ),
        (
            "despeckle".into(),
            BTreeMap::from([("erasedPages".into(), despeckle.erased_pages as u64)]),
        ),
        (
            "split".into(),
            BTreeMap::from([
                (
                    "classificationErrors".into(),
                    (split.evaluated - split.correct) as u64,
                ),
                (
                    "offcutMisclassifications".into(),
                    split.offcut_misclassifications as u64,
                ),
            ]),
        ),
    ])
}

fn rect_iou(left: Rect, right: Rect) -> f64 {
    let intersection_width = (left.right().min(right.right()) - left.x.max(right.x)).max(0.0);
    let intersection_height = (left.bottom().min(right.bottom()) - left.y.max(right.y)).max(0.0);
    let intersection = intersection_width * intersection_height;
    let union = left.width * left.height + right.width * right.height - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

fn mask_pixels_outside(mask: &BinaryImage, rect: Option<Rect>) -> usize {
    let Some(rect) = rect else {
        return mask.count_black();
    };
    let mut count = 0usize;
    for y in 0..mask.height() {
        for x in 0..mask.width() {
            if mask.get(x, y) && !rect.contains(Point::new(x as f64 + 0.5, y as f64 + 0.5)) {
                count += 1;
            }
        }
    }
    count
}

fn has_ink_near(image: &BinaryImage, x: usize, y: usize, radius: usize) -> bool {
    if image.width() == 0 || image.height() == 0 {
        return false;
    }
    (y.saturating_sub(radius)..=(y + radius).min(image.height() - 1)).any(|sample_y| {
        (x.saturating_sub(radius)..=(x + radius).min(image.width() - 1))
            .any(|sample_x| image.get(sample_x, sample_y))
    })
}

fn pepper_counts(image: &BinaryImage, regions: &[PixelRect]) -> (u64, u64) {
    let mut pixels = 0u64;
    let mut pepper = 0u64;
    for region in regions {
        for y in region.y..(region.y + region.height).min(image.height()) {
            for x in region.x..(region.x + region.width).min(image.width()) {
                pixels += 1;
                pepper += u64::from(image.get(x, y));
            }
        }
    }
    (pixels, pepper)
}

fn binarization_name(mode: BinarizationMode) -> &'static str {
    match mode {
        BinarizationMode::Otsu => "otsu",
        BinarizationMode::Sauvola => "sauvola",
        BinarizationMode::Wolf => "wolf",
        BinarizationMode::Auto => "auto",
    }
}

fn ratio(numerator: impl Into<f64>, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator.into() / denominator as f64
    }
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use evb_scan_cleanup::{engine::render::clean_page, OutputMode};

    #[test]
    fn catastrophe_budget_rejects_only_increases() {
        let baseline_json = include_str!("../../../harness-baseline.json");
        let baseline: ComparableReport = serde_json::from_str(baseline_json).unwrap();
        let equal: ComparableReport = serde_json::from_str(baseline_json).unwrap();
        assert!(compare_catastrophes(&equal, &baseline).unwrap().is_empty());

        let mut regressed: ComparableReport = serde_json::from_str(baseline_json).unwrap();
        *regressed
            .catastrophes
            .get_mut("despeckle")
            .unwrap()
            .get_mut("erasedPages")
            .unwrap() += 1;
        assert_eq!(
            compare_catastrophes(&regressed, &baseline).unwrap(),
            ["despeckle.erasedPages: 1 > baseline 0"]
        );
    }

    #[test]
    fn mixed_mode_probe_uses_the_synthetic_halftone_photo_fixture() {
        let corpus = crate::corpus::build_corpus().unwrap();
        let entry = corpus
            .iter()
            .find(|entry| entry.id == "synthetic-halftone-photo")
            .unwrap();
        let image = entry.image.downscale_to_fit(360, 480);
        let mut options = entry.options.clone();
        options.dpi = 150.0;
        options.output_mode = OutputMode::Mixed;
        let output = clean_page(&image, &options, 0).unwrap().outputs.remove(0);
        assert_eq!(output.metadata.output_mode, OutputMode::Mixed);
        let output_ref = &output.image;
        let text_black_pixels = (65..185)
            .flat_map(|y| (50..310).map(move |x| (x, y)))
            .filter(|&(x, y)| output_ref.get(x, y) == 0)
            .count();
        let photo_tonal_pixels = (215..360)
            .flat_map(|y| (80..280).map(move |x| (x, y)))
            .filter(|&(x, y)| !matches!(output_ref.get(x, y), 0 | 255))
            .count();
        assert!(text_black_pixels > 1_000);
        assert!(photo_tonal_pixels > 1_000);
    }
}
