use crate::adapters::single_ocr_cli::{invalid, optional_value, parse_options, required_path};
use crate::engine::render::{
    analyze_page_with_color_and_document_prior_cached, clean_detail_page_with_color,
    clean_page_with_color_and_document_prior_cached, downscale_rgb_to_dimensions,
};
use crate::mode_select::OutputModeRecommendationReason;
use crate::{
    cache::{ByteLru, PageCache, SourceFingerprint, StageCacheKey, DEFAULT_CACHE_BUDGET_BYTES},
    io::pbm,
    pipeline::{AnalysisOutputMetadata, CleanupMetadata, MatchedCanvasPolicy},
    png::{self, RgbImage},
    protocol::{
        manifest_v3::{
            CanvasScope, DocumentCanvas, ManifestV3, Operation, Page, PageOutput, RenderMode,
        },
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    CleanupOptions, OrthogonalRotation, OutputMode, PROTOCOL_VERSION,
};
use evb_native_support::{NativeError, NativeErrorCode, NativeErrorEnvelope};
use rayon::prelude::*;
use scan_primitives::GrayImage;
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

struct WrittenOutput {
    output_path: PathBuf,
    metadata_path: PathBuf,
    bilevel_output_path: Option<PathBuf>,
    background_output_path: Option<PathBuf>,
    foreground_mask_output_path: Option<PathBuf>,
    options: CleanupOptions,
    is_color: bool,
    half: crate::pipeline::PageHalf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageResultMetadata {
    source_page_index: usize,
    layout_classification: crate::split::LayoutClassification,
    layout_confidence: f64,
    cutter_x_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    rotation_degrees: OrthogonalRotation,
    canvas_scope: CanvasScope,
    excluded: bool,
    blank_outputs_skipped: usize,
    output_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    outputs: Vec<AnalysisOutputMetadata>,
    tier1_verdict: crate::split::LayoutClassification,
    reconciled: bool,
    cluster_agreement: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_prior: Option<crate::split::DocumentPrior>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_axis: Option<crate::engine::text_axis::TextAxisHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recommended_output_mode: Option<OutputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recommended_output_mode_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recommended_output_mode_reason: Option<OutputModeRecommendationReason>,
    #[serde(skip)]
    rotated_width: usize,
    #[serde(skip)]
    rotated_height: usize,
    #[serde(skip)]
    candidate_cutter_ratio: Option<f64>,
    #[serde(skip)]
    whitespace_score: f64,
    #[serde(skip)]
    reconciliation_eligible: bool,
    #[serde(skip)]
    tier1_confidence: f64,
}

struct PageRunResult {
    outputs: Vec<WrittenOutput>,
    metadata: PageResultMetadata,
    page_metadata_path: PathBuf,
    classification_only: bool,
    timings: PageStageTimings,
}

#[derive(Clone, Copy)]
struct Tier1Provenance {
    verdict: LayoutClassification,
    confidence: f64,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
}

fn manifest_cache() -> Arc<Mutex<ByteLru>> {
    Arc::new(Mutex::new(ByteLru::new(configured_cache_budget_bytes())))
}

fn page_cache_for(page: &Page, shared: &Arc<Mutex<ByteLru>>) -> Result<PageCache, NativeError> {
    let source = SourceFingerprint::from_path(&page.input_path, page.source_page_index)
        .map_err(map_image_error)?;
    Ok(PageCache::new(Arc::clone(shared), source))
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = args.into_iter().collect();
    if args.len() == 1 && args[0] == "--protocol-version" {
        println!("{PROTOCOL_VERSION}");
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--version" {
        println!("evb-scan-cleanup {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if let Some(index) = args.iter().position(|argument| argument == "--manifest") {
        let path = args
            .get(index + 1)
            .ok_or_else(|| invalid("--manifest requires a JSON path"))?;
        return run_manifest(Path::new(path));
    }
    let input = required_path(&args, "--input")?;
    let output = required_path(&args, "--output")?;
    let metadata = required_path(&args, "--metadata")?;
    let mut options = optional_value(&args, "--options")
        .map(parse_options)
        .transpose()?
        .unwrap_or_default();
    if args.iter().any(|argument| argument == "--ocr-mode") {
        options.ocr_mode = true;
    }
    if args
        .iter()
        .any(|argument| argument == "--experimental-auto-dewarp")
    {
        options.experimental.auto_dewarp = true;
    }
    let page = Page {
        input_path: input,
        outputs: Vec::new(),
        source_page_index: 0,
        page_metadata_path: metadata.clone(),
        options,
        document_prior: None,
        detail_render_plan: None,
    };
    let cache = manifest_cache();
    let page_cache = page_cache_for(&page, &cache)?;
    run_page(
        &page,
        CanvasScope::Page,
        false,
        Some((&output, &metadata)),
        &page_cache,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path) -> Result<(), Box<dyn Error>> {
    let bytes = fs::read(path)?;
    let manifest: ManifestV3 = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("Invalid v3 batch manifest: {error}")))?;
    manifest.validate()?;
    let total = manifest.pages.len();
    let result = run_manifest_inner(&manifest);
    match result {
        Ok(()) => {
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::success(total, total))?
            );
            Ok(())
        }
        Err(error) => {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::failure(&envelope))?
            );
            Err(error)
        }
    }
}

fn run_manifest_inner(manifest: &ManifestV3) -> Result<(), Box<dyn Error>> {
    write_progress(Progress {
        stage: ProgressStage::Started,
        completed_pages: 0,
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
    })?;
    let cache = manifest_cache();
    let analyzed_pages = Mutex::new((vec![false; manifest.pages.len()], 0usize));
    let report_analyzed = |index: usize| -> Result<(), NativeError> {
        let mut state = analyzed_pages.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page progress",
            )
        })?;
        state.0[index] = true;
        while state.1 < state.0.len() && state.0[state.1] {
            let page_index = state.1;
            state.1 += 1;
            write_progress(Progress {
                stage: ProgressStage::PageAnalyzed,
                completed_pages: state.1,
                total_pages: manifest.pages.len(),
                page_number: Some(page_index + 1),
                output_paths: None,
                classification: None,
                confidence: None,
                cutter_x_px: None,
                tier1_verdict: None,
                reconciled: None,
                cluster_agreement: None,
                document_prior: None,
                text_axis: None,
                stage_timings: None,
                recommended_output_mode: None,
                recommended_output_mode_confidence: None,
                recommended_output_mode_reason: None,
            })
            .map_err(|error| {
                NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Unable to publish scan-cleanup page progress: {error}"),
                )
            })?;
        }
        Ok(())
    };
    let run_analysis = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        let result = run_classification(
            page,
            manifest.canvas_scope,
            page.document_prior,
            &page_cache,
        )
        .map_err(|error| {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            NativeError::new(envelope.code, envelope.message)
        })?;
        report_analyzed(index)?;
        Ok(result)
    };
    let run_one = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        run_manifest_page(manifest, page, index, &page_cache).map_err(|error| {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            NativeError::new(envelope.code, envelope.message)
        })
    };
    let page_results = if manifest.operation == Operation::Analyze {
        run_page_jobs(manifest, run_analysis)?
    } else {
        if manifest.render_mode == RenderMode::Final {
            run_page_jobs(manifest, run_analysis)?;
        }
        run_page_jobs(manifest, run_one)?
    };

    let mut page_results = page_results;
    reconcile_classification_batch(manifest, &mut page_results, &cache)?;
    let mut written_outputs = Vec::new();
    for (index, page_result) in page_results.into_iter().enumerate() {
        if let Err(error) =
            write_json_atomic(&page_result.page_metadata_path, &page_result.metadata)
        {
            for output in &page_result.outputs {
                let _ = fs::remove_file(&output.output_path);
                let _ = fs::remove_file(&output.metadata_path);
                if let Some(bilevel_path) = &output.bilevel_output_path {
                    let _ = fs::remove_file(bilevel_path);
                }
                if let Some(background_path) = &output.background_output_path {
                    let _ = fs::remove_file(background_path);
                }
                if let Some(mask_path) = &output.foreground_mask_output_path {
                    let _ = fs::remove_file(mask_path);
                }
            }
            let _ = fs::remove_file(&page_result.page_metadata_path);
            return Err(error);
        }
        let output_paths = page_result
            .outputs
            .iter()
            .map(|output| output.output_path.clone())
            .collect::<Vec<_>>();
        written_outputs.extend(page_result.outputs);
        write_progress(Progress {
            stage: ProgressStage::PageComplete,
            completed_pages: index + 1,
            total_pages: manifest.pages.len(),
            page_number: Some(index + 1),
            output_paths: Some(output_paths),
            classification: Some(page_result.metadata.layout_classification),
            confidence: Some(page_result.metadata.layout_confidence),
            cutter_x_px: (page_result.metadata.layout_classification
                == crate::split::LayoutClassification::TwoPageSpread)
                .then_some(page_result.metadata.cutter_x_px)
                .flatten(),
            tier1_verdict: Some(page_result.metadata.tier1_verdict),
            reconciled: Some(page_result.metadata.reconciled),
            cluster_agreement: Some(page_result.metadata.cluster_agreement),
            document_prior: page_result.metadata.document_prior,
            text_axis: page_result.metadata.text_axis,
            stage_timings: (!page_result.timings.is_empty()).then_some(page_result.timings),
            recommended_output_mode: page_result.metadata.recommended_output_mode,
            recommended_output_mode_confidence: page_result
                .metadata
                .recommended_output_mode_confidence,
            recommended_output_mode_reason: page_result.metadata.recommended_output_mode_reason,
        })?;
    }
    match_page_sizes(
        &written_outputs,
        manifest.render_mode == RenderMode::Preview,
        manifest.document_canvas,
    )?;
    write_progress(Progress {
        stage: ProgressStage::Completed,
        completed_pages: manifest.pages.len(),
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
    })?;
    Ok(())
}

fn run_page_jobs<T, F>(manifest: &ManifestV3, task: F) -> Result<Vec<T>, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &Page)) -> Result<T, NativeError> + Send + Sync,
{
    let results = if manifest.pages.len() > 1 && pages_have_disjoint_destinations(manifest) {
        let worker_threads = manifest_worker_threads(manifest)?;
        rayon::ThreadPoolBuilder::new()
            .num_threads(worker_threads)
            .thread_name(|index| format!("scan-cleanup-page-{index}"))
            .build()
            .map_err(|error| invalid(format!("Unable to initialize page workers: {error}")))?
            .install(|| {
                manifest
                    .pages
                    .par_iter()
                    .enumerate()
                    .map(&task)
                    .collect::<Vec<_>>()
            })
    } else {
        manifest.pages.iter().enumerate().map(task).collect()
    };
    results
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn reconcile_classification_batch(
    manifest: &ManifestV3,
    results: &mut [PageRunResult],
    cache: &Arc<Mutex<ByteLru>>,
) -> Result<(), Box<dyn Error>> {
    let eligible = results
        .iter()
        .enumerate()
        .filter(|(_, result)| {
            result.classification_only
                && result.metadata.reconciliation_eligible
                && result.metadata.document_prior.is_none()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for index in eligible {
        let metadata = &results[index].metadata;
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            let representative = &results[cluster[0]].metadata;
            dimensions_within_tolerance(metadata.rotated_width, representative.rotated_width)
                && dimensions_within_tolerance(
                    metadata.rotated_height,
                    representative.rotated_height,
                )
        }) {
            cluster.push(index);
        } else {
            clusters.push(vec![index]);
        }
    }

    for cluster in clusters {
        let confident = cluster
            .iter()
            .copied()
            .filter(|&index| results[index].metadata.tier1_confidence >= 0.60)
            .collect::<Vec<_>>();
        let mut support = [0usize; 3];
        let mut confidence_sum = [0.0; 3];
        for &index in &confident {
            let metadata = &results[index].metadata;
            let bucket = classification_bucket(metadata.tier1_verdict);
            support[bucket] += 1;
            confidence_sum[bucket] += metadata.tier1_confidence;
        }
        let Some(dominant_bucket) = (0..support.len())
            .filter(|&bucket| support[bucket] >= 2)
            .max_by(|&left, &right| {
                support[left]
                    .cmp(&support[right])
                    .then_with(|| confidence_sum[left].total_cmp(&confidence_sum[right]))
            })
        else {
            continue;
        };
        let tied = (0..support.len()).any(|bucket| {
            bucket != dominant_bucket
                && support[bucket] == support[dominant_bucket]
                && (confidence_sum[bucket] - confidence_sum[dominant_bucket]).abs() < 1e-9
        });
        if tied {
            continue;
        }
        let dominant_layout = bucket_classification(dominant_bucket);
        let dominant_count = support[dominant_bucket];
        let consensus = dominant_count as f64 / confident.len().max(1) as f64;
        let mean_confidence = confidence_sum[dominant_bucket] / dominant_count as f64;
        let mut cutter_ratios = confident
            .iter()
            .filter_map(|&index| {
                let metadata = &results[index].metadata;
                (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                    .then_some(metadata.cutter_x_px)
                    .flatten()
                    .map(|cutter| cutter / metadata.rotated_width.max(1) as f64)
            })
            .collect::<Vec<_>>();
        cutter_ratios.sort_by(f64::total_cmp);
        let cutter_ratio_median = (dominant_layout == LayoutClassification::TwoPageSpread)
            .then(|| median(&cutter_ratios))
            .flatten();
        if dominant_layout == LayoutClassification::TwoPageSpread && cutter_ratio_median.is_none() {
            continue;
        }
        let cutter_spread = cutter_ratios
            .first()
            .zip(cutter_ratios.last())
            .map_or(0.0, |(first, last)| last - first);
        let cutter_consistency = 1.0 - ramp_local(cutter_spread, 0.03, 0.12) * 0.40;
        let agreement_strength =
            (consensus * (0.65 + 0.25 * mean_confidence) * cutter_consistency).clamp(0.0, 0.95);
        let mut widths = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_width as f64)
            .collect::<Vec<_>>();
        let mut heights = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_height as f64)
            .collect::<Vec<_>>();
        widths.sort_by(f64::total_cmp);
        heights.sort_by(f64::total_cmp);
        let prior = crate::split::DocumentPrior {
            dominant_layout,
            cutter_ratio_median,
            cluster_dims: crate::split::ClusterDimensions {
                width: median(&widths).unwrap_or(1.0),
                height: median(&heights).unwrap_or(1.0),
            },
            agreement_strength,
        };

        for index in cluster {
            let metadata = &results[index].metadata;
            let candidate_is_off_prior = prior
                .cutter_ratio_median
                .zip(metadata.candidate_cutter_ratio)
                .is_some_and(|(prior_ratio, candidate_ratio)| {
                    (prior_ratio - candidate_ratio).abs() > 0.015
                });
            let rerun_with_prior = prior.dominant_layout == LayoutClassification::TwoPageSpread
                && (metadata.tier1_verdict != prior.dominant_layout
                    || metadata.tier1_confidence < 0.60
                    || candidate_is_off_prior);
            if rerun_with_prior {
                let tier1 = Tier1Provenance {
                    verdict: metadata.tier1_verdict,
                    confidence: metadata.tier1_confidence,
                    candidate_cutter_ratio: metadata.candidate_cutter_ratio,
                    whitespace_score: metadata.whitespace_score,
                };
                let page_cache = page_cache_for(&manifest.pages[index], cache)?;
                let mut rerun = run_classification(
                    &manifest.pages[index],
                    manifest.canvas_scope,
                    Some(prior),
                    &page_cache,
                )?;
                rerun.timings.decode_ms += results[index].timings.decode_ms;
                rerun.timings.analysis_level_ms += results[index].timings.analysis_level_ms;
                rerun.timings.normalization_ms += results[index].timings.normalization_ms;
                rerun.timings.split_ms += results[index].timings.split_ms;
                rerun.timings.content_ms += results[index].timings.content_ms;
                results[index] = rerun;
                preserve_tier1_provenance_after_rerun(&mut results[index].metadata, tier1, prior);
                continue;
            }

            let metadata = &mut results[index].metadata;
            let tier1_cutter = (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                .then_some(metadata.cutter_x_px)
                .flatten();
            let decision = crate::split::reconcile_layout_decision(
                metadata.tier1_verdict,
                metadata.tier1_confidence,
                tier1_cutter,
                metadata.candidate_cutter_ratio,
                metadata.whitespace_score,
                metadata.rotated_width,
                metadata.rotated_height,
                prior,
            );
            metadata.layout_classification = decision.classification;
            metadata.layout_confidence = decision.confidence;
            metadata.cutter_x_px = decision.cutter_x;
            metadata.tier1_verdict = decision.reconciliation.tier1_verdict;
            metadata.reconciled = decision.reconciliation.reconciled;
            metadata.cluster_agreement = decision.reconciliation.cluster_agreement;
            metadata.document_prior = Some(prior);
            metadata.output_count = if metadata.excluded {
                0
            } else if decision.classification == LayoutClassification::TwoPageSpread {
                2
            } else {
                1
            };
            if decision.classification != LayoutClassification::TwoPageSpread {
                metadata.split_seam = None;
            }
            if decision.reconciliation.reconciled {
                metadata.outputs.clear();
            }
        }
    }
    Ok(())
}

fn preserve_tier1_provenance_after_rerun(
    metadata: &mut PageResultMetadata,
    tier1: Tier1Provenance,
    prior: crate::split::DocumentPrior,
) {
    metadata.tier1_verdict = tier1.verdict;
    metadata.tier1_confidence = tier1.confidence;
    metadata.candidate_cutter_ratio = tier1.candidate_cutter_ratio;
    metadata.whitespace_score = tier1.whitespace_score;
    metadata.reconciled = metadata.layout_classification != tier1.verdict;
    metadata.cluster_agreement = if metadata.layout_classification == prior.dominant_layout {
        prior.agreement_strength
    } else {
        -prior.agreement_strength
    };
    metadata.document_prior = Some(prior);
}

fn dimensions_within_tolerance(left: usize, right: usize) -> bool {
    left.abs_diff(right) as f64 / left.max(right).max(1) as f64 <= 0.02
}

fn classification_bucket(classification: LayoutClassification) -> usize {
    match classification {
        LayoutClassification::SingleUncutPage => 0,
        LayoutClassification::PageWithOffcut => 1,
        LayoutClassification::TwoPageSpread => 2,
    }
}

fn bucket_classification(bucket: usize) -> LayoutClassification {
    match bucket {
        0 => LayoutClassification::SingleUncutPage,
        1 => LayoutClassification::PageWithOffcut,
        _ => LayoutClassification::TwoPageSpread,
    }
}

fn median(values: &[f64]) -> Option<f64> {
    match values.len() {
        0 => None,
        length if length % 2 == 1 => Some(values[length / 2]),
        length => Some((values[length / 2 - 1] + values[length / 2]) * 0.5),
    }
}

fn ramp_local(value: f64, low: f64, high: f64) -> f64 {
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}

fn write_progress(progress: Progress) -> Result<(), Box<dyn Error>> {
    println!(
        "{}",
        serde_json::to_string(&ProgressEnvelope::new(progress))?
    );
    Ok(())
}

fn run_manifest_page(
    manifest: &ManifestV3,
    page: &Page,
    _index: usize,
    cache: &PageCache,
) -> Result<PageRunResult, Box<dyn Error>> {
    if manifest.operation == Operation::Analyze {
        run_classification(page, manifest.canvas_scope, page.document_prior, cache)
    } else {
        run_page(
            page,
            manifest.canvas_scope,
            manifest.render_mode == RenderMode::Final,
            None,
            cache,
        )
    }
}

fn pages_have_disjoint_destinations(manifest: &ManifestV3) -> bool {
    let mut paths = HashSet::new();
    manifest.pages.iter().all(|page| {
        let page_paths = page
            .outputs
            .iter()
            .flat_map(|output| {
                [
                    Some(&output.output_path),
                    Some(&output.metadata_path),
                    output.bilevel_output_path.as_ref(),
                    output.background_output_path.as_ref(),
                    output.foreground_mask_output_path.as_ref(),
                ]
                .into_iter()
                .flatten()
            })
            .chain(std::iter::once(&page.page_metadata_path));
        page_paths
            .into_iter()
            .all(|path| paths.insert(path.clone()))
    })
}

const FALLBACK_SYSTEM_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const GRAY_PEAK_BYTES_PER_PIXEL: u64 = 12;
const COLOR_PEAK_BYTES_PER_PIXEL: u64 = 24;

fn manifest_worker_threads(manifest: &ManifestV3) -> Result<usize, NativeError> {
    let available = std::thread::available_parallelism().map_or(2, usize::from);
    let peak_page_bytes = manifest
        .pages
        .iter()
        .map(|page| {
            let options = &page.options;
            // Do not synchronously open pipes or other streaming inputs while
            // sizing the worker pool. Doing so would prevent completed regular
            // pages from reporting analysis progress until every stream opens.
            if fs::metadata(&page.input_path).is_ok_and(|metadata| !metadata.file_type().is_file())
            {
                return Ok(0);
            }
            let (width, height) =
                png::read_dimensions(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?;
            Ok(estimate_peak_page_bytes(width, height, options.output_mode))
        })
        .collect::<Result<Vec<_>, NativeError>>()?
        .into_iter()
        .max()
        .unwrap_or(1);
    let total_memory = system_memory_bytes().unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    let process_budget = total_memory.saturating_mul(40) / 100;
    let worker_budget = process_budget.saturating_sub(configured_cache_budget_bytes() as u64);
    Ok(adaptive_thread_count(
        available,
        manifest.pages.len(),
        worker_budget,
        peak_page_bytes,
    ))
}

/// Peak accounting follows the full-resolution allocations in `run_page` and
/// `clean_region`: gray decode, rotation, normalization/background work,
/// rendered/output copies, and binary/morphology scratch are covered by twelve
/// bytes per pixel. Color/mixed adds decoded, rotated, normalized, and rendered
/// RGB rasters, bringing the conservative multiplier to twenty-four.
fn estimate_peak_page_bytes(width: usize, height: usize, output_mode: OutputMode) -> u64 {
    let pixels = (width as u64).saturating_mul(height as u64);
    let multiplier = if matches!(output_mode, OutputMode::Color | OutputMode::Mixed) {
        COLOR_PEAK_BYTES_PER_PIXEL
    } else {
        GRAY_PEAK_BYTES_PER_PIXEL
    };
    pixels.saturating_mul(multiplier)
}

fn adaptive_thread_count(
    available_parallelism: usize,
    page_count: usize,
    memory_budget_bytes: u64,
    peak_page_bytes: u64,
) -> usize {
    if page_count == 0 {
        return 1;
    }
    let cpu_limit = (available_parallelism / 2).max(2).min(page_count.max(1));
    let memory_limit = if peak_page_bytes == 0 {
        page_count
    } else {
        (memory_budget_bytes / peak_page_bytes).max(1) as usize
    };
    cpu_limit.min(memory_limit).min(page_count).max(1)
}

fn system_memory_bytes() -> Option<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
    let kibibytes = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?
        .split_ascii_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kibibytes.saturating_mul(1024))
}

fn configured_cache_budget_bytes() -> usize {
    let total_memory = system_memory_bytes().unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    DEFAULT_CACHE_BUDGET_BYTES.min((total_memory / 10) as usize)
}

fn run_page(
    page: &Page,
    canvas_scope: CanvasScope,
    final_render: bool,
    fallback_destination: Option<(&Path, &Path)>,
    cache: &PageCache,
) -> Result<PageRunResult, Box<dyn Error>> {
    let options = page.options.clone();
    options.validate().map_err(invalid)?;
    let mut timings = PageStageTimings::default();
    let decode_started = Instant::now();
    let color_input = if matches!(
        options.output_mode,
        OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
    ) {
        let key = StageCacheKey::decoded(&cache.source, true, &options);
        let cached = cache
            .shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.get::<png::DecodedPng>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                png::read_image(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?,
            );
            let bytes = decoded
                .gray
                .data()
                .len()
                .saturating_add(decoded.rgb.width().saturating_mul(decoded.rgb.height()) * 3);
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, Arc::clone(&decoded), bytes);
            }
            decoded
        })
    } else {
        None
    };
    let gray_input = if color_input.is_none() {
        let key = StageCacheKey::decoded(&cache.source, false, &options);
        let cached = cache
            .shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.get::<GrayImage>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                png::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?,
            );
            let bytes = decoded.data().len();
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, Arc::clone(&decoded), bytes);
            }
            decoded
        })
    } else {
        None
    };
    timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
    let input_gray = color_input
        .as_ref()
        .map(|input| &input.gray)
        .or(gray_input.as_deref())
        .expect("cleanup input is initialized");
    let mut result = if let Some(detail_plan) = &page.detail_render_plan {
        let metadata_bytes = fs::read(&detail_plan.base_metadata_path).map_err(|error| {
            invalid(format!(
                "Failed to read detail base metadata {}: {error}",
                detail_plan.base_metadata_path.display(),
            ))
        })?;
        let base_metadata: CleanupMetadata =
            serde_json::from_slice(&metadata_bytes).map_err(|error| {
                invalid(format!(
                    "Invalid detail base metadata {}: {error}",
                    detail_plan.base_metadata_path.display(),
                ))
            })?;
        let base_source = png::read_gray(
            &detail_plan.base_raster_path,
            options.max_pixels,
            options.max_dimension,
        )
        .map_err(map_image_error)?;
        clean_detail_page_with_color(
            input_gray,
            color_input.as_ref().map(|input| &input.rgb),
            &base_source,
            &options,
            page.source_page_index,
            detail_plan,
            &base_metadata,
        )
        .map_err(invalid)?
    } else {
        clean_page_with_color_and_document_prior_cached(
            input_gray,
            color_input.as_ref().map(|input| &input.rgb),
            &options,
            page.source_page_index,
            page.document_prior,
            cache,
            final_render,
            &mut timings,
        )
        .map_err(invalid)?
    };
    for output in &mut result.outputs {
        output.metadata.canvas_scope = canvas_scope;
    }
    if options.ocr_mode
        && (result.outputs.len() != 1
            || result.outputs[0].image.width() != input_gray.width()
            || result.outputs[0].image.height() != input_gray.height())
    {
        return Err(invalid("OCR mode changed output dimensions").into());
    }
    let page_metadata = PageResultMetadata {
        source_page_index: page.source_page_index,
        layout_classification: result.classification,
        layout_confidence: result.layout_confidence,
        cutter_x_px: result.cutter_x,
        split_seam: result.split_seam,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: result.blank_outputs_skipped,
        output_count: result.outputs.len(),
        outputs: Vec::new(),
        tier1_verdict: result.reconciliation.tier1_verdict,
        reconciled: result.reconciliation.reconciled,
        cluster_agreement: result.reconciliation.cluster_agreement,
        document_prior: page.document_prior,
        text_axis: None,
        recommended_output_mode: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.mode),
        recommended_output_mode_confidence: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.confidence),
        recommended_output_mode_reason: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.reason),
        rotated_width: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.height()
        } else {
            input_gray.width()
        },
        rotated_height: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.width()
        } else {
            input_gray.height()
        },
        candidate_cutter_ratio: result
            .cutter_x
            .map(|cutter| cutter / input_gray.width().max(1) as f64),
        whitespace_score: 0.0,
        reconciliation_eligible: false,
        tier1_confidence: result.layout_confidence,
    };
    let destinations = resolve_destinations(page, result.outputs.len(), fallback_destination)?;
    let mut written = Vec::with_capacity(result.outputs.len());
    let write_started = Instant::now();
    let publication_result = (|| -> Result<(), Box<dyn Error>> {
        for (output, destination) in result.outputs.iter_mut().zip(&destinations) {
            if let Some(color) = &output.color_image {
                png::write_rgb_atomic(&destination.output_path, color)
                    .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
            } else {
                png::write_gray_atomic(&destination.output_path, &output.image)
                    .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
            }
            let bilevel_output_path = if matches!(
                output.metadata.output_mode,
                OutputMode::Bw | OutputMode::Mixed
            ) && output.color_image.is_none()
                && output.mixed_layers.is_none()
            {
                if let Some(path) = &destination.bilevel_output_path {
                    pbm::write_p4_atomic(path, &output.image)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    output.metadata.bilevel_written = true;
                    Some(path.clone())
                } else {
                    None
                }
            } else {
                None
            };
            let layer_paths = final_render.then(|| {
                destination
                    .background_output_path
                    .as_ref()
                    .zip(destination.foreground_mask_output_path.as_ref())
            });
            let (background_output_path, foreground_mask_output_path) = if let (
                Some(layers),
                Some(Some((background_path, mask_path))),
            ) =
                (output.mixed_layers.as_ref(), layer_paths)
            {
                let layer_result = (|| -> Result<(), String> {
                    let background_dpi = options.source_dpi().min(options.dpi);
                    let background_width = ((layers.background.width() as f64 * background_dpi
                        / options.dpi)
                        .round() as usize)
                        .max(1);
                    let background_height = ((layers.background.height() as f64 * background_dpi
                        / options.dpi)
                        .round() as usize)
                        .max(1);
                    if let Some(color) = &layers.color_background {
                        if !options.match_page_size && background_dpi < options.dpi {
                            let background = downscale_rgb_to_dimensions(
                                color,
                                background_width,
                                background_height,
                            );
                            png::write_rgb_atomic(background_path, &background)?;
                        } else {
                            png::write_rgb_atomic(background_path, color)?;
                        }
                    } else if !options.match_page_size && background_dpi < options.dpi {
                        let background = layers
                            .background
                            .downscale_to_dimensions(background_width, background_height);
                        png::write_gray_atomic(background_path, &background)?;
                    } else {
                        png::write_gray_atomic(background_path, &layers.background)?;
                    }
                    pbm::write_p4_atomic(mask_path, &layers.foreground_mask)
                })();
                if let Err(error) = layer_result {
                    let _ = fs::remove_file(background_path);
                    let _ = fs::remove_file(mask_path);
                    output.metadata.warnings.push(format!(
                            "Mixed layers were not written; the composite fallback remains available: {error}"
                        ));
                    (None, None)
                } else {
                    output.metadata.layered_written = true;
                    output.metadata.layered_background_dpi =
                        Some(options.source_dpi().min(options.dpi));
                    (Some(background_path.clone()), Some(mask_path.clone()))
                }
            } else {
                (None, None)
            };
            write_json_atomic(&destination.metadata_path, &output.metadata)?;
            written.push(WrittenOutput {
                output_path: destination.output_path.clone(),
                metadata_path: destination.metadata_path.clone(),
                bilevel_output_path,
                background_output_path,
                foreground_mask_output_path,
                options: options.clone(),
                is_color: output.color_image.is_some(),
                half: output.metadata.half,
            });
        }
        Ok(())
    })();
    if let Err(error) = publication_result {
        for destination in &destinations {
            let _ = fs::remove_file(&destination.output_path);
            let _ = fs::remove_file(&destination.metadata_path);
            if let Some(bilevel_path) = &destination.bilevel_output_path {
                let _ = fs::remove_file(bilevel_path);
            }
            if let Some(background_path) = &destination.background_output_path {
                let _ = fs::remove_file(background_path);
            }
            if let Some(mask_path) = &destination.foreground_mask_output_path {
                let _ = fs::remove_file(mask_path);
            }
        }
        let _ = fs::remove_file(&page.page_metadata_path);
        return Err(error);
    }
    timings.write_ms += write_started.elapsed().as_secs_f64() * 1_000.0;
    Ok(PageRunResult {
        outputs: written,
        metadata: page_metadata,
        page_metadata_path: page.page_metadata_path.clone(),
        classification_only: false,
        timings,
    })
}

fn run_classification(
    page: &Page,
    canvas_scope: CanvasScope,
    document_prior: Option<crate::split::DocumentPrior>,
    cache: &PageCache,
) -> Result<PageRunResult, Box<dyn Error>> {
    let options = page.options.clone();
    options.validate().map_err(invalid)?;
    let mut timings = PageStageTimings::default();
    let decode_started = Instant::now();
    // Classification produces mode-independent diagnostics. Always decode RGB
    // here so a page analyzed while a concrete mode is selected can still
    // recommend color after the user switches back to Auto.
    let color_input = {
        let key = StageCacheKey::decoded(&cache.source, true, &options);
        let cached = cache
            .shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.get::<png::DecodedPng>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                png::read_image(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?,
            );
            let bytes = decoded
                .gray
                .data()
                .len()
                .saturating_add(decoded.rgb.width().saturating_mul(decoded.rgb.height()) * 3);
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, Arc::clone(&decoded), bytes);
            }
            decoded
        })
    };
    let gray_input = if color_input.is_none() {
        let key = StageCacheKey::decoded(&cache.source, false, &options);
        let cached = cache
            .shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.get::<GrayImage>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                png::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?,
            );
            let bytes = decoded.data().len();
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, Arc::clone(&decoded), bytes);
            }
            decoded
        })
    } else {
        None
    };
    timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
    let input = color_input
        .as_ref()
        .map(|decoded| &decoded.gray)
        .or(gray_input.as_deref())
        .expect("classification input is initialized");
    let result = analyze_page_with_color_and_document_prior_cached(
        input,
        color_input.as_ref().map(|decoded| &decoded.rgb),
        &options,
        document_prior,
        cache,
        &mut timings,
    )
    .map_err(invalid)?;
    let page_metadata = PageResultMetadata {
        source_page_index: page.source_page_index,
        layout_classification: result.classification,
        layout_confidence: result.confidence,
        cutter_x_px: result.cutter_x,
        split_seam: result.split_seam,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: 0,
        output_count: if result.excluded {
            0
        } else if result.classification == crate::split::LayoutClassification::TwoPageSpread {
            2
        } else {
            1
        },
        outputs: result.outputs,
        tier1_verdict: result.reconciliation.tier1_verdict,
        reconciled: result.reconciliation.reconciled,
        cluster_agreement: result.reconciliation.cluster_agreement,
        document_prior,
        text_axis: result.text_axis,
        recommended_output_mode: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.mode),
        recommended_output_mode_confidence: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.confidence),
        recommended_output_mode_reason: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.reason),
        rotated_width: result.rotated_width,
        rotated_height: result.rotated_height,
        candidate_cutter_ratio: result.candidate_cutter_ratio,
        whitespace_score: result.whitespace_score,
        reconciliation_eligible: matches!(options.layout, crate::LayoutMode::Auto)
            && options.manual_split_x.is_none()
            && !options.excluded,
        tier1_confidence: if result.reconciliation.reconciled
            || result.reconciliation.cluster_agreement != 0.0
        {
            0.0
        } else {
            result.confidence
        },
    };
    Ok(PageRunResult {
        outputs: Vec::new(),
        metadata: page_metadata,
        page_metadata_path: page.page_metadata_path.clone(),
        classification_only: true,
        timings,
    })
}

fn match_page_sizes(
    outputs: &[WrittenOutput],
    preview_mode: bool,
    document_canvas: Option<DocumentCanvas>,
) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
        .filter(|output| output.options.match_page_size && !output.options.ocr_mode)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Ok(());
    }

    let images = eligible
        .iter()
        .map(|output| {
            png::read_gray(
                &output.output_path,
                output.options.max_pixels,
                output.options.max_dimension,
            )
            .map_err(map_image_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let target_width_points = document_canvas.map_or_else(
        || {
            eligible
                .iter()
                .zip(&images)
                .map(|(output, image)| image.width() as f64 / output.options.dpi * 72.0)
                .fold(0.0, f64::max)
        },
        |canvas| canvas.width_points,
    );
    let target_height_points = document_canvas.map_or_else(
        || {
            eligible
                .iter()
                .zip(&images)
                .map(|(output, image)| image.height() as f64 / output.options.dpi * 72.0)
                .fold(0.0, f64::max)
        },
        |canvas| canvas.height_points,
    );

    for (output, image) in eligible.into_iter().zip(images) {
        let repad_result = (|| -> Result<(), Box<dyn Error>> {
            let target_width = ((target_width_points / 72.0) * output.options.dpi)
                .ceil()
                .max(image.width() as f64) as usize;
            let target_height = ((target_height_points / 72.0) * output.options.dpi)
                .ceil()
                .max(image.height() as f64) as usize;
            validate_canvas(target_width, target_height, output)?;
            let available_width = target_width - image.width();
            let available_height = target_height - image.height();
            let (left, top) = output
                .options
                .placement_for(output.half)
                .offset(available_width, available_height);
            let right = available_width - left;
            let bottom = available_height - top;
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            metadata.soft_margins_pixels = [left, top, right, bottom];
            metadata.uniform_canvas = true;
            metadata.canvas_policy = MatchedCanvasPolicy::StrictMaximum;
            metadata.canvas_overflow = false;
            metadata.matched_canvas_target_width = Some(target_width);
            metadata.matched_canvas_target_height = Some(target_height);
            metadata.matched_canvas_target_width_points = Some(target_width_points);
            metadata.matched_canvas_target_height_points = Some(target_height_points);
            metadata.canvas_width = target_width;
            metadata.canvas_height = target_height;
            metadata.placement_offset_x = left;
            metadata.placement_offset_y = top;

            if !preview_mode && (available_width != 0 || available_height != 0) {
                if output.is_color {
                    let image = png::read_image(
                        &output.output_path,
                        output.options.max_pixels,
                        output.options.max_dimension,
                    )?
                    .rgb;
                    let canvas =
                        place_rgb_on_white_canvas(&image, target_width, target_height, left, top);
                    png::write_rgb_atomic(&output.output_path, &canvas)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                } else {
                    let canvas =
                        place_on_white_canvas(&image, target_width, target_height, left, top);
                    png::write_gray_atomic(&output.output_path, &canvas)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    if metadata.bilevel_written {
                        let bilevel_path =
                            output.bilevel_output_path.as_ref().ok_or_else(|| {
                                invalid(
                                    "Bilevel cleanup metadata is missing its output destination",
                                )
                            })?;
                        pbm::write_p4_atomic(bilevel_path, &canvas)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    }
                }
            }
            if !preview_mode && metadata.layered_written {
                let layer_result = (|| -> Result<(), Box<dyn Error>> {
                    let background_path =
                        output.background_output_path.as_ref().ok_or_else(|| {
                            invalid(
                                "Layered cleanup metadata is missing its background destination",
                            )
                        })?;
                    let mask_path =
                        output.foreground_mask_output_path.as_ref().ok_or_else(|| {
                            invalid("Layered cleanup metadata is missing its mask destination")
                        })?;
                    let mask = pbm::read_p4(
                        mask_path,
                        output.options.max_pixels,
                        output.options.max_dimension,
                    )
                    .map_err(map_image_error)?;
                    let mask = if available_width == 0 && available_height == 0 {
                        mask
                    } else {
                        place_on_white_canvas(&mask, target_width, target_height, left, top)
                    };
                    pbm::write_p4_atomic(mask_path, &mask)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;

                    let background_dpi = metadata
                        .layered_background_dpi
                        .unwrap_or(output.options.source_dpi().min(output.options.dpi));
                    let background_width = ((target_width as f64 * background_dpi
                        / output.options.dpi)
                        .round() as usize)
                        .max(1);
                    let background_height = ((target_height as f64 * background_dpi
                        / output.options.dpi)
                        .round() as usize)
                        .max(1);
                    if output.is_color {
                        let background = png::read_image(
                            background_path,
                            output.options.max_pixels,
                            output.options.max_dimension,
                        )?
                        .rgb;
                        let background = if available_width == 0 && available_height == 0 {
                            background
                        } else {
                            place_rgb_on_white_canvas(
                                &background,
                                target_width,
                                target_height,
                                left,
                                top,
                            )
                        };
                        let background = downscale_rgb_to_dimensions(
                            &background,
                            background_width,
                            background_height,
                        );
                        png::write_rgb_atomic(background_path, &background)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    } else {
                        let background = png::read_gray(
                            background_path,
                            output.options.max_pixels,
                            output.options.max_dimension,
                        )
                        .map_err(map_image_error)?;
                        let background = if available_width == 0 && available_height == 0 {
                            background
                        } else {
                            place_on_white_canvas(
                                &background,
                                target_width,
                                target_height,
                                left,
                                top,
                            )
                        };
                        let background =
                            background.downscale_to_dimensions(background_width, background_height);
                        png::write_gray_atomic(background_path, &background)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    }
                    Ok(())
                })();
                if let Err(error) = layer_result {
                    if let Some(background_path) = &output.background_output_path {
                        let _ = fs::remove_file(background_path);
                    }
                    if let Some(mask_path) = &output.foreground_mask_output_path {
                        let _ = fs::remove_file(mask_path);
                    }
                    metadata.layered_written = false;
                    metadata.layered_background_dpi = None;
                    metadata.warnings.push(format!(
                        "Mixed layers could not be finalized; the composite fallback remains available: {error}"
                    ));
                }
            }
            write_json_atomic(&output.metadata_path, &metadata)?;
            Ok(())
        })();
        if let Err(error) = repad_result {
            let _ = fs::remove_file(&output.output_path);
            let _ = fs::remove_file(&output.metadata_path);
            if let Some(bilevel_path) = &output.bilevel_output_path {
                let _ = fs::remove_file(bilevel_path);
            }
            if let Some(background_path) = &output.background_output_path {
                let _ = fs::remove_file(background_path);
            }
            if let Some(mask_path) = &output.foreground_mask_output_path {
                let _ = fs::remove_file(mask_path);
            }
            return Err(error);
        }
    }
    Ok(())
}

fn validate_canvas(width: usize, height: usize, output: &WrittenOutput) -> Result<(), NativeError> {
    let pixels = (width as u64).saturating_mul(height as u64);
    if width > output.options.max_dimension as usize
        || height > output.options.max_dimension as usize
        || pixels > output.options.max_pixels
    {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!("Uniform page canvas {width}x{height} exceeds cleanup guardrails"),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn robust_quantile_dimension(values: impl Iterator<Item = usize>) -> usize {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    let rank = values.len().saturating_mul(9).div_ceil(10).max(1);
    values[rank - 1]
}

fn place_on_white_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> GrayImage {
    let mut canvas = GrayImage::new(width, height, 255);
    for y in 0..source.height() {
        for x in 0..source.width() {
            canvas.set(left + x, top + y, source.get(x, y));
        }
    }
    canvas
}

fn place_rgb_on_white_canvas(
    source: &RgbImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> RgbImage {
    let mut canvas = RgbImage::new(width, height, [255; 3]);
    for y in 0..source.height() {
        for x in 0..source.width() {
            canvas.set(left + x, top + y, source.get(x, y));
        }
    }
    canvas
}

fn resolve_destinations(
    page: &Page,
    output_count: usize,
    fallback: Option<(&Path, &Path)>,
) -> Result<Vec<PageOutput>, NativeError> {
    if !page.outputs.is_empty() {
        if page.outputs.len() < output_count {
            return Err(invalid(format!(
                "Cleanup produced {output_count} pages but only {} output destinations were supplied",
                page.outputs.len()
            )));
        }
        return Ok(page.outputs.iter().take(output_count).cloned().collect());
    }
    let (output, metadata) =
        fallback.ok_or_else(|| invalid("Render page requires output destinations"))?;
    if output_count == 1 {
        return Ok(vec![PageOutput {
            output_path: output.to_path_buf(),
            metadata_path: metadata.to_path_buf(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
        }]);
    }
    Ok((0..output_count)
        .map(|index| PageOutput {
            output_path: suffixed_path(output, index),
            metadata_path: suffixed_path(metadata, index),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
        })
        .collect())
}

fn suffixed_path(path: &Path, index: usize) -> PathBuf {
    let suffix = if index == 0 { "left" } else { "right" };
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("page");
    let extension = path.extension().and_then(|value| value.to_str());
    let name = match extension {
        Some(extension) => format!("{stem}-{suffix}.{extension}"),
        None => format!("{stem}-{suffix}"),
    };
    path.with_file_name(name)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    let result = (|| {
        fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
        fs::rename(&temporary, path)?;
        Ok::<_, Box<dyn Error>>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn map_image_error(message: String) -> NativeError {
    let code = if message.contains("guardrails") {
        NativeErrorCode::TooLarge
    } else {
        NativeErrorCode::InvalidRequest
    };
    NativeError::new(code, message)
}
#[cfg(test)]
mod tests {
    use super::{
        adaptive_thread_count, estimate_peak_page_bytes, preserve_tier1_provenance_after_rerun,
        robust_quantile_dimension, PageResultMetadata, Tier1Provenance,
    };
    use crate::{
        protocol::manifest_v3::{CanvasScope, SplitSeamPolyline},
        split::{ClusterDimensions, DocumentPrior, LayoutClassification},
        OrthogonalRotation, OutputMode,
    };
    use scan_primitives::Point;

    #[test]
    fn matched_canvas_dimension_uses_nearest_rank_ninetieth_percentile() {
        assert_eq!(robust_quantile_dimension([60, 60].into_iter()), 60);
        assert_eq!(
            robust_quantile_dimension([80, 80, 80, 80, 80, 80, 80, 80, 80, 140].into_iter()),
            80
        );
    }

    #[test]
    fn adaptive_threads_respect_cpu_pages_and_memory() {
        assert_eq!(adaptive_thread_count(16, 20, 10_000, 1_000), 8);
        assert_eq!(adaptive_thread_count(16, 3, 10_000, 1_000), 3);
        assert_eq!(adaptive_thread_count(2, 20, 10_000, 1_000), 2);
        assert_eq!(adaptive_thread_count(16, 20, 1_500, 1_000), 1);
        assert_eq!(adaptive_thread_count(16, 0, 10_000, 1_000), 1);
    }

    #[test]
    fn color_peak_estimate_accounts_for_rgb_working_copies() {
        assert_eq!(estimate_peak_page_bytes(100, 50, OutputMode::Bw), 60_000);
        assert_eq!(
            estimate_peak_page_bytes(100, 50, OutputMode::Color),
            120_000
        );
    }

    #[test]
    fn prior_rerun_preserves_unbiased_tier1_provenance() {
        let seam = SplitSeamPolyline {
            points: vec![Point::new(120.0, 0.0), Point::new(121.0, 200.0)],
        };
        let mut metadata = PageResultMetadata {
            source_page_index: 3,
            layout_classification: LayoutClassification::TwoPageSpread,
            layout_confidence: 0.92,
            cutter_x_px: Some(121.0),
            split_seam: Some(seam.clone()),
            rotation_degrees: OrthogonalRotation::None,
            canvas_scope: CanvasScope::default(),
            excluded: false,
            blank_outputs_skipped: 0,
            output_count: 2,
            outputs: Vec::new(),
            tier1_verdict: LayoutClassification::TwoPageSpread,
            reconciled: false,
            cluster_agreement: 0.9,
            document_prior: None,
            text_axis: None,
            recommended_output_mode: None,
            recommended_output_mode_confidence: None,
            recommended_output_mode_reason: None,
            rotated_width: 240,
            rotated_height: 200,
            candidate_cutter_ratio: Some(0.505),
            whitespace_score: 0.8,
            reconciliation_eligible: true,
            tier1_confidence: 0.0,
        };
        let tier1 = Tier1Provenance {
            verdict: LayoutClassification::SingleUncutPage,
            confidence: 0.47,
            candidate_cutter_ratio: Some(0.49),
            whitespace_score: 0.18,
        };
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.5),
            cluster_dims: ClusterDimensions {
                width: 240.0,
                height: 200.0,
            },
            agreement_strength: 0.9,
        };

        preserve_tier1_provenance_after_rerun(&mut metadata, tier1, prior);

        assert_eq!(
            metadata.tier1_verdict,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(metadata.tier1_confidence, 0.47);
        assert_eq!(metadata.candidate_cutter_ratio, Some(0.49));
        assert_eq!(metadata.whitespace_score, 0.18);
        assert!(metadata.reconciled);
        assert_eq!(metadata.cluster_agreement, 0.9);
        assert_eq!(metadata.document_prior, Some(prior));
        assert_eq!(metadata.output_count, 2);
        assert_eq!(metadata.split_seam, Some(seam));
    }
}
