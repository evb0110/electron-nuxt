use crate::adapters::manifest_publication::run_manifest_transaction;
use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::engine::batch_reconciliation::reconcile_classification_batch;
use crate::engine::output_geometry::match_page_sizes;
use crate::engine::page_statistics::{run_classification, run_page};
use crate::engine::resource_planning::{cache_budget_bytes, run_page_jobs};
use crate::engine::staged_input::{manifest_has_stream_inputs, with_staged_page_input};
use crate::mode_select::{OutputModeDiagnostics, OutputModeRecommendationReason};
use crate::{
    cache::{ByteLru, PageCache, SourceFingerprint},
    ink_consistency::{
        minority_selection_mask, stroke_mass_metrics, DocumentInkPrior, DocumentInkSample,
        PageInkConsistencyContext,
    },
    io::raster,
    pipeline::AnalysisOutputMetadata,
    png,
    protocol::{
        manifest_v3::{
            normalized_path, AnalysisPurpose, CanvasScope, DocumentCanvas, ManifestV3, Operation,
            Page, PageOutput, RenderMode,
        },
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use scan_primitives::GrayImage;
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const LAYERED_BACKGROUND_MAX_DPI: f64 = 200.0;
const PHOTO_BACKGROUND_MAX_DPI: f64 = 300.0;
pub(crate) const FOLD_TAIL_NEAR_PAPER_FLOOR: u8 = 250;
const MAX_MANIFEST_BYTES: usize = 256 * 1024 * 1024;

pub(crate) fn layered_background_dpi(options: &CleanupOptions, confirmed_picture: bool) -> f64 {
    let max_dpi = if confirmed_picture {
        PHOTO_BACKGROUND_MAX_DPI
    } else {
        LAYERED_BACKGROUND_MAX_DPI
    };
    options
        .source_background_dpi()
        .min(options.dpi)
        .min(max_dpi)
}

pub(crate) fn background_canvas_dimensions(
    canvas: &DocumentCanvas,
    background_dpi: f64,
) -> (usize, usize) {
    let background_canvas = canvas.at_dpi(background_dpi);
    (background_canvas.width_px, background_canvas.height_px)
}

pub(crate) fn background_dimensions_to_publish(
    actual_width: usize,
    actual_height: usize,
    target_width: usize,
    target_height: usize,
) -> (usize, usize) {
    // An exact match must stay on its existing coarse grid. Any one-pixel
    // rounding discrepancy is corrected to the authoritative physical target,
    // never multiplied by another DPI ratio from the current dimensions.
    if actual_width == target_width && actual_height == target_height {
        (actual_width, actual_height)
    } else {
        (target_width, target_height)
    }
}

pub(crate) struct WrittenOutput {
    pub(crate) output_path: PathBuf,
    pub(crate) metadata_path: PathBuf,
    pub(crate) bilevel_output_path: Option<PathBuf>,
    pub(crate) background_output_path: Option<PathBuf>,
    pub(crate) foreground_mask_output_path: Option<PathBuf>,
    pub(crate) foreground_alpha_output_path: Option<PathBuf>,
    pub(crate) picture_mask_output_path: Option<PathBuf>,
    pub(crate) tone_preservation_alpha_output_path: Option<PathBuf>,
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) half: crate::pipeline::PageHalf,
    pub(crate) width: usize,
    pub(crate) height: usize,
    /// The logical paper frame this output is responsible for, in the pixels
    /// the source sheet was rendered at. This deliberately differs from the
    /// source region: an off-centre cutter selects unequal pixel regions but
    /// does not put the two leaves at different physical scales.
    pub(crate) paper_width: f64,
    pub(crate) paper_height: f64,
    pub(crate) content_detected: bool,
    /// The first visible content row in this output's intrinsic raster. Kept
    /// in memory so deferred matched-canvas placement can use the exact same
    /// spread anchor as the in-memory final path without adding protocol
    /// metadata.
    pub(crate) spread_content_top: Option<f64>,
    /// The transformed horizontal ownership box in the intrinsic raster.
    /// Deferred preview placement needs the same optical input as the
    /// in-memory final path without extending protocol metadata.
    pub(crate) optical_content_bounds_x: Option<(f64, f64)>,
    /// Consecutive provably-paper columns at this leaf's fold edge, measured
    /// before deferred matched-canvas placement.
    pub(crate) fold_side_near_paper_run: usize,
    /// Consecutive provably-paper columns at the outer edges. These prove that
    /// optical placement may preserve a signed raster origin without ink loss.
    pub(crate) outer_near_paper_edge_runs: NearPaperEdgeRuns,
    pub(crate) matched_in_memory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageResultMetadata {
    pub(crate) source_page_index: usize,
    pub(crate) layout_classification: crate::split::LayoutClassification,
    pub(crate) layout_confidence: f64,
    pub(crate) cutter_x_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub(crate) rotation_degrees: OrthogonalRotation,
    pub(crate) canvas_scope: CanvasScope,
    pub(crate) excluded: bool,
    pub(crate) blank_outputs_skipped: usize,
    pub(crate) output_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) outputs: Vec<AnalysisOutputMetadata>,
    pub(crate) tier1_verdict: crate::split::LayoutClassification,
    pub(crate) reconciled: bool,
    pub(crate) cluster_agreement: f64,
    pub(crate) split_diagnostics: crate::split::SplitDiagnostics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) document_prior: Option<crate::split::DocumentPrior>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text_axis: Option<crate::engine::text_axis::TextAxisHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode: Option<OutputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode_reason: Option<OutputModeRecommendationReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) soft_alpha_foreground_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_mode_diagnostics: Option<OutputModeDiagnostics>,
    #[serde(skip)]
    pub(crate) rotated_width: usize,
    #[serde(skip)]
    pub(crate) rotated_height: usize,
    #[serde(skip)]
    pub(crate) candidate_cutter_ratio: Option<f64>,
    #[serde(skip)]
    pub(crate) whitespace_score: f64,
    #[serde(skip)]
    pub(crate) reconciliation_eligible: bool,
    #[serde(skip)]
    pub(crate) tier1_confidence: f64,
    #[serde(skip)]
    pub(crate) calibration_stroke_width_px: Option<f64>,
    #[serde(skip)]
    pub(crate) calibration_x_height_px: Option<f64>,
}

pub(crate) struct PageRunResult {
    pub(crate) outputs: Vec<WrittenOutput>,
    pub(crate) metadata: PageResultMetadata,
    pub(crate) page_metadata_path: PathBuf,
    pub(crate) timings: PageStageTimings,
}

#[derive(Clone, Copy)]
pub(crate) struct Tier1Provenance {
    pub(crate) verdict: LayoutClassification,
    pub(crate) confidence: f64,
    pub(crate) candidate_cutter_ratio: Option<f64>,
    pub(crate) whitespace_score: f64,
}

pub(crate) fn manifest_cache(
    operation: Operation,
    host_memory_bytes: Option<u64>,
) -> Arc<Mutex<ByteLru>> {
    Arc::new(Mutex::new(ByteLru::new(cache_budget_bytes(
        operation,
        host_memory_bytes,
    ))))
}

pub(crate) fn page_cache_for(
    page: &Page,
    shared: &Arc<Mutex<ByteLru>>,
) -> Result<PageCache, NativeError> {
    let source = SourceFingerprint::from_path(&page.input_path, page.source_page_index)
        .map_err(|error| map_page_io_error(error, &page.input_path, page.source_page_index))?;
    Ok(PageCache::new(Arc::clone(shared), source))
}

#[derive(Debug, Eq, PartialEq)]
enum ScanCleanupCliInvocation {
    Direct {
        input: PathBuf,
        output: PathBuf,
        metadata: PathBuf,
        options: Option<String>,
        ocr_mode: bool,
        experimental_auto_dewarp: bool,
    },
    Manifest {
        path: PathBuf,
        allowed_path_root: Option<PathBuf>,
    },
}

fn cli_value<'a>(
    args: &'a [String],
    index: &mut usize,
    flag: &str,
) -> Result<&'a str, NativeError> {
    let value = args
        .get(*index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| invalid(format!("{flag} requires a value")))?;
    *index += 2;
    Ok(value)
}

fn parse_cli_args(args: &[String]) -> Result<ScanCleanupCliInvocation, NativeError> {
    let mut seen = HashSet::new();
    let mut manifest = None;
    let mut allowed_path_root = None;
    let mut input = None;
    let mut output = None;
    let mut metadata = None;
    let mut options = None;
    let mut ocr_mode = false;
    let mut experimental_auto_dewarp = false;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            return Err(invalid(format!(
                "Unexpected positional argument {}",
                args[index]
            )));
        }
        if !seen.insert(flag) {
            return Err(invalid(format!("Duplicate argument {flag}")));
        }
        match flag {
            "--manifest" => manifest = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--allowed-path-root" => {
                allowed_path_root = Some(PathBuf::from(cli_value(args, &mut index, flag)?))
            }
            "--input" => input = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--output" => output = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--metadata" => metadata = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--options" => options = Some(cli_value(args, &mut index, flag)?.to_string()),
            "--ocr-mode" => {
                ocr_mode = true;
                index += 1;
            }
            "--experimental-auto-dewarp" => {
                experimental_auto_dewarp = true;
                index += 1;
            }
            _ => return Err(invalid(format!("Unknown argument {flag}"))),
        }
    }

    if let Some(path) = manifest {
        if input.is_some()
            || output.is_some()
            || metadata.is_some()
            || options.is_some()
            || ocr_mode
            || experimental_auto_dewarp
        {
            return Err(invalid(
                "--manifest cannot be combined with direct-mode arguments",
            ));
        }
        return Ok(ScanCleanupCliInvocation::Manifest {
            path,
            allowed_path_root,
        });
    }

    if allowed_path_root.is_some() {
        return Err(invalid("--allowed-path-root requires --manifest"));
    }

    Ok(ScanCleanupCliInvocation::Direct {
        input: input.ok_or_else(|| invalid("Missing required argument --input"))?,
        output: output.ok_or_else(|| invalid("Missing required argument --output"))?,
        metadata: metadata.ok_or_else(|| invalid("Missing required argument --metadata"))?,
        options,
        ocr_mode,
        experimental_auto_dewarp,
    })
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = args.into_iter().collect();
    let (input, output, metadata, options, ocr_mode, experimental_auto_dewarp) =
        match parse_cli_args(&args)? {
            ScanCleanupCliInvocation::Direct {
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            } => (
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            ),
            ScanCleanupCliInvocation::Manifest {
                path,
                allowed_path_root,
            } => return run_manifest(&path, allowed_path_root.as_deref()),
        };
    let mut options = options
        .as_deref()
        .map(parse_options)
        .transpose()?
        .unwrap_or_default();
    if ocr_mode {
        options.ocr_mode = true;
    }
    if experimental_auto_dewarp {
        options.experimental.auto_dewarp = true;
    }
    let page = Page {
        input_path: input,
        analysis_input_path: None,
        analysis_dpi: None,
        trusted_foreground_mask_path: None,
        trusted_mrc_background_path: None,
        outputs: Vec::new(),
        source_page_index: 0,
        page_metadata_path: metadata.clone(),
        options,
        document_prior: None,
        detail_render_plan: None,
    };
    let cache = manifest_cache(Operation::Render, None);
    let page_cache = page_cache_for(&page, &cache)?;
    run_page(
        &page,
        CanvasScope::Page,
        false,
        None,
        Some((&output, &metadata)),
        None,
        &page_cache,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path, allowed_path_root: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let manifest: ManifestV3 =
        deserialize_json_file_bounded(path, MAX_MANIFEST_BYTES, "v3 batch manifest")?;
    manifest.validate_for_execution()?;
    if let Some(root) = allowed_path_root {
        assert_manifest_paths_within_root(&manifest, root)?;
    }
    preflight_manifest_paths(&manifest)?;
    let total = manifest.pages.len();
    let result = run_manifest_transaction(&manifest, || run_manifest_inner(&manifest));
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

pub(crate) fn trusted_selection_is_incomplete(
    selection_width: usize,
    background_width: usize,
) -> bool {
    background_width.saturating_mul(2) > selection_width
}

fn derive_page_ink_sample(page: &Page) -> Result<Option<DocumentInkSample>, NativeError> {
    if page.options.output_mode != OutputMode::Bw
        || !page.options.source_has_bilevel_layer
        || page.options.thickness != 0
    {
        return Ok(None);
    }
    let Some(selection_path) = page.trusted_foreground_mask_path.as_ref() else {
        return Ok(None);
    };
    let Some(background_path) = page.trusted_mrc_background_path.as_ref() else {
        return Ok(None);
    };
    let selection = raster::read_foreground_selection(
        selection_path,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .map_err(|error| map_raster_error(error, selection_path, page.source_page_index))?;
    let (background_width, _) = raster::read_dimensions(
        background_path,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .map_err(|error| map_raster_error(error, background_path, page.source_page_index))?;
    if trusted_selection_is_incomplete(selection.width(), background_width) {
        return Ok(None);
    }
    let Some(ink) = minority_selection_mask(&selection) else {
        return Ok(None);
    };
    let Some(metrics) = stroke_mass_metrics(&ink) else {
        return Ok(None);
    };
    Ok(Some(DocumentInkSample {
        metrics,
        width: ink.width(),
        height: ink.height(),
    }))
}

pub(crate) fn derive_page_ink_contexts(
    manifest: &ManifestV3,
) -> Result<Vec<Option<PageInkConsistencyContext>>, Box<dyn Error>> {
    if !manifest.pages.iter().any(|page| {
        page.trusted_foreground_mask_path.is_some()
            && page.trusted_mrc_background_path.is_some()
            && page.options.output_mode == OutputMode::Bw
            && page.options.source_has_bilevel_layer
            && page.options.thickness == 0
    }) {
        return Ok(vec![None; manifest.pages.len()]);
    }
    // Trusted MRC masks are separate, replayable inputs. Use the same
    // memory-derived page bound as the real work for regular manifests, but
    // never hand a streamed input to `run_page_jobs`: doing so would consume a
    // one-shot FIFO before the render pass gets its turn. Streamed renders use
    // the conservative serial prepass instead.
    let samples = if manifest_has_stream_inputs(manifest) {
        manifest
            .pages
            .iter()
            .map(derive_page_ink_sample)
            .collect::<Result<Vec<_>, _>>()?
    } else {
        run_page_jobs(manifest, |(_, page)| derive_page_ink_sample(page))?
    };
    let Some(prior) = DocumentInkPrior::from_page_samples(samples.iter().flatten().copied()) else {
        return Ok(vec![None; samples.len()]);
    };
    Ok(samples
        .into_iter()
        .map(|source_sample| {
            source_sample.map(|source_sample| PageInkConsistencyContext {
                prior,
                source_sample,
            })
        })
        .collect())
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
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    let cache = manifest_cache(manifest.operation, manifest.host_memory_bytes);
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
    let page_ink_contexts = if analyzing {
        vec![None; manifest.pages.len()]
    } else {
        derive_page_ink_contexts(manifest)?
    };
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let run_analysis = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let result = with_staged_page_input(manifest, page, || {
            let page_cache = page_cache_for(page, &cache)?;
            run_classification(
                page,
                manifest.canvas_scope,
                page.document_prior,
                true,
                plan_content,
                &page_cache,
            )
            .map_err(|error| {
                let envelope = NativeErrorEnvelope::from_error(error.as_ref());
                NativeError::new(envelope.code, envelope.message)
            })
        })?;
        // Publish the page's independent verdict immediately. Document
        // reconciliation may revise it after the batch finishes, at which
        // point PageComplete replaces this provisional result. Keeping the
        // useful fields off PageAnalyzed forced every thumbnail to spin until
        // the slowest page in a large document had finished.
        let mut progress = page_complete_progress(&result, index, total_pages);
        progress.stage = ProgressStage::PageAnalyzed;
        progress.output_paths = None;
        report_page(index, progress)?;
        Ok(result)
    };
    let run_one = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        let result = run_page(
            page,
            manifest.canvas_scope,
            manifest.render_mode == RenderMode::Final,
            manifest.document_canvas,
            None,
            page_ink_contexts[index],
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
    for (index, page_result) in page_results.iter().enumerate() {
        write_json_atomic(&page_result.page_metadata_path, &page_result.metadata)?;
        if analyzing {
            write_progress(page_complete_progress(page_result, index, total_pages))?;
        }
    }
    let written_outputs = page_results
        .iter()
        .flat_map(|page_result| page_result.outputs.iter())
        .collect::<Vec<_>>();
    match_page_sizes(&written_outputs, manifest.document_canvas)?;
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
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    Ok(())
}

pub(crate) fn write_progress(progress: Progress) -> Result<(), Box<dyn Error>> {
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
        soft_alpha_foreground_recommendation: metadata.soft_alpha_foreground_recommendation,
        output_mode_diagnostics: metadata.output_mode_diagnostics,
    }
}

pub(crate) fn assert_manifest_paths_within_root(
    manifest: &ManifestV3,
    root: &Path,
) -> Result<(), NativeError> {
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        invalid(format!(
            "Allowed path root is not an existing directory: {} ({error})",
            root.display()
        ))
    })?;
    if !canonical_root.is_dir() {
        return Err(invalid(format!(
            "Allowed path root is not a directory: {}",
            root.display()
        )));
    }
    let canonical_root = normalized_path(&canonical_root);
    for path in manifest
        .input_paths()
        .into_iter()
        .chain(manifest.destination_paths())
    {
        // An entry that exists but cannot be resolved is a dangling or looping
        // symlink: it names no directory this root can vouch for.
        if fs::symlink_metadata(path).is_ok() && fs::canonicalize(path).is_err() {
            return Err(invalid(format!(
                "Manifest path cannot be resolved: {}",
                path.display()
            )));
        }
        if !resolved_manifest_path(path).starts_with(&canonical_root) {
            return Err(invalid(format!(
                "Manifest path escapes the allowed path root: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn preflight_manifest_paths(manifest: &ManifestV3) -> Result<(), NativeError> {
    let mut input_paths = HashSet::new();
    let mut input_files = HashSet::new();
    for path in manifest.input_paths() {
        input_paths.insert(resolved_manifest_path(path));
        if let Some(identity) = existing_file_identity(path) {
            input_files.insert(identity);
        }
    }

    let mut destination_paths = HashSet::new();
    let mut destination_files = HashSet::new();
    for path in manifest.destination_paths() {
        let resolved = resolved_manifest_path(path);
        if input_paths.contains(&resolved)
            || existing_file_identity(path).is_some_and(|identity| input_files.contains(&identity))
        {
            return Err(invalid(format!(
                "Output destination aliases an input file: {}",
                path.display()
            )));
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() => {
                // An existing directory is never replaced by our atomic file
                // writers. Optional bilevel/layer destinations intentionally
                // use this to exercise their composite fallback.
            }
            Ok(metadata) if metadata.is_file() => {
                // Batch publication snapshots regular files into randomized,
                // exclusively-created same-directory backups before workers
                // run, then discards or restores them transactionally.
            }
            Ok(_) => {
                return Err(invalid(format!(
                    "Output destination must be a regular file or directory: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(NativeError::new(
                    NativeErrorCode::Io,
                    format!(
                        "Unable to inspect output destination {}: {error}",
                        path.display()
                    ),
                ));
            }
        }
        if !destination_paths.insert(resolved)
            || existing_file_identity(path)
                .is_some_and(|identity| !destination_files.insert(identity))
        {
            return Err(invalid(format!(
                "Output destinations must refer to different files: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn resolved_manifest_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        normalized_path(path)
    } else {
        std::env::current_dir()
            .map(|directory| normalized_path(&directory.join(path)))
            .unwrap_or_else(|_| normalized_path(path))
    };
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        if let Ok(mut resolved) = fs::canonicalize(ancestor) {
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return normalized_path(&resolved);
        }
        let Some(file_name) = ancestor.file_name() else {
            return absolute;
        };
        missing.push(file_name.to_owned());
        let Some(parent) = ancestor.parent() else {
            return absolute;
        };
        ancestor = parent;
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ExistingFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn existing_file_identity(path: &Path) -> Option<ExistingFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(path)
        .ok()
        .map(|metadata| ExistingFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
}

#[cfg(not(unix))]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ExistingFileIdentity;

#[cfg(not(unix))]
fn existing_file_identity(_path: &Path) -> Option<ExistingFileIdentity> {
    None
}
pub(crate) fn write_gray_layer_background(path: &Path, image: &GrayImage) -> Result<(), String> {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ppm"))
    {
        raster::write_gray_ppm_atomic(path, image)
    } else if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pgm"))
    {
        raster::write_gray_pgm_atomic(path, image)
    } else {
        png::write_gray_atomic(path, image)
    }
}

pub(crate) const CANVAS_GRID_TOLERANCE_PX: f64 = 1.0;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct NearPaperEdgeRuns {
    pub(crate) left: usize,
    pub(crate) right: usize,
}

pub(crate) const PLACEMENT_CENTERING_BOUNDS_X: Option<(f64, f64)> = None;
pub(crate) fn resolve_destinations(
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
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        }]);
    }
    Ok((0..output_count)
        .map(|index| PageOutput {
            output_path: suffixed_path(output, index),
            metadata_path: suffixed_path(metadata, index),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
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

pub(crate) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::io::write_atomic(path, &bytes).map_err(|error| std::io::Error::other(error).into())
}

pub(crate) fn map_page_io_error(
    error: std::io::Error,
    path: &Path,
    page_index: usize,
) -> NativeError {
    NativeError::new(
        NativeErrorCode::Io,
        format!(
            "Unable to read scan-cleanup input for page {} ({}): {error}",
            page_index + 1,
            path.display(),
        ),
    )
}

pub(crate) fn map_raster_error(
    error: raster::RasterReadError,
    path: &Path,
    page_index: usize,
) -> NativeError {
    let code = match error {
        raster::RasterReadError::Io(_) => NativeErrorCode::Io,
        raster::RasterReadError::Invalid(_) => NativeErrorCode::InvalidRequest,
        raster::RasterReadError::TooLarge(_) => NativeErrorCode::TooLarge,
    };
    NativeError::new(
        code,
        format!(
            "Unable to read scan-cleanup raster for page {} ({}): {error}",
            page_index + 1,
            path.display(),
        ),
    )
}

pub(crate) fn map_image_error(message: String) -> NativeError {
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
        map_image_error, map_page_io_error, map_raster_error, parse_cli_args,
        write_gray_layer_background, ScanCleanupCliInvocation,
    };
    use crate::engine::page_statistics::normalize_trusted_foreground_selection;
    use crate::io::raster::RasterReadError;
    use evb_native_support::NativeErrorCode;
    use scan_primitives::{BinaryImage, GrayImage};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn cli_args(args: &[&str]) -> Vec<String> {
        args.iter()
            .map(|argument| (*argument).to_string())
            .collect()
    }

    #[test]
    fn strict_cli_parser_preserves_documented_invocations() {
        assert_eq!(
            parse_cli_args(&cli_args(&["--manifest", "/tmp/manifest.json"])).unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: None,
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--manifest",
                "/tmp/manifest.json",
                "--allowed-path-root",
                "/tmp/run-root",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: Some(PathBuf::from("/tmp/run-root")),
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--ocr-mode",
                "--metadata",
                "/tmp/page.json",
                "--output",
                "/tmp/page.png",
                "--experimental-auto-dewarp",
                "--input",
                "/tmp/page.ppm",
                "--options",
                "{}",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Direct {
                input: PathBuf::from("/tmp/page.ppm"),
                output: PathBuf::from("/tmp/page.png"),
                metadata: PathBuf::from("/tmp/page.json"),
                options: Some("{}".to_string()),
                ocr_mode: true,
                experimental_auto_dewarp: true,
            },
        );
    }

    #[test]
    fn strict_cli_parser_rejects_unknown_duplicate_missing_and_invalid_arguments() {
        let cases: &[(&[&str], &str)] = &[
            (&["--manifest"], "--manifest requires a value"),
            (&["--manifest", ""], "--manifest requires a value"),
            (
                &["--manifest", "/tmp/a.json", "--manifest", "/tmp/b.json"],
                "Duplicate argument --manifest",
            ),
            (
                &["--manifest", "/tmp/a.json", "--unknown"],
                "Unknown argument --unknown",
            ),
            (
                &["--manifest", "/tmp/a.json", "--input", "/tmp/page.ppm"],
                "--manifest cannot be combined with direct-mode arguments",
            ),
            (
                &["--input", "/tmp/page.ppm", "--output"],
                "--output requires a value",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--input",
                    "/tmp/other.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                ],
                "Duplicate argument --input",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--ocr-mode",
                    "true",
                ],
                "Unexpected positional argument true",
            ),
            (
                &["--allowed-path-root"],
                "--allowed-path-root requires a value",
            ),
            (
                &[
                    "--manifest",
                    "/tmp/a.json",
                    "--allowed-path-root",
                    "/tmp/root",
                    "--allowed-path-root",
                    "/tmp/other",
                ],
                "Duplicate argument --allowed-path-root",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--allowed-path-root",
                    "/tmp/root",
                ],
                "--allowed-path-root requires --manifest",
            ),
            (&["--input=page.ppm"], "Unknown argument --input=page.ppm"),
            (&["--version"], "Unknown argument --version"),
            (&["-V"], "Unexpected positional argument -V"),
            (&["unflagged"], "Unexpected positional argument unflagged"),
        ];

        for (args, expected) in cases {
            let error = parse_cli_args(&cli_args(args)).unwrap_err();
            assert_eq!(
                error.code,
                NativeErrorCode::InvalidRequest,
                "args: {args:?}"
            );
            assert_eq!(error.message, *expected, "args: {args:?}");
        }
    }

    #[test]
    fn strict_direct_cli_reports_each_required_value() {
        for (args, missing) in [
            (vec![], "--input"),
            (vec!["--input", "in.ppm"], "--output"),
            (
                vec!["--input", "in.ppm", "--output", "out.png"],
                "--metadata",
            ),
        ] {
            let error = parse_cli_args(&cli_args(&args)).unwrap_err();
            assert_eq!(error.code, NativeErrorCode::InvalidRequest);
            assert_eq!(
                error.message,
                format!("Missing required argument {missing}")
            );
        }
    }

    #[test]
    fn derived_geometry_guardrail_errors_are_too_large() {
        assert_eq!(
            map_image_error("Derived raster 100x100 exceeds cleanup guardrails".into()).code,
            NativeErrorCode::TooLarge,
        );
        assert_eq!(
            map_image_error("Derived content geometry must be finite".into()).code,
            NativeErrorCode::InvalidRequest,
        );
    }

    #[test]
    fn raster_io_errors_keep_their_code_and_page_context() {
        let path = Path::new("/tmp/missing-scan-cleanup-input.png");
        let metadata_error = map_page_io_error(
            std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory"),
            path,
            2,
        );
        assert_eq!(metadata_error.code, NativeErrorCode::Io);
        assert!(metadata_error.message.contains("page 3"));
        assert!(metadata_error.message.contains(path.to_str().unwrap()));

        let io_error = map_raster_error(
            RasterReadError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No such file or directory",
            )),
            path,
            2,
        );
        assert_eq!(io_error.code, NativeErrorCode::Io);
        assert!(io_error.message.contains("page 3"));
        assert!(io_error.message.contains(path.to_str().unwrap()));

        let invalid_error = map_raster_error(
            RasterReadError::Invalid("invalid PNG signature".to_string()),
            path,
            2,
        );
        assert_eq!(invalid_error.code, NativeErrorCode::InvalidRequest);

        let too_large_error = map_raster_error(
            RasterReadError::TooLarge("input exceeds guardrails".to_string()),
            path,
            2,
        );
        assert_eq!(too_large_error.code, NativeErrorCode::TooLarge);
    }

    #[test]
    fn gray_background_uses_pgm_encoding_for_pgm_paths() {
        let path = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-gray-background-{}.pgm",
            std::process::id()
        ));
        let image = GrayImage::new(2, 1, 127);
        write_gray_layer_background(&path, &image).unwrap();
        let bytes = fs::read(&path).unwrap();
        let header = b"P5\n2 1\n255\n";
        assert!(bytes.starts_with(header));
        assert_eq!(&bytes[header.len()..], &[127, 127]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn trusted_mrc_foreground_uses_sparse_marks_for_either_soft_mask_polarity() {
        let mut source = GrayImage::new(8, 4, 176);
        for x in 2..6 {
            source.set(x, 2, 18);
        }
        let mut sparse_white = GrayImage::new(8, 4, 0);
        let mut dense_white = GrayImage::new(8, 4, 255);
        for x in 2..6 {
            sparse_white.set(x, 2, 255);
            dense_white.set(x, 2, 0);
        }

        let expected = BinaryImage::from_fn_parallel(8, 4, |x, y| y == 2 && (2..6).contains(&x));
        assert_eq!(
            normalize_trusted_foreground_selection(&sparse_white, &source),
            expected
        );
        assert_eq!(
            normalize_trusted_foreground_selection(&dense_white, &source),
            expected
        );
    }
}
