use crate::adapters::single_ocr_cli::{invalid, optional_value, parse_options, required_path};
use crate::engine::render::{
    analyze_page_with_color_and_document_prior_cached, clean_detail_page_with_color,
    clean_page_with_color_and_document_prior_cached, downscale_rgb_to_dimensions,
};
use crate::mode_select::OutputModeRecommendationReason;
use crate::{
    cache::{ByteLru, PageCache, SourceFingerprint, StageCacheKey, DEFAULT_CACHE_BUDGET_BYTES},
    io::{pbm, raster},
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
    width: usize,
    height: usize,
    /// The paper this output is responsible for: the region of the rotated
    /// sheet it was cut from, in the pixels the page was rendered at. Matching
    /// scales by the paper rather than by the cropped raster, and a spread half
    /// owns half a sheet — scaling both halves by the whole sheet leaves a
    /// document where a page scanned alone is twice the size of the same page
    /// scanned as half of a spread, on a sheet that is half empty.
    paper_width: f64,
    paper_height: f64,
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
    timings: PageStageTimings,
}

#[derive(Clone, Copy)]
struct Tier1Provenance {
    verdict: LayoutClassification,
    confidence: f64,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
}

fn manifest_cache(host_memory_bytes: Option<u64>) -> Arc<Mutex<ByteLru>> {
    Arc::new(Mutex::new(ByteLru::new(cache_budget_bytes(
        host_memory_bytes,
    ))))
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
    let cache = manifest_cache(None);
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
    let cache = manifest_cache(manifest.host_memory_bytes);
    let total_pages = manifest.pages.len();
    // Pages finish out of order under the worker pool, but the progress stream is
    // a monotone per-page sequence, so each page's event waits for its
    // predecessors before it is published.
    let pending_progress = Mutex::new((
        manifest.pages.iter().map(|_| None).collect::<Vec<_>>(),
        0usize,
    ));
    let report_page = |index: usize, progress: Progress| -> Result<(), NativeError> {
        let mut state = pending_progress.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page progress",
            )
        })?;
        state.0[index] = Some(progress);
        loop {
            let cursor = state.1;
            let Some(published) = state.0.get_mut(cursor).and_then(Option::take) else {
                break;
            };
            state.1 = cursor + 1;
            write_progress(published).map_err(|error| {
                NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Unable to publish scan-cleanup page progress: {error}"),
                )
            })?;
        }
        Ok(())
    };
    let analyzing = manifest.operation == Operation::Analyze;
    let run_analysis = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        let result = run_classification(
            page,
            manifest.canvas_scope,
            page.document_prior,
            true,
            &page_cache,
        )
        .map_err(|error| {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            NativeError::new(envelope.code, envelope.message)
        })?;
        report_page(
            index,
            Progress {
                stage: ProgressStage::PageAnalyzed,
                completed_pages: index + 1,
                total_pages,
                page_number: Some(index + 1),
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
            },
        )?;
        Ok(result)
    };
    let run_one = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        let result = run_page(
            page,
            manifest.canvas_scope,
            manifest.render_mode == RenderMode::Final,
            None,
            &page_cache,
        )
        .map_err(|error| {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            NativeError::new(envelope.code, envelope.message)
        })?;
        report_page(index, page_complete_progress(&result, index, total_pages))?;
        Ok(result)
    };
    let mut page_results = if analyzing {
        run_page_jobs(manifest, run_analysis)?
    } else {
        run_page_jobs(manifest, run_one)?
    };

    // Reconciliation only ever revises classification-pass results; a render pass
    // has already published its pages by the time it returns.
    if analyzing {
        reconcile_classification_batch(manifest, &mut page_results, &cache)?;
    }
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
        if analyzing {
            write_progress(page_complete_progress(&page_result, index, total_pages))?;
        }
        written_outputs.extend(page_result.outputs);
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
    // One pool per manifest, and the process runs one manifest: since the
    // discarded classification pass was removed this is built at most once,
    // and only when it will actually carry more than one page.
    let worker_threads = if manifest.pages.len() > 1 && pages_have_disjoint_destinations(manifest) {
        manifest_worker_threads(manifest)?
    } else {
        1
    };
    let results = if worker_threads > 1 {
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
            result.metadata.reconciliation_eligible && result.metadata.document_prior.is_none()
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
                    manifest.operation == Operation::Analyze
                        || manifest.pages[index].options.output_mode == OutputMode::Auto,
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

fn page_complete_progress(result: &PageRunResult, index: usize, total_pages: usize) -> Progress {
    let metadata = &result.metadata;
    Progress {
        stage: ProgressStage::PageComplete,
        completed_pages: index + 1,
        total_pages,
        page_number: Some(index + 1),
        output_paths: Some(
            result
                .outputs
                .iter()
                .map(|output| output.output_path.clone())
                .collect(),
        ),
        classification: Some(metadata.layout_classification),
        confidence: Some(metadata.layout_confidence),
        cutter_x_px: (metadata.layout_classification == LayoutClassification::TwoPageSpread)
            .then_some(metadata.cutter_x_px)
            .flatten(),
        tier1_verdict: Some(metadata.tier1_verdict),
        reconciled: Some(metadata.reconciled),
        cluster_agreement: Some(metadata.cluster_agreement),
        document_prior: metadata.document_prior,
        text_axis: metadata.text_axis,
        stage_timings: (!result.timings.is_empty()).then_some(result.timings),
        recommended_output_mode: metadata.recommended_output_mode,
        recommended_output_mode_confidence: metadata.recommended_output_mode_confidence,
        recommended_output_mode_reason: metadata.recommended_output_mode_reason,
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

/// Used only when a manifest does not report the host's memory — direct CLI
/// invocations and the single-page adapter. Every manifest written by the
/// application carries `hostMemoryBytes`, so this is a conservative floor for
/// standalone use rather than a guess about the machine.
const FALLBACK_SYSTEM_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const GRAY_PEAK_BYTES_PER_PIXEL: u64 = 40;
const COLOR_PEAK_BYTES_PER_PIXEL: u64 = 80;

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
            let (width, height) = raster::read_dimensions(
                &page.input_path,
                options.max_pixels,
                options.max_dimension,
            )
            .map_err(map_image_error)?;
            Ok(estimate_peak_page_bytes(width, height, options.output_mode))
        })
        .collect::<Result<Vec<_>, NativeError>>()?
        .into_iter()
        .max()
        .unwrap_or(1);
    let total_memory = manifest
        .host_memory_bytes
        .unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    let process_budget = total_memory.saturating_mul(40) / 100;
    let worker_budget =
        process_budget.saturating_sub(cache_budget_bytes(manifest.host_memory_bytes) as u64);
    Ok(adaptive_thread_count(
        available,
        manifest.pages.len(),
        worker_budget,
        peak_page_bytes,
    ))
}

/// Calibrated against the resident high-water mark a page actually reaches,
/// not against a sum of the live buffers `run_page` and `clean_region` name.
/// Counting only the named buffers modelled a gray page at twelve bytes per
/// pixel and missed real peak RSS by ~3.3x, because the high-water mark also
/// carries transient scratch inside the stage pipeline and pages the allocator
/// has freed but not returned to the OS. A worker budget divided by an
/// optimistic figure admits threads the host cannot hold, so the multiplier
/// used for sizing is the measured one.
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

fn cache_budget_bytes(host_memory_bytes: Option<u64>) -> usize {
    let total_memory = host_memory_bytes.unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
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
            .and_then(|mut shared| shared.get::<raster::DecodedRaster>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                raster::read_image(&page.input_path, options.max_pixels, options.max_dimension)
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
                raster::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
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
        let base_source = raster::read_gray(
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
            &mut timings,
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
            !final_render || options.output_mode == OutputMode::Auto,
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
            // A binarized page is already packed bits, and PBM P4 is the same
            // layout: the raster itself decides whether this page has a bilevel
            // primary, so no mode/layer combination has to be re-derived here.
            let bilevel_write = destination
                .bilevel_output_path
                .as_ref()
                .zip(output.image.bilevel())
                .map(|(path, binary)| (path, pbm::write_p4_bilevel_atomic(path, binary)));
            let bilevel_output_path = match bilevel_write {
                Some((path, Ok(()))) => {
                    output.metadata.bilevel_written = true;
                    Some(path.clone())
                }
                Some((path, Err(error))) => {
                    let _ = fs::remove_file(path);
                    output.metadata.warnings.push(format!(
                        "Bilevel output was not written; the composite fallback was published instead: {error}"
                    ));
                    None
                }
                None => None,
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
                    pbm::write_p4_bilevel_atomic(mask_path, &layers.foreground_mask)
                })();
                if let Err(error) = layer_result {
                    let _ = fs::remove_file(background_path);
                    let _ = fs::remove_file(mask_path);
                    output.metadata.warnings.push(format!(
                            "Mixed layers were not written; the composite fallback was published instead: {error}"
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
            // The composite carries the page only when no primary raster did.
            // Deflating and fsyncing a full-resolution copy beside a published
            // PBM or layer pair buys insurance nobody collects.
            if bilevel_output_path.is_none() && background_output_path.is_none() {
                if let Some(color) = &output.color_image {
                    png::write_rgb_atomic(&destination.output_path, color)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                } else {
                    png::write_gray_atomic(&destination.output_path, &output.image.to_gray())
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                }
            }
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
                width: output.image.width(),
                height: output.image.height(),
                paper_width: output.metadata.source_region.width,
                paper_height: output.metadata.source_region.height,
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
        timings,
    })
}

fn run_classification(
    page: &Page,
    canvas_scope: CanvasScope,
    document_prior: Option<crate::split::DocumentPrior>,
    recommend_output_mode: bool,
    cache: &PageCache,
) -> Result<PageRunResult, Box<dyn Error>> {
    let options = page.options.clone();
    options.validate().map_err(invalid)?;
    let mut timings = PageStageTimings::default();
    let decode_started = Instant::now();
    // Analyze produces mode-independent diagnostics even when a concrete mode
    // is selected. A concrete final render does not publish or consume those
    // recommendations, so keep that lane grayscale-only.
    let color_input = if recommend_output_mode {
        let key = StageCacheKey::decoded(&cache.source, true, &options);
        let cached = cache
            .shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.get::<raster::DecodedRaster>(&key));
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                raster::read_image(&page.input_path, options.max_pixels, options.max_dimension)
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
                raster::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
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
        recommend_output_mode,
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
        timings,
    })
}

/// Where one output lands on the document canvas: the size its intrinsic
/// raster takes on the canvas grid, and the origin it takes it at.
#[derive(Clone, Copy, Debug, PartialEq)]
struct CanvasPlacement {
    content_width: usize,
    content_height: usize,
    left: usize,
    top: usize,
    /// The page could not hold the document's scale and was fitted below it,
    /// which happens when margins push content past the paper it was measured
    /// on. Nothing is clipped; the page is simply smaller than its neighbours.
    overflow: bool,
    /// What the paper this output was cut from is worth on the canvas. Above 1
    /// a smaller sheet is resampled up to the document's scale, which is the
    /// point of matching; below 1 the sheet is larger than the rectangle the
    /// document was measured onto, so this page alone lands below that scale.
    paper_scale: f64,
    /// The paper is larger than the canvas by more than the grid's rounding:
    /// the sheet was cut into fewer pages than the rectangle was measured for,
    /// so this page is letterboxed below the document's scale while the grid
    /// and every neighbouring page stay exactly as they were.
    undersized_paper: bool,
}

/// A rectangle rounded onto the canvas grid can land a pixel outside a grid
/// derived from the same rectangle in points. Fitting a page for that pixel
/// would resample a page that already matches the document, so the grid carries
/// a one-pixel tolerance and only a real difference is fitted.
const CANVAS_GRID_TOLERANCE_PX: f64 = 1.0;

/// Normalizes one output onto the canvas: the scale that takes the *paper* it
/// was cut from to the canvas rectangle, expressed on the canvas pixel grid.
///
/// Scaling by the paper rather than by the cropped raster is what keeps a
/// document at one visual scale. A page cropped to a small content box is not
/// zoomed to fill the sheet because its margins were trimmed; a page whose
/// paper is half the size of the canvas — a lower-resolution scan of the same
/// original, a genuinely smaller sheet, or one half of a spread — is resampled
/// up until its ink matches everything around it.
fn plan_canvas_placement(output: &WrittenOutput, canvas: &DocumentCanvas) -> CanvasPlacement {
    let paper_width_points = output.paper_width.max(1.0) / output.options.dpi * 72.0;
    let paper_height_points = output.paper_height.max(1.0) / output.options.dpi * 72.0;
    let paper_scale =
        (canvas.width_points / paper_width_points).min(canvas.height_points / paper_height_points);
    // Paper rounded onto the canvas grid, against the grid itself: a page
    // measured to the pixel of the canvas is the page the canvas was measured
    // from, and only paper that needs more grid than there is — a sheet cut
    // into fewer pages than the rectangle expected — is a real difference.
    let undersized_paper = paper_width_points / canvas.width_points * canvas.width_px as f64
        > canvas.width_px as f64 + CANVAS_GRID_TOLERANCE_PX
        || paper_height_points / canvas.height_points * canvas.height_px as f64
            > canvas.height_px as f64 + CANVAS_GRID_TOLERANCE_PX;
    let pixel_scale = paper_scale * canvas.dpi() / output.options.dpi;
    let mut scaled_width = output.width as f64 * pixel_scale;
    let mut scaled_height = output.height as f64 * pixel_scale;
    let overflow = scaled_width > canvas.width_px as f64 + CANVAS_GRID_TOLERANCE_PX
        || scaled_height > canvas.height_px as f64 + CANVAS_GRID_TOLERANCE_PX;
    if overflow {
        let fit = (canvas.width_px as f64 / scaled_width.max(1.0))
            .min(canvas.height_px as f64 / scaled_height.max(1.0));
        scaled_width *= fit;
        scaled_height *= fit;
    }
    let content_width = (scaled_width.round() as usize).clamp(1, canvas.width_px);
    let content_height = (scaled_height.round() as usize).clamp(1, canvas.height_px);
    let (left, top) = output.options.placement_for(output.half).offset(
        canvas.width_px - content_width,
        canvas.height_px - content_height,
    );
    CanvasPlacement {
        content_width,
        content_height,
        left,
        top,
        overflow,
        paper_scale,
        undersized_paper,
    }
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
    // Without a plan there is no document-wide answer to derive here: this
    // process sees one manifest, and a canvas invented from the outputs it
    // happens to hold is a different rectangle for every window and for the
    // preview. The caller has to measure it and say so.
    let Some(canvas) = document_canvas else {
        return Err(invalid(
            "Matched page size requires a documentCanvas plan; the manifest carried none",
        )
        .into());
    };
    let target_width = canvas.width_px;
    let target_height = canvas.height_px;

    for output in eligible {
        let repad_result = (|| -> Result<(), Box<dyn Error>> {
            validate_canvas(target_width, target_height, output)?;
            let placement = plan_canvas_placement(output, &canvas);
            let CanvasPlacement {
                content_width,
                content_height,
                left,
                top,
                ..
            } = placement;
            let right = target_width - content_width - left;
            let bottom = target_height - content_height - top;
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            metadata.soft_margins_pixels = [left, top, right, bottom];
            metadata.uniform_canvas = true;
            metadata.canvas_policy = MatchedCanvasPolicy::StrictMaximum;
            metadata.canvas_overflow = placement.overflow;
            metadata.matched_canvas_target_width = Some(target_width);
            metadata.matched_canvas_target_height = Some(target_height);
            metadata.matched_canvas_target_width_points = Some(canvas.width_points);
            metadata.matched_canvas_target_height_points = Some(canvas.height_points);
            metadata.matched_canvas_content_width = Some(content_width);
            metadata.matched_canvas_content_height = Some(content_height);
            metadata.canvas_width = target_width;
            metadata.canvas_height = target_height;
            metadata.placement_offset_x = left;
            metadata.placement_offset_y = top;
            // A page that cannot hold the document's scale is a visible result,
            // not a diagnostic: it ends up smaller than its neighbours, so the
            // run says which page and by how much rather than leaving the user
            // to find it.
            if placement.overflow {
                metadata.warnings.push(format!(
                    "Matched page size fitted this page to {content_width}x{content_height} px \
                     inside the {target_width}x{target_height} px document canvas, \
                     below the document's scale"
                ));
            }
            // The other way a page ends up below the document's scale, and the
            // quieter one: its paper is larger than the canvas, so it is scaled
            // down into a rectangle the document was measured onto for a
            // differently cut sheet. The grid stays uniform and nothing is
            // clipped, which is exactly why this has to be said rather than
            // seen.
            if placement.undersized_paper {
                let percent = placement.paper_scale * 100.0;
                metadata.warnings.push(format!(
                    "Matched page size placed this page at {percent:.1}% of the document's scale \
                     because its paper is larger than the \
                     {target_width}x{target_height} px document canvas, \
                     which was measured from a different layout for this page"
                ));
            }

            // A preview leaves its raster at the resolution it was rendered at
            // and reports the box it occupies, because the renderer scales it
            // to the frame anyway. A final run owns the pixels the assembler
            // embeds, so it resamples them onto the canvas grid here.
            let rewrite_raster = !preview_mode
                && (content_width != output.width
                    || content_height != output.height
                    || content_width != target_width
                    || content_height != target_height);
            // Resample whichever raster actually carries the page. Only one of
            // the three is on disk, so this decodes each page at most once.
            if rewrite_raster && !metadata.layered_written {
                if metadata.bilevel_written {
                    let bilevel_path = output.bilevel_output_path.as_ref().ok_or_else(|| {
                        invalid("Bilevel cleanup metadata is missing its output destination")
                    })?;
                    let image = pbm::read_p4(
                        bilevel_path,
                        output.options.max_pixels,
                        output.options.max_dimension,
                    )
                    .map_err(map_image_error)?;
                    let canvas_image = place_on_white_canvas(
                        &resample_bilevel(&image, content_width, content_height),
                        target_width,
                        target_height,
                        left,
                        top,
                    );
                    pbm::write_p4_atomic(bilevel_path, &canvas_image)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                } else if output.is_color {
                    let image = raster::read_image(
                        &output.output_path,
                        output.options.max_pixels,
                        output.options.max_dimension,
                    )?
                    .rgb;
                    let canvas_image = place_rgb_on_white_canvas(
                        &image.resample_to_dimensions(content_width, content_height),
                        target_width,
                        target_height,
                        left,
                        top,
                    );
                    png::write_rgb_atomic(&output.output_path, &canvas_image)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                } else {
                    let image = raster::read_gray(
                        &output.output_path,
                        output.options.max_pixels,
                        output.options.max_dimension,
                    )
                    .map_err(map_image_error)?;
                    let canvas_image = place_on_white_canvas(
                        &image.resample_to_dimensions(content_width, content_height),
                        target_width,
                        target_height,
                        left,
                        top,
                    );
                    png::write_gray_atomic(&output.output_path, &canvas_image)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                }
            }
            if !preview_mode {
                // The published raster is the canvas now, so the intrinsic
                // dimensions the assembler and the renderer read are the ones
                // it actually carries.
                metadata.output_width = content_width;
                metadata.output_height = content_height;
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
                    let mask = place_on_white_canvas(
                        &resample_bilevel(&mask, content_width, content_height),
                        target_width,
                        target_height,
                        left,
                        top,
                    );
                    pbm::write_p4_atomic(mask_path, &mask)
                        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;

                    // The background carries the same page at a coarser grid,
                    // so it is normalized on its own grid rather than on the
                    // mask's: the pair keeps the ratio the assembler expects.
                    let background_dpi = metadata
                        .layered_background_dpi
                        .unwrap_or(output.options.source_dpi().min(output.options.dpi));
                    let background_ratio = background_dpi / output.options.dpi;
                    let on_background_grid =
                        |value: usize| ((value as f64 * background_ratio).round() as usize).max(1);
                    let background_width = on_background_grid(target_width);
                    let background_height = on_background_grid(target_height);
                    let background_content_width =
                        on_background_grid(content_width).min(background_width);
                    let background_content_height =
                        on_background_grid(content_height).min(background_height);
                    let background_left = ((left as f64 * background_ratio).round() as usize)
                        .min(background_width - background_content_width);
                    let background_top = ((top as f64 * background_ratio).round() as usize)
                        .min(background_height - background_content_height);
                    if output.is_color {
                        let background = raster::read_image(
                            background_path,
                            output.options.max_pixels,
                            output.options.max_dimension,
                        )?
                        .rgb;
                        let background = place_rgb_on_white_canvas(
                            &background.resample_to_dimensions(
                                background_content_width,
                                background_content_height,
                            ),
                            background_width,
                            background_height,
                            background_left,
                            background_top,
                        );
                        png::write_rgb_atomic(background_path, &background)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    } else {
                        let background = raster::read_gray(
                            background_path,
                            output.options.max_pixels,
                            output.options.max_dimension,
                        )
                        .map_err(map_image_error)?;
                        let background = place_on_white_canvas(
                            &background.resample_to_dimensions(
                                background_content_width,
                                background_content_height,
                            ),
                            background_width,
                            background_height,
                            background_left,
                            background_top,
                        );
                        png::write_gray_atomic(background_path, &background)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    }
                    Ok(())
                })();
                // The layer pair is this page's only raster once publication
                // succeeded, so a failure here has nothing left to fall back to.
                layer_result?;
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

/// Resamples a bilevel page and keeps it bilevel: the interpolated edge is
/// resolved back to ink or paper, because P4 carries nothing in between.
fn resample_bilevel(source: &GrayImage, width: usize, height: usize) -> GrayImage {
    let mut resampled = source.resample_to_dimensions(width, height);
    for y in 0..resampled.height() {
        for x in 0..resampled.width() {
            resampled.set(x, y, if resampled.get(x, y) < 128 { 0 } else { 255 });
        }
    }
    resampled
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
        adaptive_thread_count, estimate_peak_page_bytes, manifest_worker_threads,
        preserve_tier1_provenance_after_rerun, robust_quantile_dimension, PageResultMetadata,
        Tier1Provenance, FALLBACK_SYSTEM_MEMORY_BYTES,
    };
    use crate::{
        protocol::manifest_v3::{
            CanvasScope, ManifestV3, Operation, Page, RenderMode, SplitSeamPolyline, VERSION,
        },
        split::{ClusterDimensions, DocumentPrior, LayoutClassification},
        CleanupOptions, OrthogonalRotation, OutputMode,
    };
    use scan_primitives::{GrayImage, Point};
    use std::{fs, path::PathBuf};

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
    fn peak_page_estimate_tracks_measured_resident_high_water() {
        // Reference document, 2119x3204 gray page, 32-page Bw batch at five
        // workers, measured peak RSS 1.60 GB (audit-jul-25 U22 / SCP3). The
        // sizing model is cache budget plus one peak page per worker; it has to
        // land within +/-25 % of that or the worker budget admits threads the
        // host cannot hold.
        const MEASURED_PEAK_BYTES: f64 = 1.60e9;
        let modelled = (256 * 1024 * 1024) as f64
            + 5.0 * estimate_peak_page_bytes(2119, 3204, OutputMode::Bw) as f64;
        let ratio = modelled / MEASURED_PEAK_BYTES;
        assert!(
            (0.75..=1.25).contains(&ratio),
            "modelled {modelled:.0} B is {ratio:.2}x the measured 1.60 GB peak",
        );
    }

    #[test]
    fn worker_sizing_follows_the_host_memory_the_manifest_reports() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-worker-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(2_000, 1_500, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |host_memory_bytes| ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes,
            pages: (0..8)
                .map(|index| Page {
                    input_path: input.clone(),
                    source_page_index: index,
                    page_metadata_path: PathBuf::from("page.json"),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let constrained = manifest_worker_threads(&manifest(Some(64 * 1024 * 1024))).unwrap();
        let roomy = manifest_worker_threads(&manifest(Some(32 * 1024 * 1024 * 1024))).unwrap();

        assert_eq!(constrained, 1);
        assert!(
            roomy > constrained,
            "a roomy host must not be sized like a 64 MiB one (roomy={roomy})"
        );
        assert_eq!(
            manifest_worker_threads(&manifest(None)).unwrap(),
            manifest_worker_threads(&manifest(Some(FALLBACK_SYSTEM_MEMORY_BYTES))).unwrap()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn color_peak_estimate_accounts_for_rgb_working_copies() {
        assert_eq!(estimate_peak_page_bytes(100, 50, OutputMode::Bw), 200_000);
        assert_eq!(
            estimate_peak_page_bytes(100, 50, OutputMode::Color),
            400_000
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
