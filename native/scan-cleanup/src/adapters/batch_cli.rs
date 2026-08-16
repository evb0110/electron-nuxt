use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::engine::render::{
    analyze_page_with_color_and_document_prior_cached, clean_detail_page_with_color,
    clean_page_with_color_and_document_prior_cached, downscale_rgb_to_dimensions,
    CanonicalAnalysisPlane, CleanupRaster, CleanupResult, DetailRenderSources,
    LayeredForegroundKind,
};
use crate::mode_select::{OutputModeDiagnostics, OutputModeRecommendationReason};
use crate::{
    bw::paper_reference,
    cache::{ByteLru, PageCache, SourceFingerprint, StageCacheKey, DEFAULT_CACHE_BUDGET_BYTES},
    ink_consistency::{
        minority_selection_mask, stroke_mass_metrics, DocumentInkPrior, DocumentInkSample,
        PageInkConsistencyContext,
    },
    io::{
        copy_bounded_cancelable, pbm, raster, BoundedIoError, StagedFileBackup,
        MAX_STREAM_INPUT_BYTES,
    },
    pipeline::{AnalysisOutputMetadata, CleanupMetadata, MatchedCanvasPolicy},
    png::{self, RgbImage},
    protocol::{
        manifest_v3::{
            normalized_path, AnalysisPurpose, CanvasScope, DocumentCanvas, ManifestV3, Operation,
            Page, PageOutput, RenderMode,
        },
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    CleanupOptions, OrthogonalRotation, OutputMode, PROTOCOL_VERSION,
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use rayon::prelude::*;
use scan_primitives::{BinaryImage, GrayImage};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::sync_channel,
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

// Mixed pages use a high-resolution bilevel foreground for text. Their
// continuous-tone plate stays coarse unless a confirmed picture has no
// reusable source-MRC JPX; that fallback gets enough resolution to avoid
// turning a photograph into a 120-DPI thumbnail.
const LAYERED_BACKGROUND_MAX_DPI: f64 = 200.0;
const PHOTO_BACKGROUND_MAX_DPI: f64 = 300.0;
const SOFT_FOREGROUND_MAX_DPI: f64 = 300.0;
/// Display-white floor used as the upper bound for fold-tail paper evidence.
/// A darker leaf lowers the bound to its measured 75th-percentile paper level;
/// one sample below that leaf-specific bound stops the disposable run.
const FOLD_TAIL_NEAR_PAPER_FLOOR: u8 = 250;
const MAX_MANIFEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_DETAIL_METADATA_BYTES: usize = 16 * 1024 * 1024;

fn layered_background_dpi(options: &CleanupOptions, confirmed_picture: bool) -> f64 {
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

fn layered_foreground_dpi(options: &CleanupOptions) -> f64 {
    options
        .source_dpi()
        .min(options.dpi)
        .min(SOFT_FOREGROUND_MAX_DPI)
}

fn background_canvas_dimensions(canvas: &DocumentCanvas, background_dpi: f64) -> (usize, usize) {
    let background_canvas = canvas.at_dpi(background_dpi);
    (background_canvas.width_px, background_canvas.height_px)
}

fn background_dimensions_to_publish(
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

/// A PDF soft mask describes opacity, not semantic ink ownership. Some compact
/// MRC producers attach the high-resolution image to the paper samples and
/// leave the text transparent; others do the opposite. Treating every white
/// sample as text turns the former into a black page with white letters.
///
/// Foreground marks are the less common mask class. This is independent of the
/// paper shade and works for either encoded polarity. An exact coverage tie is
/// resolved by the class that is darker in the flattened source.
fn normalize_trusted_foreground_selection(
    selection: &GrayImage,
    source: &GrayImage,
) -> BinaryImage {
    let high_count = selection
        .data()
        .iter()
        .filter(|&&sample| sample >= 128)
        .count();
    let low_count = selection.data().len().saturating_sub(high_count);
    let high_is_foreground = match high_count.cmp(&low_count) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => {
            let mut high_sum = 0u64;
            let mut low_sum = 0u64;
            for y in 0..selection.height() {
                let source_y = y * source.height() / selection.height().max(1);
                for x in 0..selection.width() {
                    let source_x = x * source.width() / selection.width().max(1);
                    let source_sample = u64::from(source.get(
                        source_x.min(source.width().saturating_sub(1)),
                        source_y.min(source.height().saturating_sub(1)),
                    ));
                    if selection.get(x, y) >= 128 {
                        high_sum += source_sample;
                    } else {
                        low_sum += source_sample;
                    }
                }
            }
            high_sum <= low_sum
        }
    };
    BinaryImage::from_fn_parallel(selection.width(), selection.height(), |x, y| {
        (selection.get(x, y) >= 128) == high_is_foreground
    })
}

struct WrittenOutput {
    output_path: PathBuf,
    metadata_path: PathBuf,
    bilevel_output_path: Option<PathBuf>,
    background_output_path: Option<PathBuf>,
    foreground_mask_output_path: Option<PathBuf>,
    foreground_alpha_output_path: Option<PathBuf>,
    picture_mask_output_path: Option<PathBuf>,
    tone_preservation_alpha_output_path: Option<PathBuf>,
    options: CleanupOptions,
    source_page_index: usize,
    half: crate::pipeline::PageHalf,
    width: usize,
    height: usize,
    /// The logical paper frame this output is responsible for, in the pixels
    /// the source sheet was rendered at. This deliberately differs from the
    /// source region: an off-centre cutter selects unequal pixel regions but
    /// does not put the two leaves at different physical scales.
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    /// The first visible content row in this output's intrinsic raster. Kept
    /// in memory so deferred matched-canvas placement can use the exact same
    /// spread anchor as the in-memory final path without adding protocol
    /// metadata.
    spread_content_top: Option<f64>,
    /// The transformed horizontal ownership box in the intrinsic raster.
    /// Deferred preview placement needs the same optical input as the
    /// in-memory final path without extending protocol metadata.
    optical_content_bounds_x: Option<(f64, f64)>,
    /// Consecutive provably-paper columns at this leaf's fold edge, measured
    /// before deferred matched-canvas placement.
    fold_side_near_paper_run: usize,
    /// Consecutive provably-paper columns at the outer edges. These prove that
    /// optical placement may preserve a signed raster origin without ink loss.
    outer_near_paper_edge_runs: NearPaperEdgeRuns,
    matched_in_memory: bool,
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
    split_diagnostics: crate::split::SplitDiagnostics,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    soft_alpha_foreground_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_mode_diagnostics: Option<OutputModeDiagnostics>,
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
    #[serde(skip)]
    calibration_stroke_width_px: Option<f64>,
    #[serde(skip)]
    calibration_x_height_px: Option<f64>,
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
    Manifest(PathBuf),
    ProtocolVersion,
    Version,
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
    let mut input = None;
    let mut output = None;
    let mut metadata = None;
    let mut options = None;
    let mut ocr_mode = false;
    let mut experimental_auto_dewarp = false;
    let mut protocol_version = false;
    let mut version = false;
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
            "--protocol-version" => {
                protocol_version = true;
                index += 1;
            }
            "--version" => {
                version = true;
                index += 1;
            }
            _ => return Err(invalid(format!("Unknown argument {flag}"))),
        }
    }

    if protocol_version || version {
        if args.len() != 1 {
            let flag = if protocol_version {
                "--protocol-version"
            } else {
                "--version"
            };
            return Err(invalid(format!("{flag} must be used alone")));
        }
        return Ok(if protocol_version {
            ScanCleanupCliInvocation::ProtocolVersion
        } else {
            ScanCleanupCliInvocation::Version
        });
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
        return Ok(ScanCleanupCliInvocation::Manifest(path));
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
            ScanCleanupCliInvocation::Manifest(path) => return run_manifest(&path),
            ScanCleanupCliInvocation::ProtocolVersion => {
                println!("{PROTOCOL_VERSION}");
                return Ok(());
            }
            ScanCleanupCliInvocation::Version => {
                println!("evb-scan-cleanup {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
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
    let cache = manifest_cache(None);
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

fn run_manifest(path: &Path) -> Result<(), Box<dyn Error>> {
    let manifest: ManifestV3 =
        deserialize_json_file_bounded(path, MAX_MANIFEST_BYTES, "v3 batch manifest")?;
    manifest.validate()?;
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

struct ManifestPublicationTransaction {
    destinations: Vec<PathBuf>,
    backups: Vec<StagedFileBackup>,
}

impl ManifestPublicationTransaction {
    fn begin(manifest: &ManifestV3) -> Result<Self, String> {
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        let mut transaction = Self {
            destinations,
            backups: Vec::new(),
        };
        for path in transaction.destinations.clone() {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => match StagedFileBackup::stage(&path) {
                    Ok(backup) => transaction.backups.push(backup),
                    Err(error) => {
                        let restore_error = transaction.restore_backups();
                        return Err(match restore_error {
                            Ok(()) => format!(
                                "Unable to snapshot existing output destination {}: {error}",
                                path.display()
                            ),
                            Err(restore_error) => format!(
                                "Unable to snapshot existing output destination {}: {error}; restoring prior snapshots was incomplete: {restore_error}",
                                path.display()
                            ),
                        });
                    }
                },
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    let restore_error = transaction.restore_backups();
                    return Err(match restore_error {
                        Ok(()) => format!(
                            "Output destination is not a regular file or directory: {}",
                            path.display()
                        ),
                        Err(restore_error) => format!(
                            "Output destination is not a regular file or directory: {}; restoring prior snapshots was incomplete: {restore_error}",
                            path.display()
                        ),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    let restore_error = transaction.restore_backups();
                    return Err(match restore_error {
                        Ok(()) => format!(
                            "Unable to inspect output destination {}: {error}",
                            path.display()
                        ),
                        Err(restore_error) => format!(
                            "Unable to inspect output destination {}: {error}; restoring prior snapshots was incomplete: {restore_error}",
                            path.display()
                        ),
                    });
                }
            }
        }
        Ok(transaction)
    }

    fn restore_backups(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        while let Some(backup) = self.backups.pop() {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.restore() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn commit(self) -> Result<(), String> {
        let mut failures = Vec::new();
        for backup in self.backups {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.discard() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn rollback(mut self) -> Result<(), String> {
        let backed_up = self
            .backups
            .iter()
            .map(|backup| backup.original().to_path_buf())
            .collect::<HashSet<_>>();
        let mut failures = Vec::new();
        for path in &self.destinations {
            if backed_up.contains(path) {
                continue;
            }
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => continue,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            }
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        if let Err(error) = self.restore_backups() {
            failures.push(error);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

fn run_manifest_transaction(
    manifest: &ManifestV3,
    operation: impl FnOnce() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let transaction = ManifestPublicationTransaction::begin(manifest).map_err(|error| {
        NativeError::new(
            NativeErrorCode::Io,
            format!("Unable to prepare scan-cleanup output transaction: {error}"),
        )
    })?;
    match operation() {
        Ok(()) => transaction.commit().map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!("Unable to finalize scan-cleanup output transaction: {error}"),
            )
            .into()
        }),
        Err(operation_error) => match transaction.rollback() {
            Ok(()) => Err(operation_error),
            Err(rollback_error) => Err(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!(
                    "Scan-cleanup batch failed ({operation_error}); rollback was incomplete: {rollback_error}"
                ),
            )
            .into()),
        },
    }
}

fn trusted_selection_is_incomplete(selection_width: usize, background_width: usize) -> bool {
    background_width.saturating_mul(2) > selection_width
}

fn derive_page_ink_sample(page: &Page) -> Option<DocumentInkSample> {
    if page.options.output_mode != OutputMode::Bw
        || !page.options.source_has_bilevel_layer
        || page.options.thickness != 0
    {
        return None;
    }
    let selection = raster::read_foreground_selection(
        page.trusted_foreground_mask_path.as_ref()?,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .ok()?;
    let (background_width, _) = raster::read_dimensions(
        page.trusted_mrc_background_path.as_ref()?,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .ok()?;
    if trusted_selection_is_incomplete(selection.width(), background_width) {
        return None;
    }
    let ink = minority_selection_mask(&selection)?;
    Some(DocumentInkSample {
        metrics: stroke_mass_metrics(&ink)?,
        width: ink.width(),
        height: ink.height(),
    })
}

fn derive_page_ink_contexts(manifest: &ManifestV3) -> Vec<Option<PageInkConsistencyContext>> {
    let samples = manifest
        .pages
        .par_iter()
        .map(derive_page_ink_sample)
        .collect::<Vec<_>>();
    let Some(prior) = DocumentInkPrior::from_page_samples(samples.iter().flatten().copied()) else {
        return vec![None; samples.len()];
    };
    samples
        .into_iter()
        .map(|source_sample| {
            source_sample.map(|source_sample| PageInkConsistencyContext {
                prior,
                source_sample,
            })
        })
        .collect()
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
    let page_ink_contexts = if analyzing {
        vec![None; manifest.pages.len()]
    } else {
        derive_page_ink_contexts(manifest)
    };
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let run_analysis = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let page_cache = page_cache_for(page, &cache)?;
        let result = run_classification(
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

fn run_page_jobs<T, F>(manifest: &ManifestV3, task: F) -> Result<Vec<T>, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &Page)) -> Result<T, NativeError> + Send + Sync,
{
    if manifest_has_stream_inputs(manifest) {
        return run_stream_page_jobs(manifest, task);
    }
    // One pool per manifest, and the process runs one manifest: since the
    // discarded classification pass was removed this is built at most once,
    // and only when it will actually carry more than one page.
    let worker_threads = page_worker_threads(manifest)?;
    let results: Vec<Result<T, NativeError>> = if worker_threads > 1 {
        let processing_threads = std::thread::available_parallelism().map_or(2, usize::from);
        rayon::ThreadPoolBuilder::new()
            // `worker_threads` is a memory-derived limit on pages in flight,
            // not the size of the processing pool. Each page contains nested
            // Rayon stages (thresholding, morphology, composition, and
            // resampling) which must retain access to the host's CPU threads.
            // Building a pool with only the page limit made two large pages
            // run every heavy stage on two total threads.
            .num_threads(processing_threads)
            .thread_name(|index| format!("scan-cleanup-processing-{index}"))
            .build()
            .map_err(|error| invalid(format!("Unable to initialize page workers: {error}")))?
            .install(|| {
                manifest
                    .pages
                    .chunks(worker_threads)
                    .enumerate()
                    .flat_map(|(chunk_index, chunk)| {
                        chunk
                            .par_iter()
                            .enumerate()
                            .map(|(page_index, page)| {
                                task((chunk_index * worker_threads + page_index, page))
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect()
            })
    } else {
        manifest.pages.iter().enumerate().map(task).collect()
    };
    results
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

struct MaterializedStreamPage {
    index: usize,
    page: Page,
    temporary_input: Option<PathBuf>,
}

impl Drop for MaterializedStreamPage {
    fn drop(&mut self) {
        if let Some(path) = &self.temporary_input {
            let _ = fs::remove_file(path);
        }
    }
}

fn manifest_has_stream_inputs(manifest: &ManifestV3) -> bool {
    manifest.pages.iter().any(|page| {
        fs::metadata(&page.input_path).is_ok_and(|metadata| !metadata.file_type().is_file())
    })
}

fn stream_materialized_path(page: &Page, index: usize) -> PathBuf {
    let parent = page
        .page_metadata_path
        .parent()
        .unwrap_or_else(|| Path::new("."));
    parent.join(format!(
        ".scan-cleanup-stream-{}-{index}.raster",
        std::process::id()
    ))
}

fn materialize_stream_page(
    index: usize,
    page: &Page,
    max_bytes: usize,
    is_canceled: impl Fn() -> bool,
) -> Result<MaterializedStreamPage, NativeError> {
    let mut materialized = page.clone();
    if fs::metadata(&page.input_path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        return Ok(MaterializedStreamPage {
            index,
            page: materialized,
            temporary_input: None,
        });
    }
    let temporary_input = stream_materialized_path(page, index);
    let copy_result = (|| -> Result<(), BoundedIoError> {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        let mut destination = fs::File::create(&temporary_input)?;
        #[cfg(unix)]
        {
            use crate::io::copy_bounded_nonblocking_stream_cancelable;
            use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};

            if fs::metadata(&page.input_path)?.file_type().is_fifo() {
                let mut source = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&page.input_path)?;
                copy_bounded_nonblocking_stream_cancelable(
                    &mut source,
                    &mut destination,
                    max_bytes,
                    &is_canceled,
                )?;
                return Ok(());
            }
        }
        let mut source = fs::File::open(&page.input_path)?;
        copy_bounded_cancelable(&mut source, &mut destination, max_bytes, &is_canceled)?;
        Ok(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&temporary_input);
        let code = match &error {
            BoundedIoError::TooLarge { .. } => NativeErrorCode::TooLarge,
            BoundedIoError::Canceled | BoundedIoError::Io(_) => NativeErrorCode::Io,
        };
        return Err(NativeError::new(
            code,
            format!(
                "Unable to materialize streamed scan-cleanup page {}: {error}",
                index + 1
            ),
        ));
    }
    materialized.input_path = temporary_input.clone();
    Ok(MaterializedStreamPage {
        index,
        page: materialized,
        temporary_input: Some(temporary_input),
    })
}

fn run_stream_page_jobs<T, F>(manifest: &ManifestV3, task: F) -> Result<Vec<T>, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &Page)) -> Result<T, NativeError> + Send + Sync,
{
    if manifest.raster_window <= 1 {
        // A FIFO is a one-shot transport, not a replayable page file. Direct
        // callers coordinate no producer window, so keep the conservative
        // acknowledgement turnstile: it never opens an unwritten future FIFO
        // after a task failure and bounds scratch to one raster.
        return thread::scope(|scope| {
            let (sender, receiver) = sync_channel(0);
            let (acknowledge, acknowledged) = sync_channel(0);
            let canceled = Arc::new(AtomicBool::new(false));
            let reader_canceled = Arc::clone(&canceled);
            scope.spawn(move || {
                for (index, page) in manifest.pages.iter().enumerate() {
                    let materialized =
                        materialize_stream_page(index, page, MAX_STREAM_INPUT_BYTES, || {
                            reader_canceled.load(Ordering::Acquire)
                        });
                    let failed = materialized.is_err();
                    if sender.send(materialized).is_err() || failed {
                        break;
                    }
                    // Taking a rendezvous message does not mean page processing
                    // succeeded. Wait for its explicit acknowledgement before
                    // opening the next FIFO, otherwise a task failure can strand
                    // this scoped thread forever in an unwritten future stream.
                    if acknowledged.recv() != Ok(true) {
                        break;
                    }
                }
            });

            let mut results = Vec::with_capacity(manifest.pages.len());
            let mut first_error = None;
            for materialized in receiver {
                match materialized {
                    Ok(materialized) if first_error.is_none() => {
                        match task((materialized.index, &materialized.page)) {
                            Ok(result) => {
                                results.push(result);
                                if acknowledge.send(true).is_err() {
                                    first_error = Some(NativeError::new(
                                        NativeErrorCode::Io,
                                        "Streamed scan-cleanup reader stopped before acknowledgement",
                                    ));
                                }
                            }
                            Err(error) => {
                                canceled.store(true, Ordering::Release);
                                first_error = Some(error);
                                let _ = acknowledge.send(false);
                            }
                        }
                    }
                    Ok(_) => {
                        let _ = acknowledge.send(false);
                    }
                    Err(error) => {
                        canceled.store(true, Ordering::Release);
                        first_error.get_or_insert(error);
                        break;
                    }
                }
            }
            match first_error {
                Some(error) => Err(error.into()),
                None if results.len() == manifest.pages.len() => Ok(results),
                None => Err(invalid("Streamed scan-cleanup input ended before every page").into()),
            }
        });
    }

    // The owning process has promised this many concurrent producers. Keep
    // page processing serial (nested Rayon work still owns the native pool),
    // but let the dedicated reader materialize the next pages while the
    // current page is processed. The channel is two slots smaller than the
    // window because the processing page and the reader's in-progress page
    // are both live outside it.
    let channel_capacity = manifest.raster_window.saturating_sub(2);
    thread::scope(|scope| {
        let (sender, receiver) = sync_channel(channel_capacity);
        let canceled = Arc::new(AtomicBool::new(false));
        let reader_canceled = Arc::clone(&canceled);
        scope.spawn(move || {
            for (index, page) in manifest.pages.iter().enumerate() {
                if reader_canceled.load(Ordering::Acquire) {
                    break;
                }
                let materialized =
                    materialize_stream_page(index, page, MAX_STREAM_INPUT_BYTES, || {
                        reader_canceled.load(Ordering::Acquire)
                    });
                let failed = materialized.is_err();
                if sender.send(materialized).is_err() || failed {
                    break;
                }
            }
        });

        let mut results = Vec::with_capacity(manifest.pages.len());
        let mut first_error = None;
        for materialized in receiver {
            match materialized {
                Ok(materialized) => match task((materialized.index, &materialized.page)) {
                    Ok(result) => results.push(result),
                    Err(error) => {
                        canceled.store(true, Ordering::Release);
                        first_error = Some(error);
                        break;
                    }
                },
                Err(error) => {
                    canceled.store(true, Ordering::Release);
                    first_error = Some(error);
                    break;
                }
            }
        }
        match first_error {
            Some(error) => Err(error.into()),
            None if results.len() == manifest.pages.len() => Ok(results),
            None => Err(invalid("Streamed scan-cleanup input ended before every page").into()),
        }
    })
}

fn page_worker_threads(manifest: &ManifestV3) -> Result<usize, NativeError> {
    if manifest_has_stream_inputs(manifest) {
        // FIFO readers block an OS thread until their producer opens the
        // matching pipe. Running a page-sized Rayon pool over ordered streams
        // can occupy the whole pool with future readers while the current page
        // needs nested Rayon work to finish: a real circular wait observed as
        // 180-second pdftoppm timeouts near the end of large documents.
        Ok(1)
    } else if manifest.pages.len() > 1 && pages_have_disjoint_destinations(manifest) {
        manifest_worker_threads(manifest)
    } else {
        Ok(1)
    }
}

fn reconcile_classification_batch(
    manifest: &ManifestV3,
    results: &mut [PageRunResult],
    cache: &Arc<Mutex<ByteLru>>,
) -> Result<(), Box<dyn Error>> {
    let replayable_inputs = !manifest_has_stream_inputs(manifest);
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
        let document_stroke_width_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].metadata.calibration_stroke_width_px),
        );
        let document_x_height_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].metadata.calibration_x_height_px),
        );
        let prior = crate::split::DocumentPrior {
            dominant_layout,
            cutter_ratio_median,
            cluster_dims: crate::split::ClusterDimensions {
                width: median(&widths).unwrap_or(1.0),
                height: median(&heights).unwrap_or(1.0),
            },
            agreement_strength,
            stroke_width_median_px: document_stroke_width_px,
            x_height_median_px: document_x_height_px,
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
            if rerun_with_prior && replayable_inputs {
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
                    manifest.analysis_purpose == AnalysisPurpose::PagePlan,
                    &page_cache,
                )?;
                rerun.timings.decode_ms += results[index].timings.decode_ms;
                rerun.timings.analysis_level_ms += results[index].timings.analysis_level_ms;
                rerun.timings.normalization_ms += results[index].timings.normalization_ms;
                rerun.timings.illumination_preparation_ms +=
                    results[index].timings.illumination_preparation_ms;
                rerun.timings.layout_normalization_ms +=
                    results[index].timings.layout_normalization_ms;
                rerun.timings.calibration_ms += results[index].timings.calibration_ms;
                rerun.timings.picture_mask_ms += results[index].timings.picture_mask_ms;
                rerun.timings.mode_recommendation_ms +=
                    results[index].timings.mode_recommendation_ms;
                rerun.timings.quality_normalization_ms +=
                    results[index].timings.quality_normalization_ms;
                rerun.timings.text_axis_ms += results[index].timings.text_axis_ms;
                rerun.timings.split_ms += results[index].timings.split_ms;
                rerun.timings.content_ms += results[index].timings.content_ms;
                rerun.timings.rasterization_ms += results[index].timings.rasterization_ms;
                rerun.timings.mask_rasterization_ms += results[index].timings.mask_rasterization_ms;
                rerun.timings.binarization_ms += results[index].timings.binarization_ms;
                rerun.timings.threshold_preparation_ms +=
                    results[index].timings.threshold_preparation_ms;
                rerun.timings.thresholding_ms += results[index].timings.thresholding_ms;
                rerun.timings.binary_postprocess_ms += results[index].timings.binary_postprocess_ms;
                rerun.timings.mixed_composition_ms += results[index].timings.mixed_composition_ms;
                rerun.timings.output_processing_ms += results[index].timings.output_processing_ms;
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

fn robust_typographic_median(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut values = values
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if values.len() < 3 {
        return None;
    }
    values.sort_by(f64::total_cmp);
    median(&values)
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
        soft_alpha_foreground_recommendation: metadata.soft_alpha_foreground_recommendation,
        output_mode_diagnostics: metadata.output_mode_diagnostics,
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
                    output.foreground_alpha_output_path.as_ref(),
                    output.picture_mask_output_path.as_ref(),
                    output.tone_preservation_alpha_output_path.as_ref(),
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

fn preflight_manifest_paths(manifest: &ManifestV3) -> Result<(), NativeError> {
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

/// Canonicalize the deepest existing ancestor so aliases through a symlinked
/// output directory are detected even before the destination itself exists.
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
    // Canonical path comparison still catches symlink aliases. Unix exposes
    // stable device/inode identity directly; other targets retain the
    // normalized/canonical checks without opening streamed inputs.
    None
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
            Ok(estimate_peak_page_bytes(
                width,
                height,
                manifest.operation,
                options.output_mode,
            ))
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
fn estimate_peak_page_bytes(
    width: usize,
    height: usize,
    operation: Operation,
    output_mode: OutputMode,
) -> u64 {
    let pixels = (width as u64).saturating_mul(height as u64);
    let decodes_color = operation == Operation::Analyze
        || matches!(
            output_mode,
            OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
        );
    let multiplier = if decodes_color {
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
    document_canvas: Option<DocumentCanvas>,
    fallback_destination: Option<(&Path, &Path)>,
    page_ink_consistency: Option<PageInkConsistencyContext>,
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
    let canonical_analysis_input = page
        .analysis_input_path
        .as_ref()
        .map(|path| {
            raster::read_image(path, options.max_pixels, options.max_dimension)
                .map_err(map_image_error)
        })
        .transpose()?;
    if let Some(canonical) = canonical_analysis_input.as_ref() {
        let input_aspect = input_gray.width() as f64 / input_gray.height().max(1) as f64;
        let canonical_aspect =
            canonical.gray.width() as f64 / canonical.gray.height().max(1) as f64;
        if (input_aspect / canonical_aspect - 1.0).abs() > 0.02 {
            return Err(invalid(format!(
                "Fixed analysis raster aspect ratio does not match page input: {}x{} versus {}x{}",
                canonical.gray.width(),
                canonical.gray.height(),
                input_gray.width(),
                input_gray.height(),
            ))
            .into());
        }
    }
    let canonical_analysis =
        canonical_analysis_input
            .as_ref()
            .map(|canonical| CanonicalAnalysisPlane {
                gray: &canonical.gray,
                color: Some(&canonical.rgb),
                dpi: page
                    .analysis_dpi
                    .expect("validated fixed analysis raster has a DPI"),
            });
    let trusted_foreground = page
        .trusted_foreground_mask_path
        .as_ref()
        .map(|path| {
            let selection =
                raster::read_foreground_selection(path, options.max_pixels, options.max_dimension)
                .map_err(map_image_error)?;
            let input_aspect = input_gray.width() as f64 / input_gray.height().max(1) as f64;
            let mask_aspect = selection.width() as f64 / selection.height().max(1) as f64;
            if (input_aspect / mask_aspect - 1.0).abs() > 0.02 {
                return Err(invalid(format!(
                    "Trusted foreground mask aspect ratio does not match page input: {}x{} versus {}x{}",
                    selection.width(),
                    selection.height(),
                    input_gray.width(),
                    input_gray.height(),
                )));
            }
            let selection_width = selection.width();
            Ok((
                normalize_trusted_foreground_selection(&selection, input_gray),
                selection_width,
            ))
        })
        .transpose()?;
    let trusted_foreground_source_width = trusted_foreground
        .as_ref()
        .map(|(_, selection_width)| *selection_width);
    let trusted_foreground_mask = trusted_foreground.map(|(mask, _)| mask);
    let trusted_mrc_background = page
        .trusted_mrc_background_path
        .as_ref()
        .map(|path| {
            let background =
                raster::read_gray(path, options.max_pixels, options.max_dimension)
                    .map_err(map_image_error)?;
            let (background_width, background_height) =
                (background.width(), background.height());
            let input_aspect = input_gray.width() as f64 / input_gray.height().max(1) as f64;
            let background_aspect = background_width as f64 / background_height.max(1) as f64;
            if (input_aspect / background_aspect - 1.0).abs() > 0.02 {
                return Err(invalid(format!(
                    "Trusted MRC background aspect ratio does not match page input: {}x{} versus {}x{}",
                    background_width,
                    background_height,
                    input_gray.width(),
                    input_gray.height(),
                )));
            }
            Ok(background)
        })
        .transpose()?;
    let trusted_selection_incomplete = trusted_mrc_background
        .as_ref()
        .zip(trusted_foreground_source_width)
        .is_some_and(|(background, selection_width)| {
            trusted_selection_is_incomplete(selection_width, background.width())
        });
    // A full-resolution background marks producer pages whose selection mask
    // is not a complete ink carrier. Keep the compatibility hint available to
    // late output-mode resolution. The renderer rebuilds the background while
    // retaining selected ink and raw-supported additions in the foreground.
    let mut options = options;
    options.trusted_selection_incomplete = trusted_selection_incomplete;
    options.trusted_mrc_source_available = trusted_mrc_background.is_some();
    options.page_ink_consistency = (options.output_mode == OutputMode::Bw
        && options.thickness == 0
        && !options.trusted_selection_incomplete
        && trusted_foreground_mask.is_some())
    .then_some(page_ink_consistency)
    .flatten();
    if trusted_mrc_background.is_some() != trusted_foreground_mask.is_some() {
        return Err(Box::new(invalid(
            "Trusted MRC evidence must provide both background and foreground selection layers",
        )));
    }
    let create_mixed_layers = final_render
        && !page.outputs.is_empty()
        && page.outputs.iter().all(|output| {
            output.background_output_path.is_some() && output.foreground_mask_output_path.is_some()
        });
    let mut result = if let Some(detail_plan) = &page.detail_render_plan {
        let base_metadata: CleanupMetadata = deserialize_json_file_bounded(
            &detail_plan.base_metadata_path,
            MAX_DETAIL_METADATA_BYTES,
            "detail base metadata",
        )
        .map_err(|error| {
            if error.code == NativeErrorCode::TooLarge {
                error
            } else {
                invalid(format!(
                    "Invalid detail base metadata {}: {error}",
                    detail_plan.base_metadata_path.display(),
                ))
            }
        })?;
        let base_source = raster::read_image(
            &detail_plan.base_raster_path,
            options.max_pixels,
            options.max_dimension,
        )
        .map_err(map_image_error)?;
        let base_cleaned = detail_plan
            .base_cleaned_raster_path
            .as_ref()
            .map(|path| raster::read_image(path, options.max_pixels, options.max_dimension))
            .transpose()
            .map_err(map_image_error)?;
        clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: input_gray,
                color_source_crop: color_input.as_ref().map(|input| &input.rgb),
                base_source: &base_source.gray,
                base_color_source: Some(&base_source.rgb),
                base_cleaned: base_cleaned
                    .as_ref()
                    .map(|cleaned| (&cleaned.gray, Some(&cleaned.rgb))),
            },
            &options,
            page.source_page_index,
            detail_plan,
            &base_metadata,
            &mut timings,
        )
        .map_err(map_image_error)?
    } else {
        clean_page_with_color_and_document_prior_cached(
            input_gray,
            color_input.as_ref().map(|input| &input.rgb),
            canonical_analysis,
            trusted_foreground_mask.as_ref(),
            trusted_mrc_background.as_ref(),
            &options,
            page.source_page_index,
            page.document_prior,
            cache,
            create_mixed_layers,
            // A concrete mode may have come from the user's setting or from
            // the already-completed document detector. In either case the
            // render has no reason to run mode recommendation again. Automatic
            // pages without reusable evidence still compute it here.
            options.output_mode == OutputMode::Auto,
            &mut timings,
        )
        .map_err(map_image_error)?
    };
    if final_render && result.classification == LayoutClassification::TwoPageSpread {
        // The matched-canvas planner must measure the same visible raster that
        // the compact manifest will publish. Mixed layers are useful for the
        // single-page layered path, but their mask/background planes can have
        // different crop headroom; restoring the spread composite first keeps
        // the shared vertical anchor in the composite's source coordinates.
        for output in &mut result.outputs {
            if output.mixed_layers.is_some() {
                restore_mixed_composite_from_layers(output);
            }
        }
    }
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
        split_diagnostics: result.split_diagnostics,
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
        soft_alpha_foreground_recommendation: result
            .output_mode_recommendation
            .filter(|recommendation| recommendation.mode == OutputMode::Mixed)
            .map(|recommendation| recommendation.prefer_soft_alpha_foreground),
        output_mode_diagnostics: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.diagnostics),
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
        calibration_stroke_width_px: None,
        calibration_x_height_px: None,
    };
    let destinations = resolve_destinations(page, result.outputs.len(), fallback_destination)?;
    let matched_canvas = if final_render && options.match_page_size && !options.ocr_mode {
        let mut canvas = document_canvas
            .ok_or_else(|| invalid("Matched page size requires a documentCanvas plan"))?;
        // PDF page matching is a physical-points contract, not a
        // same-number-of-pixels contract. Reusing the document's finest raster
        // grid upscaled lower-DPI B&W/Mixed pages after cleanup, adding no
        // information while changing stroke geometry and bloating masks. Each
        // page keeps the DPI at which it was actually cleaned.
        canvas = canvas.at_dpi(options.dpi);
        validate_canvas_for_options(canvas.width_px, canvas.height_px, &options)?;
        Some(canvas)
    } else {
        None
    };
    let shared_spread_overflow_plan = matched_canvas
        .and_then(|canvas| {
            (result.classification == LayoutClassification::TwoPageSpread)
                .then(|| shared_spread_overflow_fit_for_outputs(&result.outputs, &options, &canvas))
        })
        .flatten();
    let mut matched_placements = result
        .outputs
        .iter()
        .enumerate()
        .map(|(index, output)| {
            matched_canvas.map(|canvas| {
                let (paper_width, paper_height) = matched_output_paper_dimensions(&output.metadata);
                let optical_content_bounds_x = output
                    .metadata
                    .content_box
                    .is_some()
                    .then(|| optical_content_bounds_x_for_output(output))
                    .flatten();
                let fold_trim = shared_spread_overflow_plan
                    .as_ref()
                    .and_then(|plan| plan.trims.get(index))
                    .copied()
                    .unwrap_or_default();
                let placement = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
                    output.image.width(),
                    output.image.height(),
                    paper_width,
                    paper_height,
                    output.metadata.content_box.is_some(),
                    &options,
                    output.metadata.half,
                    &canvas,
                    optical_content_bounds_x,
                    shared_spread_overflow_plan
                        .as_ref()
                        .map(|plan| plan.shared_fit),
                    fold_trim,
                    placement_near_paper_edge_runs_for_output(output),
                );
                (placement, canvas)
            })
        })
        .collect::<Vec<_>>();
    if result.classification == LayoutClassification::TwoPageSpread {
        let intrinsic_heights = result
            .outputs
            .iter()
            .map(|output| output.image.height())
            .collect::<Vec<_>>();
        let content_tops = result
            .outputs
            .iter()
            .map(spread_content_top_for_output)
            .collect::<Vec<_>>();
        if let Some(canvas) = matched_canvas {
            align_spread_vertical_placements(
                &mut matched_placements,
                &intrinsic_heights,
                &content_tops,
                &canvas,
            );
        }
    }
    let mut written = Vec::with_capacity(result.outputs.len());
    let write_started = Instant::now();
    let publication_result = (|| -> Result<(), Box<dyn Error>> {
        for ((output, destination), matched_placement) in result
            .outputs
            .iter_mut()
            .zip(&destinations)
            .zip(matched_placements.into_iter())
        {
            let layer_destinations_available = final_render
                && output.mixed_layers.as_ref().is_some_and(|layers| {
                    destination.background_output_path.is_some()
                        && if layers.foreground_alpha.is_some() {
                            destination.foreground_alpha_output_path.is_some()
                        } else {
                            destination.foreground_mask_output_path.is_some()
                        }
                });
            if let Some((placement, canvas)) = matched_placement {
                apply_canvas_metadata(&mut output.metadata, placement, &canvas);
                match_picture_mask_in_memory(output, placement, &canvas);
                match_tone_preservation_alpha_in_memory(output, placement, &canvas);
                let spread_mixed = result.classification == LayoutClassification::TwoPageSpread
                    && output.mixed_layers.is_some();
                if spread_mixed {
                    // The shared spread anchor is native canvas geometry. A
                    // compact layered manifest has no placement matrix; its
                    // WASM/img2pdf assembler scales the background and mask
                    // independently and can therefore reintroduce each
                    // leaf's intrinsic crop headroom. The composite was
                    // restored before planning, so materialize that exact
                    // source on the native canvas. Single-page mixed output
                    // keeps its layered representation.
                    match_primary_raster_in_memory(output, placement, &canvas);
                    output.mixed_layers = None;
                } else if layer_destinations_available {
                    // Layered and bilevel publication still materializes the
                    // document canvas, so its intrinsic output is the placed
                    // content rectangle on that grid.
                    output.metadata.output_width = placement.content_width;
                    output.metadata.output_height = placement.content_height;
                    match_layers_in_memory(output, &options, placement, &canvas);
                } else {
                    match_primary_raster_in_memory(output, placement, &canvas);
                }
            }
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
            let (background_output_path, foreground_mask_output_path, foreground_alpha_output_path) =
                if let (Some(layers), Some(background_path)) = (
                    output.mixed_layers.as_ref(),
                    final_render
                        .then_some(destination.background_output_path.as_ref())
                        .flatten(),
                ) {
                    let foreground_path = if layers.foreground_alpha.is_some() {
                        destination.foreground_alpha_output_path.as_ref()
                    } else {
                        destination.foreground_mask_output_path.as_ref()
                    };
                    let foreground_path = foreground_path.ok_or_else(|| {
                        invalid("Layered cleanup output is missing its foreground destination")
                    })?;
                    // Source-MRC pages already carry the authored high-DPI
                    // photo detail through their JPX+smask pair. Only pages
                    // without that safe affine reuse need the larger fresh
                    // continuous-tone plate.
                    let confirmed_picture = output
                        .picture_mask
                        .as_ref()
                        .is_some_and(|mask| mask.count_black() > 0)
                        && !layers.source_mrc;
                    let background_dpi = layered_background_dpi(&options, confirmed_picture);
                    let layer_result = (|| -> Result<(), String> {
                        let (target_background_width, target_background_height) =
                            if let Some((_, canvas)) = matched_placement.as_ref() {
                                background_canvas_dimensions(canvas, background_dpi)
                            } else {
                                (
                                    ((layers.foreground_mask.width() as f64 * background_dpi
                                        / options.dpi)
                                        .round() as usize)
                                        .max(1),
                                    ((layers.foreground_mask.height() as f64 * background_dpi
                                        / options.dpi)
                                        .round() as usize)
                                        .max(1),
                                )
                            };
                        let (background_width, background_height) =
                            background_dimensions_to_publish(
                                layers.background.width(),
                                layers.background.height(),
                                target_background_width,
                                target_background_height,
                            );
                        if let Some(color) = &layers.color_background {
                            if color.width() != background_width
                                || color.height() != background_height
                            {
                                let background = downscale_rgb_to_dimensions(
                                    color,
                                    background_width,
                                    background_height,
                                );
                                write_layer_background(background_path, &background)?;
                            } else {
                                write_layer_background(background_path, color)?;
                            }
                        } else if layers.background.width() != background_width
                            || layers.background.height() != background_height
                        {
                            let background = layers
                                .background
                                .downscale_to_dimensions(background_width, background_height);
                            write_gray_layer_background(background_path, &background)?;
                        } else {
                            write_gray_layer_background(background_path, &layers.background)?;
                        }
                        if let Some(alpha) = layers.foreground_alpha.as_ref() {
                            let foreground_dpi = layered_foreground_dpi(&options);
                            let foreground_width =
                                ((alpha.width() as f64 * foreground_dpi / options.dpi).round()
                                    as usize)
                                    .max(1);
                            let foreground_height =
                                ((alpha.height() as f64 * foreground_dpi / options.dpi).round()
                                    as usize)
                                    .max(1);
                            let foreground = if foreground_dpi < options.dpi {
                                alpha.downscale_to_dimensions(foreground_width, foreground_height)
                            } else {
                                alpha.clone()
                            };
                            raster::write_gray_pgm_atomic(foreground_path, &foreground)
                        } else {
                            pbm::write_p4_bilevel_atomic(foreground_path, &layers.foreground_mask)
                        }
                    })();
                    if let Err(error) = layer_result {
                        let _ = fs::remove_file(background_path);
                        let _ = fs::remove_file(foreground_path);
                        restore_mixed_composite_from_layers(output);
                        output.metadata.warnings.push(format!(
                            "Mixed layers were not written safely; the composite fallback was published instead: {error}"
                        ));
                        (None, None, None)
                    } else {
                        output.metadata.layered_written = true;
                        output.metadata.layered_foreground_kind = Some(if layers.source_mrc {
                            LayeredForegroundKind::SourceMrc
                        } else if layers.foreground_alpha.is_some() {
                            LayeredForegroundKind::SoftAlpha
                        } else {
                            LayeredForegroundKind::Stencil
                        });
                        output.metadata.layered_background_dpi = Some(background_dpi);
                        output.metadata.layered_foreground_dpi = if layers.source_mrc {
                            // The published selection mask remains on the
                            // rendered page grid. The original JP2's own
                            // DPI is retained later by the PDF affine
                            // matrix and is not this raster's metadata.
                            Some(options.dpi)
                        } else {
                            layers
                                .foreground_alpha
                                .is_some()
                                .then(|| layered_foreground_dpi(&options))
                        };
                        (
                            Some(background_path.clone()),
                            layers
                                .foreground_alpha
                                .is_none()
                                .then(|| foreground_path.clone()),
                            layers
                                .foreground_alpha
                                .is_some()
                                .then(|| foreground_path.clone()),
                        )
                    }
                } else {
                    (None, None, None)
                };
            let picture_mask_output_path = if final_render {
                destination
                    .picture_mask_output_path
                    .as_ref()
                    .zip(output.picture_mask.as_ref())
                    .map(|(path, picture_mask)| {
                        pbm::write_p4_bilevel_atomic(path, picture_mask)
                            .map(|()| path.clone())
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))
                    })
                    .transpose()?
            } else {
                None
            };
            let tone_preservation_alpha_output_path = if final_render {
                destination
                    .tone_preservation_alpha_output_path
                    .as_ref()
                    .zip(output.tone_preservation_alpha.as_ref())
                    .map(|(path, tone_preservation_alpha)| {
                        png::write_gray_atomic(path, tone_preservation_alpha)
                            .map(|()| path.clone())
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))
                    })
                    .transpose()?
            } else {
                None
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
            let (paper_width, paper_height) = matched_output_paper_dimensions(&output.metadata);
            let optical_content_bounds_x = output
                .metadata
                .content_box
                .is_some()
                .then(|| optical_content_bounds_x_for_output(output))
                .flatten();
            let fold_side_near_paper_run =
                if matched_placement.is_some() || !options.match_page_size || options.ocr_mode {
                    0
                } else if let Some(canvas) = document_canvas {
                    let fit = canvas_fit_for(
                        output.image.width(),
                        output.image.height(),
                        paper_width,
                        paper_height,
                        output.metadata.content_box.is_some(),
                        &options,
                        &canvas,
                    );
                    if horizontal_overflow_requires_fold_scan(
                        output.image.width(),
                        output.metadata.half,
                        fit,
                    ) {
                        fold_side_near_paper_run_for_output(output)
                    } else {
                        0
                    }
                } else {
                    0
                };
            let outer_near_paper_edge_runs = if matched_placement.is_none()
                && options.match_page_size
                && !options.ocr_mode
                && optical_content_bounds_x.is_some()
            {
                outer_near_paper_edge_runs_for_output(output)
            } else {
                NearPaperEdgeRuns::default()
            };
            written.push(WrittenOutput {
                output_path: destination.output_path.clone(),
                metadata_path: destination.metadata_path.clone(),
                bilevel_output_path,
                background_output_path,
                foreground_mask_output_path,
                foreground_alpha_output_path,
                picture_mask_output_path,
                tone_preservation_alpha_output_path,
                options: options.clone(),
                source_page_index: page.source_page_index,
                half: output.metadata.half,
                width: output.image.width(),
                height: output.image.height(),
                paper_width,
                paper_height,
                content_detected: output.metadata.content_box.is_some(),
                spread_content_top: spread_content_top_for_output(output),
                optical_content_bounds_x,
                fold_side_near_paper_run,
                outer_near_paper_edge_runs,
                matched_in_memory: matched_placement.is_some(),
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
            if let Some(alpha_path) = &destination.foreground_alpha_output_path {
                let _ = fs::remove_file(alpha_path);
            }
            if let Some(mask_path) = &destination.picture_mask_output_path {
                let _ = fs::remove_file(mask_path);
            }
            if let Some(mask_path) = &destination.tone_preservation_alpha_output_path {
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

fn write_layer_background(path: &Path, image: &RgbImage) -> Result<(), String> {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ppm"))
    {
        // This is a managed handoff to the PDF assembler, which immediately
        // JPEG-encodes the continuous-tone layer. Raw PPM avoids a lossless PNG
        // encode here and its matching decode in the next process.
        raster::write_rgb_ppm_atomic(path, image)
    } else {
        png::write_rgb_atomic(path, image)
    }
}

fn write_gray_layer_background(path: &Path, image: &GrayImage) -> Result<(), String> {
    if path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("ppm") || extension.eq_ignore_ascii_case("pgm")
    }) {
        raster::write_gray_ppm_atomic(path, image)
    } else {
        png::write_gray_atomic(path, image)
    }
}

fn run_classification(
    page: &Page,
    canvas_scope: CanvasScope,
    document_prior: Option<crate::split::DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
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
        plan_content,
        cache,
        &mut timings,
    )
    .map_err(map_image_error)?;
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
        split_diagnostics: result.split_diagnostics,
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
        soft_alpha_foreground_recommendation: result
            .output_mode_recommendation
            .filter(|recommendation| recommendation.mode == OutputMode::Mixed)
            .map(|recommendation| recommendation.prefer_soft_alpha_foreground),
        output_mode_diagnostics: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.diagnostics),
        rotated_width: result.rotated_width,
        rotated_height: result.rotated_height,
        candidate_cutter_ratio: result.candidate_cutter_ratio,
        whitespace_score: result.whitespace_score,
        reconciliation_eligible: matches!(options.layout, crate::LayoutMode::Auto)
            && !options.has_split_evidence()
            && !options.excluded,
        tier1_confidence: if result.reconciliation.reconciled
            || result.reconciliation.cluster_agreement != 0.0
        {
            0.0
        } else {
            result.confidence
        },
        calibration_stroke_width_px: result.calibration_stroke_width_px,
        calibration_x_height_px: result.calibration_x_height_px,
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
    /// Requested physical margin inset on the final canvas grid.
    requested_margins: [usize; 4],
    /// The horizontal placement was chosen from the transformed optical
    /// content box.
    optical_content_centered: bool,
    /// Optical bounds were available, but could not fit inside the requested
    /// canvas margins. The caller keeps raster alignment and publishes a
    /// page-level warning instead of silently losing the reason.
    optical_content_fit_failed: bool,
    optical_content_bounds_x: Option<(f64, f64)>,
    intrinsic_overflow_left: usize,
    intrinsic_overflow_right: usize,
    /// Source rows trimmed above the canvas origin by a spread-level anchor.
    /// This is white crop headroom, not content clipping: the effective
    /// signed placement remains available to the materializer while the
    /// public canvas offset stays non-negative.
    intrinsic_overflow_top: usize,
    /// Provably-paper source columns excluded at the fold edge. These stay in
    /// intrinsic coordinates; the materializer maps them onto its target grid.
    fold_trim_left: usize,
    fold_trim_right: usize,
    /// Fold-edge crop already scaled onto the canvas/materialization grid.
    fold_clip_left: usize,
    fold_clip_right: usize,
    /// Horizontal source window and destination after scaling. The public
    /// placement continues to describe the complete intrinsic raster so OCR
    /// and preview geometry retain the document's paper scale.
    materialization_left: usize,
    materialization_source_offset_left: usize,
    materialization_source_offset_right: usize,
    margins_reduced: bool,
    margins_unavailable: bool,
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

/// Physical paper geometry is independent of split-selection geometry. The
/// source sheet supplies one pixel scale; each spread output owns half of its
/// oriented paper frame even when gutter detection places the cutter away from
/// the centre. Using `source_region.width` here would shrink the wider crop and
/// enlarge the narrower crop, making equal-height leaves visibly unequal.
fn matched_output_paper_dimensions(metadata: &CleanupMetadata) -> (f64, f64) {
    matched_output_paper_dimensions_for(
        metadata.input_width,
        metadata.input_height,
        metadata.rotation,
        metadata.half,
    )
}

fn matched_output_paper_dimensions_for(
    input_width: usize,
    input_height: usize,
    rotation: OrthogonalRotation,
    half: crate::pipeline::PageHalf,
) -> (f64, f64) {
    let swaps_axes = matches!(
        rotation,
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
    );
    let (oriented_width, oriented_height) = if swaps_axes {
        (input_height, input_width)
    } else {
        (input_width, input_height)
    };
    let shares = if half == crate::pipeline::PageHalf::Full {
        1.0
    } else {
        2.0
    };
    (oriented_width as f64 / shares, oriented_height as f64)
}

#[derive(Clone, Copy, Debug)]
struct CanvasFit {
    requested_margins: [usize; 4],
    margins_reduced: bool,
    margins_unavailable: bool,
    inner_width: usize,
    inner_height: usize,
    paper_scale: f64,
    pixel_scale: f64,
    overflow_fit: f64,
    overflow: bool,
    undersized_paper: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct FoldSideTrim {
    left: usize,
    right: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct NearPaperEdgeRuns {
    left: usize,
    right: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HorizontalEdge {
    Left,
    Right,
}

impl FoldSideTrim {
    fn total(self) -> usize {
        self.left.saturating_add(self.right)
    }

    fn effective_width(self, width: usize) -> usize {
        width.saturating_sub(self.total()).max(1)
    }
}

#[derive(Clone, Debug)]
struct SharedSpreadOverflowPlan {
    shared_fit: f64,
    trims: Vec<FoldSideTrim>,
}

fn canvas_fit_for(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    canvas: &DocumentCanvas,
) -> CanvasFit {
    let configured_margins = if let Some(margins) = options.margins_pixels {
        margins.map(|pixels| (pixels * canvas.dpi() / options.dpi).round().max(0.0) as usize)
    } else {
        options
            .margins_mm
            .map(crate::MarginsMm::values)
            .unwrap_or([0.0; 4])
            .map(|millimeters| (millimeters * canvas.dpi() / 25.4).round() as usize)
    };
    let margins_unavailable = configured_margins.iter().any(|margin| *margin > 0)
        && (!content_detected || !options.crop_content);
    let mut requested_margins = if margins_unavailable {
        [0; 4]
    } else {
        configured_margins
    };
    let requested_before_fit = requested_margins;
    let fit_margin_axis = |leading: &mut usize, trailing: &mut usize, total: usize| {
        let sum = leading.saturating_add(*trailing);
        if sum < total || sum == 0 {
            return;
        }
        let available = total.saturating_sub(1);
        let fitted_leading =
            ((available as f64 * *leading as f64 / sum as f64).round() as usize).min(available);
        *leading = fitted_leading;
        *trailing = available - fitted_leading;
    };
    let [ref mut margin_left, ref mut margin_top, ref mut margin_right, ref mut margin_bottom] =
        requested_margins;
    fit_margin_axis(margin_left, margin_right, canvas.width_px);
    fit_margin_axis(margin_top, margin_bottom, canvas.height_px);
    let margins_reduced = requested_margins != requested_before_fit;
    let [margin_left, margin_top, margin_right, margin_bottom] = requested_margins;
    let inner_width = canvas
        .width_px
        .saturating_sub(margin_left)
        .saturating_sub(margin_right)
        .max(1);
    let inner_height = canvas
        .height_px
        .saturating_sub(margin_top)
        .saturating_sub(margin_bottom)
        .max(1);
    let paper_width_points = paper_width.max(1.0) / options.dpi * 72.0;
    let paper_height_points = paper_height.max(1.0) / options.dpi * 72.0;
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
    let pixel_scale = paper_scale * canvas.dpi() / options.dpi;
    let scaled_width = width as f64 * pixel_scale;
    let scaled_height = height as f64 * pixel_scale;
    let overflow = scaled_width > inner_width as f64 + CANVAS_GRID_TOLERANCE_PX
        || scaled_height > inner_height as f64 + CANVAS_GRID_TOLERANCE_PX;
    let overflow_fit = if overflow {
        (inner_width as f64 / scaled_width.max(1.0))
            .min(inner_height as f64 / scaled_height.max(1.0))
    } else {
        1.0
    };
    CanvasFit {
        requested_margins,
        margins_reduced,
        margins_unavailable,
        inner_width,
        inner_height,
        paper_scale,
        pixel_scale,
        overflow_fit,
        overflow,
        undersized_paper,
    }
}

fn edge_column_order(width: usize, edge: HorizontalEdge) -> Box<dyn Iterator<Item = usize>> {
    match edge {
        HorizontalEdge::Left => Box::new(0..width),
        HorizontalEdge::Right => Box::new((0..width).rev()),
    }
}

#[cfg(test)]
fn edge_near_paper_run_in_gray(image: &GrayImage, edge: HorizontalEdge) -> usize {
    let near_paper_threshold = paper_reference(image).min(FOLD_TAIL_NEAR_PAPER_FLOOR);
    edge_column_order(image.width(), edge)
        .take_while(|&x| (0..image.height()).all(|y| image.get(x, y) >= near_paper_threshold))
        .count()
}

#[cfg(test)]
fn fold_side_near_paper_run_in_gray(image: &GrayImage, half: crate::pipeline::PageHalf) -> usize {
    match half {
        crate::pipeline::PageHalf::Left => {
            edge_near_paper_run_in_gray(image, HorizontalEdge::Right)
        }
        crate::pipeline::PageHalf::Right => {
            edge_near_paper_run_in_gray(image, HorizontalEdge::Left)
        }
        crate::pipeline::PageHalf::Full => 0,
    }
}

fn mapped_column_range(x: usize, source_width: usize, plane_width: usize) -> (usize, usize) {
    let start = x.saturating_mul(plane_width) / source_width.max(1);
    let end = (x + 1)
        .saturating_mul(plane_width)
        .div_ceil(source_width.max(1))
        .max(start + 1)
        .min(plane_width);
    (start.min(plane_width), end)
}

fn edge_near_paper_run_for_output(output: &CleanupResult, edge: HorizontalEdge) -> usize {
    let gray = output.image.to_gray();
    let width = gray.width();
    let near_paper_threshold = paper_reference(&gray).min(FOLD_TAIL_NEAR_PAPER_FLOOR);
    edge_column_order(width, edge)
        .take_while(|&x| {
            if !(0..gray.height()).all(|y| gray.get(x, y) >= near_paper_threshold) {
                return false;
            }
            // BW materializes only the primary stencil. Its analysis-only
            // tone alpha must neither widen optical ownership nor veto a
            // paper proof for columns that never enter the published page.
            if output.metadata.output_mode == OutputMode::Bw {
                return true;
            }
            if let Some(color) = output.color_image.as_ref() {
                let (start, end) = mapped_column_range(x, width, color.width());
                if (0..color.height()).any(|y| {
                    (start..end).any(|plane_x| {
                        color
                            .get(plane_x, y)
                            .iter()
                            .any(|&sample| sample < near_paper_threshold)
                    })
                }) {
                    return false;
                }
            }
            if let Some(layers) = output.mixed_layers.as_ref() {
                let (start, end) = mapped_column_range(x, width, layers.foreground_mask.width());
                if (0..layers.foreground_mask.height())
                    .any(|y| (start..end).any(|plane_x| layers.foreground_mask.get(plane_x, y)))
                {
                    return false;
                }
                if let Some(alpha) = layers.foreground_alpha.as_ref() {
                    let (start, end) = mapped_column_range(x, width, alpha.width());
                    if (0..alpha.height())
                        .any(|y| (start..end).any(|plane_x| alpha.get(plane_x, y) > 0))
                    {
                        return false;
                    }
                }
                let (start, end) = mapped_column_range(x, width, layers.background.width());
                if (0..layers.background.height()).any(|y| {
                    (start..end)
                        .any(|plane_x| layers.background.get(plane_x, y) < near_paper_threshold)
                }) {
                    return false;
                }
                if let Some(color) = layers.color_background.as_ref() {
                    let (start, end) = mapped_column_range(x, width, color.width());
                    if (0..color.height()).any(|y| {
                        (start..end).any(|plane_x| {
                            color
                                .get(plane_x, y)
                                .iter()
                                .any(|&sample| sample < near_paper_threshold)
                        })
                    }) {
                        return false;
                    }
                }
            }
            if let Some(mask) = output.picture_mask.as_ref() {
                let (start, end) = mapped_column_range(x, width, mask.width());
                if (0..mask.height()).any(|y| (start..end).any(|plane_x| mask.get(plane_x, y))) {
                    return false;
                }
            }
            if let Some(alpha) = output.tone_preservation_alpha.as_ref() {
                let (start, end) = mapped_column_range(x, width, alpha.width());
                if (0..alpha.height())
                    .any(|y| (start..end).any(|plane_x| alpha.get(plane_x, y) > 0))
                {
                    return false;
                }
            }
            true
        })
        .count()
}

fn fold_side_near_paper_run_for_output(output: &CleanupResult) -> usize {
    match output.metadata.half {
        crate::pipeline::PageHalf::Left => {
            edge_near_paper_run_for_output(output, HorizontalEdge::Right)
        }
        crate::pipeline::PageHalf::Right => {
            edge_near_paper_run_for_output(output, HorizontalEdge::Left)
        }
        crate::pipeline::PageHalf::Full => 0,
    }
}

fn outer_near_paper_edge_runs_for_output(output: &CleanupResult) -> NearPaperEdgeRuns {
    match output.metadata.half {
        crate::pipeline::PageHalf::Left => NearPaperEdgeRuns {
            left: edge_near_paper_run_for_output(output, HorizontalEdge::Left),
            right: 0,
        },
        crate::pipeline::PageHalf::Right => NearPaperEdgeRuns {
            left: 0,
            right: edge_near_paper_run_for_output(output, HorizontalEdge::Right),
        },
        crate::pipeline::PageHalf::Full => NearPaperEdgeRuns {
            left: edge_near_paper_run_for_output(output, HorizontalEdge::Left),
            right: edge_near_paper_run_for_output(output, HorizontalEdge::Right),
        },
    }
}

fn placement_near_paper_edge_runs_for_output(output: &CleanupResult) -> NearPaperEdgeRuns {
    near_paper_edge_runs_with_fold_side(
        outer_near_paper_edge_runs_for_output(output),
        output.metadata.half,
        fold_side_near_paper_run_for_output(output),
    )
}

fn near_paper_edge_runs_with_fold_side(
    mut runs: NearPaperEdgeRuns,
    half: crate::pipeline::PageHalf,
    fold_side_run: usize,
) -> NearPaperEdgeRuns {
    match half {
        crate::pipeline::PageHalf::Left => runs.right = runs.right.max(fold_side_run),
        crate::pipeline::PageHalf::Right => runs.left = runs.left.max(fold_side_run),
        crate::pipeline::PageHalf::Full => {}
    }
    runs
}

fn fold_trim_for(
    width: usize,
    half: crate::pipeline::PageHalf,
    near_paper_run: usize,
    fit: CanvasFit,
) -> FoldSideTrim {
    if width <= 1 || !horizontal_overflow_requires_fold_scan(width, half, fit) {
        return FoldSideTrim::default();
    }
    let maximum_fitting_width = ((fit.inner_width as f64 + CANVAS_GRID_TOLERANCE_PX)
        / fit.pixel_scale.max(f64::EPSILON))
    .floor()
    .max(1.0) as usize;
    let needed = width.saturating_sub(maximum_fitting_width).min(width - 1);
    let trim = needed.min(near_paper_run).min(width - 1);
    match half {
        crate::pipeline::PageHalf::Left => FoldSideTrim {
            left: 0,
            right: trim,
        },
        crate::pipeline::PageHalf::Right => FoldSideTrim {
            left: trim,
            right: 0,
        },
        crate::pipeline::PageHalf::Full => FoldSideTrim::default(),
    }
}

fn horizontal_overflow_requires_fold_scan(
    width: usize,
    half: crate::pipeline::PageHalf,
    fit: CanvasFit,
) -> bool {
    matches!(
        half,
        crate::pipeline::PageHalf::Left | crate::pipeline::PageHalf::Right
    ) && width as f64 * fit.pixel_scale > fit.inner_width as f64 + CANVAS_GRID_TOLERANCE_PX
}

fn shared_spread_overflow_fit_for_outputs(
    outputs: &[CleanupResult],
    options: &CleanupOptions,
    canvas: &DocumentCanvas,
) -> Option<SharedSpreadOverflowPlan> {
    if outputs.len() != 2
        || !outputs
            .iter()
            .any(|output| output.metadata.half == crate::pipeline::PageHalf::Left)
        || !outputs
            .iter()
            .any(|output| output.metadata.half == crate::pipeline::PageHalf::Right)
    {
        return None;
    }
    let trims = outputs
        .iter()
        .map(|output| {
            let (paper_width, paper_height) = matched_output_paper_dimensions(&output.metadata);
            let fit = canvas_fit_for(
                output.image.width(),
                output.image.height(),
                paper_width,
                paper_height,
                output.metadata.content_box.is_some(),
                options,
                canvas,
            );
            let near_paper_run = if horizontal_overflow_requires_fold_scan(
                output.image.width(),
                output.metadata.half,
                fit,
            ) {
                fold_side_near_paper_run_for_output(output)
            } else {
                0
            };
            fold_trim_for(
                output.image.width(),
                output.metadata.half,
                near_paper_run,
                fit,
            )
        })
        .collect::<Vec<_>>();
    let shared_fit = outputs
        .iter()
        .zip(&trims)
        .map(|(output, trim)| {
            let (paper_width, paper_height) = matched_output_paper_dimensions(&output.metadata);
            canvas_fit_for(
                trim.effective_width(output.image.width()),
                output.image.height(),
                paper_width,
                paper_height,
                output.metadata.content_box.is_some(),
                options,
                canvas,
            )
            .overflow_fit
        })
        .reduce(f64::min)?;
    Some(SharedSpreadOverflowPlan { shared_fit, trims })
}

fn shared_spread_overflow_fits_for_written_outputs(
    outputs: &[&WrittenOutput],
    canvas: &DocumentCanvas,
) -> HashMap<usize, SharedSpreadOverflowPlan> {
    let mut by_source_page = HashMap::<usize, Vec<&WrittenOutput>>::new();
    for output in outputs {
        by_source_page
            .entry(output.source_page_index)
            .or_default()
            .push(*output);
    }
    by_source_page
        .into_iter()
        .filter_map(|(source_page_index, pair)| {
            if pair.len() != 2
                || !pair
                    .iter()
                    .any(|output| output.half == crate::pipeline::PageHalf::Left)
                || !pair
                    .iter()
                    .any(|output| output.half == crate::pipeline::PageHalf::Right)
            {
                return None;
            }
            let trims = pair
                .iter()
                .map(|output| {
                    let fit = canvas_fit_for(
                        output.width,
                        output.height,
                        output.paper_width,
                        output.paper_height,
                        output.content_detected,
                        &output.options,
                        canvas,
                    );
                    fold_trim_for(
                        output.width,
                        output.half,
                        output.fold_side_near_paper_run,
                        fit,
                    )
                })
                .collect::<Vec<_>>();
            let shared_fit = pair
                .iter()
                .zip(&trims)
                .map(|(output, trim)| {
                    canvas_fit_for(
                        trim.effective_width(output.width),
                        output.height,
                        output.paper_width,
                        output.paper_height,
                        output.content_detected,
                        &output.options,
                        canvas,
                    )
                    .overflow_fit
                })
                .reduce(f64::min)?;
            Some((
                source_page_index,
                SharedSpreadOverflowPlan { shared_fit, trims },
            ))
        })
        .collect()
}

/// Normalizes one output onto the canvas: the scale that takes the *paper* it
/// was cut from to the canvas rectangle, expressed on the canvas pixel grid.
///
/// Scaling by the paper rather than by the cropped raster is what keeps a
/// document at one visual scale. A page cropped to a small content box is not
/// zoomed to fill the sheet because its margins were trimmed; a page whose
/// paper is half the size of the canvas — a lower-resolution scan of the same
/// original, a genuinely smaller sheet, or one half of a spread — is resampled
/// up until its ink matches everything around it.
fn plan_canvas_placement_with_shared_fit(
    output: &WrittenOutput,
    canvas: &DocumentCanvas,
    shared_overflow_plan: Option<&SharedSpreadOverflowPlan>,
) -> CanvasPlacement {
    if shared_overflow_plan.is_none() && output.optical_content_bounds_x.is_none() {
        return plan_canvas_placement_for(
            output.width,
            output.height,
            output.paper_width,
            output.paper_height,
            output.content_detected,
            &output.options,
            output.half,
            canvas,
        );
    }
    let fold_trim = shared_overflow_plan
        .map(|_| {
            let own_fit = canvas_fit_for(
                output.width,
                output.height,
                output.paper_width,
                output.paper_height,
                output.content_detected,
                &output.options,
                canvas,
            );
            fold_trim_for(
                output.width,
                output.half,
                output.fold_side_near_paper_run,
                own_fit,
            )
        })
        .unwrap_or_default();
    let placement_near_paper_edge_runs = near_paper_edge_runs_with_fold_side(
        output.outer_near_paper_edge_runs,
        output.half,
        output.fold_side_near_paper_run,
    );
    plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
        output.width,
        output.height,
        output.paper_width,
        output.paper_height,
        output.content_detected,
        &output.options,
        output.half,
        canvas,
        output.optical_content_bounds_x,
        shared_overflow_plan.map(|plan| plan.shared_fit),
        fold_trim,
        placement_near_paper_edge_runs,
    )
}

// Kept as explicit scalar geometry at the test seam: grouping these values
// would hide which coordinate space each call supplies.
fn plan_canvas_placement_for(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: crate::pipeline::PageHalf,
    canvas: &DocumentCanvas,
) -> CanvasPlacement {
    plan_canvas_placement_for_with_optical_center(
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        canvas,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn plan_canvas_placement_for_with_optical_center(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: crate::pipeline::PageHalf,
    canvas: &DocumentCanvas,
    optical_content_bounds_x: Option<(f64, f64)>,
) -> CanvasPlacement {
    plan_canvas_placement_for_with_optical_center_and_fit(
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        canvas,
        optical_content_bounds_x,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn plan_canvas_placement_for_with_optical_center_and_fit(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: crate::pipeline::PageHalf,
    canvas: &DocumentCanvas,
    optical_content_bounds_x: Option<(f64, f64)>,
    shared_overflow_fit: Option<f64>,
) -> CanvasPlacement {
    plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        canvas,
        optical_content_bounds_x,
        shared_overflow_fit,
        FoldSideTrim::default(),
        NearPaperEdgeRuns::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: crate::pipeline::PageHalf,
    canvas: &DocumentCanvas,
    optical_content_bounds_x: Option<(f64, f64)>,
    shared_overflow_fit: Option<f64>,
    fold_trim: FoldSideTrim,
    outer_near_paper_runs: NearPaperEdgeRuns,
) -> CanvasPlacement {
    let effective_width = fold_trim.effective_width(width);
    let CanvasFit {
        requested_margins,
        margins_reduced,
        margins_unavailable,
        inner_width,
        inner_height,
        paper_scale,
        pixel_scale,
        overflow_fit,
        overflow: own_overflow,
        undersized_paper,
    } = canvas_fit_for(
        effective_width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        canvas,
    );
    let [margin_left, margin_top, margin_right, _margin_bottom] = requested_margins;
    let fit = shared_overflow_fit
        .map(|shared| shared.clamp(0.0, 1.0).min(overflow_fit))
        .unwrap_or(overflow_fit);
    let scaled_width = width as f64 * pixel_scale * fit;
    let scaled_height = height as f64 * pixel_scale * fit;
    let overflow = own_overflow || fit < 1.0;
    // Keep the complete intrinsic width at the paper scale. Only the proven
    // fold-side window is omitted by the materializer; retaining the full
    // scaled extent here keeps preview, OCR, and source text geometry honest.
    let content_width = if fold_trim.total() > 0 {
        (scaled_width.round() as usize).max(1)
    } else {
        // The zero-trim path remains byte-for-byte compatible with the shared
        // overflow fit: its raster is already wholly represented by the
        // fitted inner box, including the one-pixel grid tolerance.
        (scaled_width.round() as usize).clamp(1, inner_width)
    };
    let content_height = (scaled_height.round() as usize).clamp(1, inner_height);
    let scaled_boundary = |source_x: usize| {
        ((source_x.min(width) as f64 * pixel_scale * fit).round() as usize).min(content_width)
    };
    let fold_clip_left = scaled_boundary(fold_trim.left);
    let retained_right = scaled_boundary(width.saturating_sub(fold_trim.right));
    let fold_clip_right = content_width.saturating_sub(retained_right);
    let effective_content_width = content_width
        .saturating_sub(fold_clip_left)
        .saturating_sub(fold_clip_right)
        .max(1);
    // Paper geometry owns scale; the intrinsic cleaned raster owns placement.
    // Keeping source crop coordinates out of this calculation makes native
    // final output follow the same Content placement contract as preview and
    // lossless output: align the raster inside the requested margin box.
    let alignment = options.placement_for(half);
    let (aligned_x, aligned_y) = alignment.offset(
        inner_width.saturating_sub(effective_content_width),
        inner_height.saturating_sub(content_height),
    );
    // Keep the effective source origin signed. Optical centering may place a
    // retained white raster tail just outside the canvas; clamping that
    // origin to zero would leave the optical box visibly off-center and make
    // the clipped source pixels impossible to account for in metadata.
    let retained_left = margin_left as isize + aligned_x as isize;
    let mut effective_left = retained_left - fold_clip_left as isize;
    let mut optical_content_centered = false;
    let mut optical_content_fit_failed = false;
    if let Some((optical_left, optical_right)) = optical_content_bounds_x.filter(|(left, right)| {
        left.is_finite()
            && right.is_finite()
            && *left >= 0.0
            && *left < *right
            && *right <= width.max(1) as f64
            && matches!(
                alignment,
                crate::PageAlignment::TopCenter
                    | crate::PageAlignment::Center
                    | crate::PageAlignment::BottomCenter
            )
    }) {
        let scale = content_width as f64 / width.max(1) as f64;
        let optical_center_x = (optical_left + optical_right) * 0.5;
        let scaled_optical_center = optical_center_x * scale;
        let target_center = margin_left as f64 + inner_width as f64 / 2.0;
        // Constrain the optical box to the requested margins. A retained
        // white raster tail may overhang the canvas, but the optical box may
        // not; an impossible box is reported and keeps the ordinary raster
        // alignment instead of inventing a placement that destroys a leaf.
        let minimum_left = (margin_left as f64 - optical_left * scale).ceil();
        let maximum_left =
            (canvas.width_px as f64 - margin_right as f64 - optical_right * scale).floor();
        let desired_left = (target_center - scaled_optical_center).round() as isize;
        if maximum_left >= minimum_left && maximum_left >= 0.0 {
            let minimum_left = minimum_left as isize;
            let maximum_left = maximum_left as isize;
            let candidate = desired_left.clamp(minimum_left, maximum_left);
            optical_content_centered = candidate != effective_left;
            effective_left = candidate;
        } else {
            optical_content_fit_failed = true;
        }
    }
    // Preserve a signed optical origin only when every overhung column is
    // proven paper across every materialized plane. Otherwise slide the
    // retained interval back inside exactly as before: conservation outranks
    // centering when even one sample could be writing.
    let proven_left_overhang = scaled_boundary(outer_near_paper_runs.left);
    let proven_right_overhang = content_width.saturating_sub(scaled_boundary(
        width.saturating_sub(outer_near_paper_runs.right),
    ));
    let retained_left_from_source = effective_left + fold_clip_left as isize;
    let retained_right_from_source = effective_left + retained_right as isize;
    if retained_left_from_source < 0 && (-retained_left_from_source) as usize > proven_left_overhang
    {
        effective_left -= retained_left_from_source;
    } else if retained_right_from_source > canvas.width_px as isize
        && (retained_right_from_source - canvas.width_px as isize) as usize > proven_right_overhang
    {
        effective_left -= retained_right_from_source - canvas.width_px as isize;
    }
    let top = margin_top + aligned_y;
    let intrinsic_overflow_left = if effective_left < 0 {
        (-effective_left) as usize
    } else {
        0
    };
    let left = effective_left.max(0) as usize;
    let intrinsic_overflow_right = (effective_left + content_width as isize)
        .saturating_sub(canvas.width_px as isize)
        .max(0) as usize;
    CanvasPlacement {
        content_width,
        content_height,
        left,
        top,
        requested_margins,
        optical_content_centered,
        optical_content_fit_failed,
        optical_content_bounds_x,
        intrinsic_overflow_left,
        intrinsic_overflow_right,
        intrinsic_overflow_top: 0,
        fold_trim_left: fold_trim.left,
        fold_trim_right: fold_trim.right,
        fold_clip_left,
        fold_clip_right,
        materialization_left: (effective_left + fold_clip_left as isize).max(0) as usize,
        materialization_source_offset_left: fold_clip_left.max(intrinsic_overflow_left),
        materialization_source_offset_right: fold_clip_right.max(intrinsic_overflow_right),
        margins_reduced,
        margins_unavailable,
        overflow,
        paper_scale,
        undersized_paper,
    }
}

fn apply_canvas_metadata(
    metadata: &mut CleanupMetadata,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) {
    let CanvasPlacement {
        content_width,
        content_height,
        left,
        top,
        requested_margins,
        optical_content_centered,
        optical_content_fit_failed,
        optical_content_bounds_x,
        intrinsic_overflow_left,
        intrinsic_overflow_right,
        intrinsic_overflow_top,
        fold_clip_left,
        fold_clip_right,
        ..
    } = placement;
    let effective_left = left as isize - intrinsic_overflow_left as isize;
    let effective_right = effective_left + content_width as isize;
    let effective_top = top as isize - intrinsic_overflow_top as isize;
    let effective_bottom = effective_top + content_height as isize;
    metadata.soft_margins_pixels = [
        effective_left.max(0) as usize,
        effective_top.max(0) as usize,
        (canvas.width_px as isize - effective_right).max(0) as usize,
        (canvas.height_px as isize - effective_bottom).max(0) as usize,
    ];
    metadata.applied_margins = requested_margins.map(|margin| margin as f64).into();
    metadata.uniform_canvas = true;
    metadata.canvas_policy = MatchedCanvasPolicy::StrictMaximum;
    metadata.canvas_overflow = placement.overflow
        || intrinsic_overflow_left > 0
        || intrinsic_overflow_right > 0
        || intrinsic_overflow_top > 0;
    metadata.matched_canvas_target_width = Some(canvas.width_px);
    metadata.matched_canvas_target_height = Some(canvas.height_px);
    metadata.matched_canvas_target_width_points = Some(canvas.width_points);
    metadata.matched_canvas_target_height_points = Some(canvas.height_points);
    metadata.matched_canvas_content_width = Some(content_width);
    metadata.matched_canvas_content_height = Some(content_height);
    metadata.matched_canvas_optical_placement = optical_content_centered;
    metadata.matched_canvas_optical_content_left = optical_content_bounds_x.map(|(left, _)| left);
    metadata.matched_canvas_optical_content_right =
        optical_content_bounds_x.map(|(_, right)| right);
    metadata.matched_canvas_intrinsic_overflow_left = intrinsic_overflow_left;
    metadata.matched_canvas_intrinsic_overflow_right = intrinsic_overflow_right;
    metadata.matched_canvas_intrinsic_overflow_top = intrinsic_overflow_top;
    metadata.fold_clip_left = fold_clip_left;
    metadata.fold_clip_right = fold_clip_right;
    metadata.canvas_width = canvas.width_px;
    metadata.canvas_height = canvas.height_px;
    metadata.placement_offset_x = left;
    metadata.placement_offset_y = top;
    if placement.overflow {
        let [margin_left, margin_top, margin_right, margin_bottom] = placement.requested_margins;
        let inner_width = canvas
            .width_px
            .saturating_sub(margin_left)
            .saturating_sub(margin_right)
            .max(1);
        let inner_height = canvas
            .height_px
            .saturating_sub(margin_top)
            .saturating_sub(margin_bottom)
            .max(1);
        metadata.warnings.push(format!(
            "Matched page size fitted this page to {content_width}x{content_height} px \
             inside the {inner_width}x{inner_height} px requested margin box on the {}x{} px \
             document canvas, below the document's scale",
            canvas.width_px, canvas.height_px,
        ));
    }
    if intrinsic_overflow_left > 0 || intrinsic_overflow_right > 0 {
        metadata.warnings.push(format!(
            "Matched page raster extends beyond the canvas by {} px on the left and {} px on the right; optical content remains bounded",
            intrinsic_overflow_left, intrinsic_overflow_right,
        ));
    }
    if intrinsic_overflow_top > 0 {
        metadata.warnings.push(format!(
            "Matched spread placement trimmed {intrinsic_overflow_top} px of source headroom above the shared content anchor"
        ));
    }
    if placement.fold_trim_left > 0 || placement.fold_trim_right > 0 {
        metadata.warnings.push(format!(
            "Matched spread discarded {} provably-paper fold-side columns on the left and {} on the right (all samples met the leaf-specific paper bound) before overflow fitting",
            placement.fold_trim_left, placement.fold_trim_right,
        ));
    }
    if optical_content_fit_failed && metadata.content_box.is_some() {
        metadata.warnings.push(
            "Optical centering was requested but the optical bounds could not fit inside the canvas margins; raster alignment was retained"
                .to_owned(),
        );
    }
    if placement.margins_reduced {
        metadata.warnings.push(
            "Matched page size reduced requested margins because they leave no drawable canvas"
                .to_owned(),
        );
    }
    if placement.margins_unavailable {
        metadata.warnings.push(
            "Requested margins were not applied because content detection or cropping is unavailable"
                .to_owned(),
        );
    }
    if placement.undersized_paper {
        let percent = placement.paper_scale * 100.0;
        metadata.warnings.push(format!(
            "Matched page size placed this page at {percent:.1}% of the document's scale \
             because its paper is larger than the {}x{} px document canvas, \
             which was measured from a different layout for this page",
            canvas.width_px, canvas.height_px,
        ));
    }
}

fn match_primary_raster_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) {
    output.metadata.intrinsic_raster_width = Some(output.image.width());
    output.metadata.intrinsic_raster_height = Some(output.image.height());
    output.metadata.output_width = placement.content_width;
    output.metadata.output_height = placement.content_height;
    output.image = match &output.image {
        CleanupRaster::Gray(image) => {
            CleanupRaster::Gray(materialize_gray_primary_on_canvas(image, placement, canvas))
        }
        CleanupRaster::Bilevel(image) => {
            let gray = CleanupRaster::Bilevel(image.clone()).into_gray();
            let canvas_image = place_on_white_canvas_with_source_window(
                &resample_bilevel(&gray, placement.content_width, placement.content_height),
                canvas.width_px,
                canvas.height_px,
                placement.materialization_left,
                placement.top,
                placement.materialization_source_offset_left,
                placement.materialization_source_offset_right,
                placement.intrinsic_overflow_top,
            );
            CleanupRaster::Bilevel(BinaryImage::from_fn_parallel(
                canvas.width_px,
                canvas.height_px,
                |x, y| canvas_image.get(x, y) < 128,
            ))
        }
    };
    if let Some(color) = output.color_image.take() {
        output.color_image = Some(place_rgb_on_white_canvas_with_source_window(
            &resample_rgb_if_needed(&color, placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.materialization_left,
            placement.top,
            placement.materialization_source_offset_left,
            placement.materialization_source_offset_right,
            placement.intrinsic_overflow_top,
        ));
    }
    // The native owner has materialized every primary continuous-tone raster
    // onto the target canvas. Keeping a placement record here would make the
    // PDF assembler apply the inset a second time.
    output.metadata.pdf_image_placement = None;
}

fn materialize_gray_primary_on_canvas(
    source: &GrayImage,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) -> GrayImage {
    place_on_white_canvas_with_source_window(
        &resample_gray_if_needed(source, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        placement.materialization_source_offset_left,
        placement.materialization_source_offset_right,
        placement.intrinsic_overflow_top,
    )
}

fn resample_gray_if_needed(source: &GrayImage, width: usize, height: usize) -> GrayImage {
    if source.width() == width && source.height() == height {
        source.clone()
    } else {
        source.resample_to_dimensions(width, height)
    }
}

fn resample_rgb_if_needed(source: &RgbImage, width: usize, height: usize) -> RgbImage {
    if source.width() == width && source.height() == height {
        source.clone()
    } else {
        source.resample_to_dimensions(width, height)
    }
}

fn match_picture_mask_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) {
    let Some(picture_mask) = output.picture_mask.as_ref() else {
        return;
    };
    let gray = CleanupRaster::Bilevel(picture_mask.clone()).into_gray();
    let placed = place_on_white_canvas_with_source_window(
        &resample_bilevel(&gray, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        placement.materialization_source_offset_left,
        placement.materialization_source_offset_right,
        placement.intrinsic_overflow_top,
    );
    output.picture_mask = Some(BinaryImage::from_fn_parallel(
        canvas.width_px,
        canvas.height_px,
        |x, y| placed.get(x, y) < 128,
    ));
}

fn match_tone_preservation_alpha_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) {
    let Some(tone_preservation_alpha) = output.tone_preservation_alpha.as_ref() else {
        return;
    };
    let placed = place_on_gray_canvas_with_source_window(
        &resample_gray_if_needed(
            tone_preservation_alpha,
            placement.content_width,
            placement.content_height,
        ),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        0,
        placement.materialization_source_offset_left,
        placement.intrinsic_overflow_top,
        placement.materialization_source_offset_right,
    );
    output.tone_preservation_alpha = Some(placed);
}

fn restore_mixed_composite_from_layers(output: &mut CleanupResult) {
    let Some(layers) = output.mixed_layers.as_ref() else {
        return;
    };
    let mask = &layers.foreground_mask;
    let mut image = resample_gray_if_needed(&layers.background, mask.width(), mask.height());
    let alpha = layers
        .foreground_alpha
        .as_ref()
        .map(|alpha| resample_gray_if_needed(alpha, mask.width(), mask.height()));
    let width = image.width();
    image
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                if let Some(alpha) = alpha.as_ref() {
                    let opacity = alpha.get(x, y);
                    if opacity > 0 {
                        *target =
                            ((u16::from(*target) * u16::from(255 - opacity) + 127) / 255) as u8;
                    }
                } else if mask.get(x, y) {
                    *target = 0;
                }
            }
        });
    output.image = CleanupRaster::Gray(image);
    output.color_image = layers.color_background.as_ref().map(|background| {
        let mut color = resample_rgb_if_needed(background, mask.width(), mask.height());
        let row_bytes = color.width() * 3;
        color
            .data_mut()
            .par_chunks_mut(row_bytes)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    if let Some(alpha) = alpha.as_ref() {
                        let opacity = alpha.get(x, y);
                        if opacity > 0 {
                            for channel in target {
                                *channel = ((u16::from(*channel) * u16::from(255 - opacity) + 127)
                                    / 255) as u8;
                            }
                        }
                    } else if mask.get(x, y) {
                        target.fill(0);
                    }
                }
            });
        color
    });
}

fn match_layers_in_memory(
    output: &mut CleanupResult,
    options: &CleanupOptions,
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) {
    let confirmed_picture = output
        .picture_mask
        .as_ref()
        .is_some_and(|mask| mask.count_black() > 0)
        && !output
            .mixed_layers
            .as_ref()
            .is_some_and(|layers| layers.source_mrc);
    let Some(layers) = output.mixed_layers.as_mut() else {
        return;
    };
    let foreground_gray = CleanupRaster::Bilevel(layers.foreground_mask.clone()).into_gray();
    let foreground = place_on_white_canvas_with_source_window(
        &resample_bilevel(
            &foreground_gray,
            placement.content_width,
            placement.content_height,
        ),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        placement.materialization_source_offset_left,
        placement.materialization_source_offset_right,
        placement.intrinsic_overflow_top,
    );
    layers.foreground_mask =
        BinaryImage::from_fn_parallel(canvas.width_px, canvas.height_px, |x, y| {
            foreground.get(x, y) < 128
        });
    if let Some(alpha) = layers.foreground_alpha.as_ref() {
        layers.foreground_alpha = Some(place_on_gray_canvas_with_source_window(
            &resample_gray_if_needed(alpha, placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.materialization_left,
            placement.top,
            0,
            placement.materialization_source_offset_left,
            placement.intrinsic_overflow_top,
            placement.materialization_source_offset_right,
        ));
    }
    let background_dpi = layered_background_dpi(options, confirmed_picture);
    // The matched canvas is intentionally the high-resolution bilevel grid.
    // Deriving the JPEG plate from `background_dpi / options.dpi` therefore
    // upscaled it whenever the document canvas used a finer B&W DPI than the
    // source page. Derive the plate from physical PDF points and map placement
    // proportionally between the two grids instead.
    let (background_width, background_height) =
        background_canvas_dimensions(canvas, background_dpi);
    let scale_x = background_width as f64 / canvas.width_px.max(1) as f64;
    let scale_y = background_height as f64 / canvas.height_px.max(1) as f64;
    let content_width = ((placement.content_width as f64 * scale_x).round() as usize).max(1);
    let content_height = ((placement.content_height as f64 * scale_y).round() as usize)
        .max(1)
        .min(background_height);
    let left = (placement.materialization_left as f64 * scale_x).round() as usize;
    let source_offset_left = ((placement.materialization_source_offset_left as f64 * scale_x)
        .round() as usize)
        .min(content_width);
    let source_offset_right = ((placement.materialization_source_offset_right as f64 * scale_x)
        .round() as usize)
        .min(content_width.saturating_sub(source_offset_left));
    let top =
        ((placement.top as f64 * scale_y).round() as usize).min(background_height - content_height);
    layers.background = place_on_white_canvas_with_source_window(
        &resample_gray_if_needed(&layers.background, content_width, content_height),
        background_width,
        background_height,
        left,
        top,
        source_offset_left,
        source_offset_right,
        (placement.intrinsic_overflow_top as f64 * scale_y).round() as usize,
    );
    if let Some(color) = layers.color_background.as_ref() {
        layers.color_background = Some(place_rgb_on_white_canvas_with_source_window(
            &resample_rgb_if_needed(color, content_width, content_height),
            background_width,
            background_height,
            left,
            top,
            source_offset_left,
            source_offset_right,
            (placement.intrinsic_overflow_top as f64 * scale_y).round() as usize,
        ));
    }
}

#[derive(Clone, Copy)]
struct DeferredSpreadVerticalPlacement {
    source_page_index: usize,
    half: crate::pipeline::PageHalf,
    intrinsic_height: usize,
    content_top: Option<f64>,
}

/// Applies the in-memory spread anchor to placements planned after outputs
/// have been written. Deferred consumers cannot transport a signed intrinsic
/// Y origin yet, so a shared anchor that would trim crop headroom is exposed at
/// the canvas origin instead.
fn align_deferred_spread_vertical_placements<T>(
    placements: &mut [CanvasPlacement],
    outputs: &[DeferredSpreadVerticalPlacement],
    shared_spread_fits: &HashMap<usize, T>,
    canvas: &DocumentCanvas,
) {
    if placements.len() != outputs.len() {
        return;
    }
    for source_page_index in shared_spread_fits.keys() {
        let pair = outputs
            .iter()
            .enumerate()
            .filter(|(_, output)| output.source_page_index == *source_page_index)
            .collect::<Vec<_>>();
        if pair.len() != 2
            || !pair
                .iter()
                .any(|(_, output)| output.half == crate::pipeline::PageHalf::Left)
            || !pair
                .iter()
                .any(|(_, output)| output.half == crate::pipeline::PageHalf::Right)
        {
            continue;
        }
        let mut pair_placements = vec![
            Some((placements[pair[0].0], *canvas)),
            Some((placements[pair[1].0], *canvas)),
        ];
        align_spread_vertical_placements(
            &mut pair_placements,
            &[pair[0].1.intrinsic_height, pair[1].1.intrinsic_height],
            &[pair[0].1.content_top, pair[1].1.content_top],
            canvas,
        );
        for ((index, _), aligned) in pair.into_iter().zip(pair_placements) {
            let Some((placement, _)) = aligned else {
                continue;
            };
            placements[index] = placement;
        }
    }
}

fn match_page_sizes(
    outputs: &[&WrittenOutput],
    document_canvas: Option<DocumentCanvas>,
) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
        .copied()
        .filter(|output| {
            output.options.match_page_size && !output.options.ocr_mode && !output.matched_in_memory
        })
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
    let shared_spread_fits = shared_spread_overflow_fits_for_written_outputs(&eligible, &canvas);
    let mut placements = eligible
        .iter()
        .map(|output| {
            plan_canvas_placement_with_shared_fit(
                output,
                &canvas,
                shared_spread_fits.get(&output.source_page_index),
            )
        })
        .collect::<Vec<_>>();
    let deferred_spread_outputs = eligible
        .iter()
        .map(|output| DeferredSpreadVerticalPlacement {
            source_page_index: output.source_page_index,
            half: output.half,
            intrinsic_height: output.height,
            content_top: output.spread_content_top,
        })
        .collect::<Vec<_>>();
    align_deferred_spread_vertical_placements(
        &mut placements,
        &deferred_spread_outputs,
        &shared_spread_fits,
        &canvas,
    );

    for (output, placement) in eligible.into_iter().zip(placements) {
        let repad_result = (|| -> Result<(), Box<dyn Error>> {
            validate_canvas(target_width, target_height, output)?;
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            metadata.intrinsic_raster_width.get_or_insert(output.width);
            metadata
                .intrinsic_raster_height
                .get_or_insert(output.height);
            apply_canvas_metadata(&mut metadata, placement, &canvas);

            // Final runs materialize matched outputs in `run_page`, so the
            // deferred path only receives preview outputs. Preview keeps its
            // intrinsic raster and reports the measured canvas placement.
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
            if let Some(alpha_path) = &output.foreground_alpha_output_path {
                let _ = fs::remove_file(alpha_path);
            }
            if let Some(mask_path) = &output.picture_mask_output_path {
                let _ = fs::remove_file(mask_path);
            }
            if let Some(mask_path) = &output.tone_preservation_alpha_output_path {
                let _ = fs::remove_file(mask_path);
            }
            return Err(error);
        }
    }
    Ok(())
}

fn validate_canvas(width: usize, height: usize, output: &WrittenOutput) -> Result<(), NativeError> {
    validate_canvas_for_options(width, height, &output.options)
}

fn validate_canvas_for_options(
    width: usize,
    height: usize,
    options: &CleanupOptions,
) -> Result<(), NativeError> {
    let pixels = (width as u64).saturating_mul(height as u64);
    if width > options.max_dimension as usize
        || height > options.max_dimension as usize
        || pixels > options.max_pixels
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
    resampled
        .data_mut()
        .par_iter_mut()
        .for_each(|value| *value = if *value < 128 { 0 } else { 255 });
    resampled
}

/// Returns the final transformed optical ownership box in intrinsic-raster
/// pixels. Mixed pages use the union of text foreground and tone ownership so
/// a photograph wider than its text is never clipped by optical centering.
#[cfg(test)]
fn optical_content_bounds_x(raster: &CleanupRaster) -> Option<(f64, f64)> {
    raster.bilevel().and_then(optical_binary_bounds_x)
}

fn output_content_ownership(output: &CleanupResult) -> Option<BinaryImage> {
    let mut ownership = output.image.bilevel().cloned();
    // BW publishes only the primary stencil. Analysis-only tone alpha can be
    // much wider on sparse title leaves; treating it as visible ownership
    // shifts the actual text away from center even though that alpha never
    // reaches the PDF.
    if output.metadata.output_mode == OutputMode::Bw {
        return ownership;
    }
    if let Some(picture_mask) = output.picture_mask.as_ref() {
        ownership = Some(match ownership {
            Some(existing) => existing.or(picture_mask),
            None => picture_mask.clone(),
        });
    }
    if let Some(foreground_mask) = output
        .mixed_layers
        .as_ref()
        .map(|layers| &layers.foreground_mask)
    {
        ownership = Some(match ownership {
            Some(existing) => existing.or(foreground_mask),
            None => foreground_mask.clone(),
        });
    }
    if let Some(tone_alpha) = output.tone_preservation_alpha.as_ref() {
        let tone_owner =
            BinaryImage::from_fn_parallel(tone_alpha.width(), tone_alpha.height(), |x, y| {
                tone_alpha.get(x, y) > 0
            });
        ownership = Some(match ownership {
            Some(existing) => existing.or(&tone_owner),
            None => tone_owner,
        });
    }
    ownership
}

fn optical_content_bounds_x_for_output(output: &CleanupResult) -> Option<(f64, f64)> {
    output_content_ownership(output)
        .as_ref()
        .and_then(optical_binary_bounds_x)
}

fn spread_content_top_for_output(output: &CleanupResult) -> Option<f64> {
    // Measure the post-cleanup raster in the same content space that is
    // materialized. A Mixed leaf carries its tonal content in the layered
    // background rather than the published stencil, so the anchor must take
    // the earliest content row across every plane the viewer will composite;
    // measuring the stencil alone aligned a facing photo against the other
    // leaf's running head. The detector geometry remains a fallback for a
    // raster with no measurable ownership.
    let raster_top = gray_content_bounds_y(&output.image.to_gray()).map(|(top, _)| top);
    let layered_top = output
        .mixed_layers
        .as_ref()
        .and_then(|layers| gray_content_bounds_y(&layers.background).map(|(top, _)| top));
    let visible_top = [raster_top, layered_top]
        .into_iter()
        .flatten()
        .min_by(f64::total_cmp);
    let geometric_top = output
        .metadata
        .content_box
        .map(|content| content.y - output.metadata.crop_rect.y)
        .filter(|top| top.is_finite() && *top >= 0.0);
    visible_top.or(geometric_top)
}

#[cfg(test)]
fn optical_content_center_x(raster: &CleanupRaster) -> Option<f64> {
    optical_content_bounds_x(raster).map(|(left, right)| (left + right) * 0.5)
}

fn optical_binary_bounds_x(binary: &BinaryImage) -> Option<(f64, f64)> {
    let mut columns = vec![0usize; binary.width()];
    let mut ink = 0usize;
    for y in 0..binary.height() {
        for (x, column) in columns.iter_mut().enumerate() {
            if binary.get(x, y) {
                *column += 1;
                ink += 1;
            }
        }
    }
    if ink == 0 {
        return None;
    }
    let lower_rank = ((ink - 1) as f64 * 0.01).floor() as usize;
    let upper_rank = ((ink - 1) as f64 * 0.99).ceil() as usize;
    let percentile_column = |rank: usize| {
        let mut cumulative = 0usize;
        columns.iter().position(|count| {
            cumulative += *count;
            cumulative > rank
        })
    };
    let left = percentile_column(lower_rank)?;
    let right = percentile_column(upper_rank)?;
    (left <= right).then_some((left as f64, right as f64 + 1.0))
}

fn gray_content_bounds_y(gray: &GrayImage) -> Option<(f64, f64)> {
    // The cleaned raster sits on a white canvas, so anything meaningfully
    // below paper is content - a pale photo sky included. An ink-dark
    // threshold here anchored photo leaves to their first *dark* region
    // instead of their visual top, misaligning facing plates. A small
    // per-row count guards against a stray dust pixel defining the bound.
    const CONTENT_BELOW_PAPER: u8 = 245;
    const MINIMUM_ROW_PIXELS: usize = 3;
    let mut first = None;
    let mut last = None;
    for y in 0..gray.height() {
        let mut row_pixels = 0usize;
        for x in 0..gray.width() {
            if gray.get(x, y) < CONTENT_BELOW_PAPER {
                row_pixels += 1;
                if row_pixels >= MINIMUM_ROW_PIXELS {
                    break;
                }
            }
        }
        if row_pixels >= MINIMUM_ROW_PIXELS {
            first.get_or_insert(y);
            last = Some(y);
        }
    }
    Some((first? as f64, last? as f64 + 1.0))
}

/// Gives both leaves of a spread one vertical content anchor. The anchor is
/// measured in the final canvas grid, after each leaf's independent paper
/// scaling has been planned, so the existing fit-first and optical-horizontal
/// contracts remain unchanged.
///
/// The union's top is used as the shared target, then clamped to the
/// intersection of both leaves' feasible canvas ranges. A single page, an
/// unmeasurable output, or a spread whose geometry cannot share a target keeps
/// its existing placement.
fn align_spread_vertical_placements(
    placements: &mut [Option<(CanvasPlacement, DocumentCanvas)>],
    intrinsic_heights: &[usize],
    content_tops: &[Option<f64>],
    canvas: &DocumentCanvas,
) {
    if placements.len() != 2
        || intrinsic_heights.len() != placements.len()
        || content_tops.len() != placements.len()
    {
        return;
    }
    let [Some((first, _)), Some((second, _))] = placements else {
        return;
    };
    let Some(first_content_top) = content_tops[0] else {
        return;
    };
    let Some(second_content_top) = content_tops[1] else {
        return;
    };
    if !first_content_top.is_finite() || !second_content_top.is_finite() {
        return;
    }
    let first_scale = first.content_height as f64 / intrinsic_heights[0].max(1) as f64;
    let second_scale = second.content_height as f64 / intrinsic_heights[1].max(1) as f64;
    let first_scaled_top = first_content_top * first_scale;
    let second_scaled_top = second_content_top * second_scale;
    // The union's top is the later of the two local anchors: this reserves
    // enough headroom for both leaves' first meaningful content row without
    // allowing a leaf with a shorter crop to start visibly lower.
    let current_target =
        (first.top as f64 + first_scaled_top).max(second.top as f64 + second_scaled_top);
    // A spread may need to trim white crop headroom above a leaf's effective
    // origin. Allowing that signed origin makes the shared content anchor
    // feasible even when one leaf already occupies the full margin box; the
    // materializer records the trimmed source rows and never clips ink.
    let first_min = -(first.content_height.saturating_sub(1) as f64) + first_scaled_top;
    let second_min = -(second.content_height.saturating_sub(1) as f64) + second_scaled_top;
    let first_max_top = canvas
        .height_px
        .saturating_sub(first.requested_margins[3])
        .saturating_sub(first.content_height) as f64;
    let second_max_top = canvas
        .height_px
        .saturating_sub(second.requested_margins[3])
        .saturating_sub(second.content_height) as f64;
    let shared_min = first_min.max(second_min);
    let shared_max = (first_max_top + first_scaled_top).min(second_max_top + second_scaled_top);
    if shared_min > shared_max {
        return;
    }
    let target = current_target.clamp(shared_min, shared_max);
    let set_effective_top = |placement: &mut CanvasPlacement, desired: f64, max_top: f64| {
        let minimum_top = -(placement.content_height.saturating_sub(1) as isize);
        let effective_top = (desired.round() as isize).clamp(minimum_top, max_top as isize);
        if effective_top < 0 {
            placement.top = 0;
            placement.intrinsic_overflow_top = (-effective_top) as usize;
        } else {
            placement.top = effective_top as usize;
            placement.intrinsic_overflow_top = 0;
        }
    };
    set_effective_top(first, target - first_scaled_top, first_max_top);
    set_effective_top(second, target - second_scaled_top, second_max_top);
}

#[cfg(test)]
fn place_on_white_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_offset(source, width, height, left, top, 0)
}

#[cfg(test)]
fn place_on_white_canvas_with_source_offset(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_offsets(source, width, height, left, top, source_offset_x, 0)
}

#[cfg(test)]
fn place_on_white_canvas_with_source_offsets(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_y: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_window(
        source,
        width,
        height,
        left,
        top,
        source_offset_x,
        0,
        source_offset_y,
    )
}

#[allow(clippy::too_many_arguments)]
fn place_on_white_canvas_with_source_window(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_right: usize,
    source_offset_y: usize,
) -> GrayImage {
    place_on_gray_canvas_with_source_window(
        source,
        width,
        height,
        left,
        top,
        255,
        source_offset_x,
        source_offset_y,
        source_offset_right,
    )
}

#[allow(clippy::too_many_arguments)]
fn place_on_gray_canvas_with_source_window(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    fill: u8,
    source_offset_x: usize,
    source_offset_y: usize,
    source_offset_right: usize,
) -> GrayImage {
    assert!(
        left < width || source.width() == 0,
        "canvas placement offset {left} is outside width {width}"
    );
    assert!(
        top < height || source.height() == 0,
        "canvas placement offset {top} is outside height {height}"
    );
    assert!(
        source_offset_x <= source.width(),
        "canvas source offset {source_offset_x} is outside source width {}",
        source.width()
    );
    assert!(
        source_offset_y <= source.height(),
        "canvas source offset {source_offset_y} is outside source height {}",
        source.height()
    );
    assert!(
        source_offset_x.saturating_add(source_offset_right) <= source.width(),
        "canvas source window {source_offset_x}..-{} is outside source width {}",
        source_offset_right,
        source.width()
    );
    let mut canvas = GrayImage::new(width, height, fill);
    canvas
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y
                .checked_sub(top)
                .and_then(|y| y.checked_add(source_offset_y))
                .filter(|&y| y < source.height())
            {
                let copy_width = width.saturating_sub(left).min(
                    source
                        .width()
                        .saturating_sub(source_offset_x)
                        .saturating_sub(source_offset_right),
                );
                if copy_width > 0 {
                    row[left..left + copy_width].copy_from_slice(
                        &source.row(source_y)[source_offset_x..source_offset_x + copy_width],
                    );
                }
            }
        });
    canvas
}

#[allow(clippy::too_many_arguments)]
fn place_rgb_on_white_canvas_with_source_window(
    source: &RgbImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_right: usize,
    source_offset_y: usize,
) -> RgbImage {
    assert!(
        left < width || source.width() == 0,
        "canvas placement offset {left} is outside width {width}"
    );
    assert!(
        top < height || source.height() == 0,
        "canvas placement offset {top} is outside height {height}"
    );
    assert!(
        source_offset_x <= source.width(),
        "canvas source offset {source_offset_x} is outside source width {}",
        source.width()
    );
    assert!(
        source_offset_y <= source.height(),
        "canvas source offset {source_offset_y} is outside source height {}",
        source.height()
    );
    assert!(
        source_offset_x.saturating_add(source_offset_right) <= source.width(),
        "canvas source window {source_offset_x}..-{} is outside source width {}",
        source_offset_right,
        source.width()
    );
    let mut canvas = RgbImage::new(width, height, [255; 3]);
    canvas
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y
                .checked_sub(top)
                .and_then(|y| y.checked_add(source_offset_y))
                .filter(|&y| y < source.height())
            {
                let copy_width = width.saturating_sub(left).min(
                    source
                        .width()
                        .saturating_sub(source_offset_x)
                        .saturating_sub(source_offset_right),
                );
                if copy_width > 0 {
                    let start = left * 3;
                    row[start..start + copy_width * 3].copy_from_slice(
                        &source.row(source_y)
                            [source_offset_x * 3..(source_offset_x + copy_width) * 3],
                    );
                }
            }
        });
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

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::io::write_atomic(path, &bytes).map_err(|error| std::io::Error::other(error).into())
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
        adaptive_thread_count, align_deferred_spread_vertical_placements,
        align_spread_vertical_placements, background_canvas_dimensions,
        background_dimensions_to_publish, canvas_fit_for, edge_near_paper_run_in_gray,
        estimate_peak_page_bytes, fold_side_near_paper_run_in_gray, fold_trim_for, manifest_cache,
        manifest_worker_threads, map_image_error, matched_output_paper_dimensions_for,
        materialize_gray_primary_on_canvas, materialize_stream_page,
        normalize_trusted_foreground_selection, optical_binary_bounds_x, optical_content_bounds_x,
        optical_content_center_x, page_worker_threads, parse_cli_args, place_on_white_canvas,
        place_on_white_canvas_with_source_offset, plan_canvas_placement_for,
        plan_canvas_placement_for_with_optical_center,
        plan_canvas_placement_for_with_optical_center_and_fit,
        plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim,
        plan_canvas_placement_with_shared_fit, preflight_manifest_paths,
        preserve_tier1_provenance_after_rerun, reconcile_classification_batch,
        robust_quantile_dimension, run_manifest_transaction, run_stream_page_jobs, CanvasPlacement,
        CleanupRaster, DeferredSpreadVerticalPlacement, FoldSideTrim, HorizontalEdge,
        NearPaperEdgeRuns, PageResultMetadata, PageRunResult, ScanCleanupCliInvocation,
        SharedSpreadOverflowPlan, Tier1Provenance, WrittenOutput, FALLBACK_SYSTEM_MEMORY_BYTES,
    };
    use crate::{
        protocol::manifest_v3::{
            AnalysisPurpose, CanvasScope, DocumentCanvas, ManifestV3, Operation, Page, PageOutput,
            RenderMode, SplitSeamPolyline, VERSION,
        },
        protocol::progress::PageStageTimings,
        split::{ClusterDimensions, DocumentPrior, LayoutClassification},
        CleanupOptions, OrthogonalRotation, OutputMode,
    };
    use evb_native_support::{NativeError, NativeErrorCode};
    use scan_primitives::{BinaryImage, GrayImage, Point};
    use std::{
        collections::HashMap,
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
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
            ScanCleanupCliInvocation::Manifest(PathBuf::from("/tmp/manifest.json")),
        );
        assert_eq!(
            parse_cli_args(&cli_args(&["--protocol-version"])).unwrap(),
            ScanCleanupCliInvocation::ProtocolVersion,
        );
        assert_eq!(
            parse_cli_args(&cli_args(&["--version"])).unwrap(),
            ScanCleanupCliInvocation::Version,
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
            (&["--input=page.ppm"], "Unknown argument --input=page.ppm"),
            (&["--version", "--ocr-mode"], "--version must be used alone"),
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
    fn batch_failure_rolls_back_every_declared_destination_across_pages() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-transaction-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        fs::write(&input, b"input must survive rollback").unwrap();
        let output = |page: usize| PageOutput {
            output_path: dir.join(format!("page-{page}.png")),
            metadata_path: dir.join(format!("page-{page}-output.json")),
            bilevel_output_path: Some(dir.join(format!("page-{page}.pbm"))),
            background_output_path: Some(dir.join(format!("page-{page}-background.png"))),
            foreground_mask_output_path: Some(dir.join(format!("page-{page}-foreground.pbm"))),
            foreground_alpha_output_path: Some(dir.join(format!("page-{page}-foreground.png"))),
            picture_mask_output_path: Some(dir.join(format!("page-{page}-picture.pbm"))),
            tone_preservation_alpha_output_path: Some(dir.join(format!("page-{page}-tone.png"))),
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            pages: (0..2)
                .map(|page| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: page,
                    page_metadata_path: dir.join(format!("page-{page}-page.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: vec![output(page)],
                })
                .collect(),
        };
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        assert_eq!(destinations.len(), 18);

        let error = run_manifest_transaction(&manifest, || {
            // Page one publishes every raster/layer/metadata role. Page two
            // then leaves a partial publication before processing fails.
            for path in &destinations[..9] {
                fs::write(path, b"page one published")?;
            }
            for path in &destinations[9..12] {
                fs::write(path, b"page two partial")?;
            }
            Err(std::io::Error::other("page two failed").into())
        })
        .unwrap_err();

        assert!(error.to_string().contains("page two failed"));
        assert_eq!(fs::read(&input).unwrap(), b"input must survive rollback");
        for path in destinations {
            assert!(!path.exists(), "rollback left {}", path.display());
        }
        fs::remove_dir_all(dir).unwrap();
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
    fn matched_canvas_dimension_uses_nearest_rank_ninetieth_percentile() {
        assert_eq!(robust_quantile_dimension([60, 60].into_iter()), 60);
        assert_eq!(
            robust_quantile_dimension([80, 80, 80, 80, 80, 80, 80, 80, 80, 140].into_iter()),
            80
        );
    }

    #[test]
    fn background_publication_guard_handles_coarse_grid_rounding_boundary() {
        let canvas = DocumentCanvas {
            width_points: 411.0,
            height_points: 595.0,
            width_px: 1_713,
            height_px: 2_479,
        };
        let expected = background_canvas_dimensions(&canvas, 150.0);
        assert_eq!(expected, (856, 1_240));
        for (actual, expected_target) in [
            (expected, expected),
            ((855, 1_239), expected),
            ((857, 1_241), expected),
        ] {
            assert_eq!(
                background_dimensions_to_publish(
                    actual.0,
                    actual.1,
                    expected_target.0,
                    expected_target.1,
                ),
                expected,
                "actual background dimensions: {actual:?}",
            );
        }
    }

    #[test]
    fn matched_canvas_uses_one_paper_scale_across_an_off_center_spread_cutter() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([30.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let left_paper = matched_output_paper_dimensions_for(
            2_203,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let right_paper = matched_output_paper_dimensions_for(
            2_203,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Right,
        );
        assert_eq!(left_paper, (1_101.5, 1_573.0));
        assert_eq!(right_paper, left_paper);

        let left = plan_canvas_placement_for(
            876,
            1_407,
            left_paper.0,
            left_paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
        );
        let right = plan_canvas_placement_for(
            607,
            1_405,
            right_paper.0,
            right_paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
        );

        assert_eq!(left.paper_scale, right.paper_scale);
        assert!(left.content_height.abs_diff(right.content_height) <= 2);
        assert_eq!((left.content_width, left.content_height), (876, 1_408));
        assert_eq!((right.content_width, right.content_height), (607, 1_406));
        assert_eq!((left.left, left.top), (113, 30));
        assert_eq!((right.left, right.top), (247, 30));
        assert_eq!(canvas.width_px - left.left - left.content_width, left.left);
        assert!((canvas.width_px - right.left - right.content_width).abs_diff(right.left) <= 1);
    }

    #[test]
    fn matched_canvas_uses_one_overflow_fit_across_an_off_center_spread_cutter() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let leaves = [(1_198, 1_198), (599, 599)];
        let shared_fit = leaves
            .into_iter()
            .map(|(width, height)| {
                canvas_fit_for(width, height, paper.0, paper.1, true, &options, &canvas)
                    .overflow_fit
            })
            .reduce(f64::min)
            .unwrap();
        assert!(shared_fit < 1.0);

        let left = plan_canvas_placement_for_with_optical_center_and_fit(
            leaves[0].0,
            leaves[0].1,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            None,
            Some(shared_fit),
        );
        let right = plan_canvas_placement_for_with_optical_center_and_fit(
            leaves[1].0,
            leaves[1].1,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
            None,
            Some(shared_fit),
        );

        assert!(left.overflow);
        assert!(right.overflow);
        assert_eq!(
            left.content_width * leaves[1].0,
            right.content_width * leaves[0].0
        );
        assert_eq!(
            left.content_height * leaves[1].1,
            right.content_height * leaves[0].1
        );
    }

    #[test]
    fn fold_tail_with_pale_edge_glyph_is_never_trimmed() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let mut leaf = GrayImage::new(1_198, 64, 255);
        // Reviewer regression: a pale gray-246 glyph reaching the fold-side
        // edge is still writing, not disposable paper. No later white column
        // may be skipped over even though fitting requires horizontal trim.
        for y in 20..44 {
            leaf.set(1_197, y, 246);
        }
        let run = fold_side_near_paper_run_in_gray(&leaf, crate::pipeline::PageHalf::Left);
        let fit = canvas_fit_for(
            leaf.width(),
            leaf.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        );
        let trim = fold_trim_for(leaf.width(), crate::pipeline::PageHalf::Left, run, fit);

        assert_eq!(run, 0);
        assert_eq!(trim.total(), 0);
        assert!(fit.overflow_fit < 1.0);
    }

    #[test]
    fn provably_white_fold_tail_restores_shared_fit_without_changing_leaf_scale() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let mut left_raster = GrayImage::new(1_198, 1_198, 0);
        for y in 0..left_raster.height() {
            for x in 1_118..left_raster.width() {
                left_raster.set(x, y, 255);
            }
        }
        let left_fit = canvas_fit_for(
            left_raster.width(),
            left_raster.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        );
        let left_trim = fold_trim_for(
            left_raster.width(),
            crate::pipeline::PageHalf::Left,
            fold_side_near_paper_run_in_gray(&left_raster, crate::pipeline::PageHalf::Left),
            left_fit,
        );
        let shared_fit = canvas_fit_for(
            left_trim.effective_width(left_raster.width()),
            left_raster.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        )
        .overflow_fit
        .min(canvas_fit_for(599, 599, paper.0, paper.1, true, &options, &canvas).overflow_fit);

        let left = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            1_198,
            1_198,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            None,
            Some(shared_fit),
            left_trim,
            Default::default(),
        );
        let right = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            599,
            599,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
            None,
            Some(shared_fit),
            Default::default(),
            Default::default(),
        );

        assert_eq!(shared_fit, 1.0);
        assert!(left_trim.right > 0);
        assert!(!left.overflow);
        assert!(!right.overflow);
        let left_scale = left.content_width as f64 / 1_198.0;
        let right_scale = right.content_width as f64 / 599.0;
        assert!((left_scale - right_scale).abs() < 0.001);
        assert_eq!(left.fold_trim_right, left_trim.right);
        assert!(left.fold_clip_right > 0);
        assert_eq!(left.fold_clip_left, 0);
        assert!(left.materialization_source_offset_right > 0);
    }

    #[test]
    fn matched_canvas_aligns_the_intrinsic_raster_inside_the_canvas() {
        let options = CleanupOptions {
            dpi: 360.0,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 700.0 / 360.0 * 72.0,
            height_points: 1_000.0 / 360.0 * 72.0,
            width_px: 700,
            height_px: 1_000,
        };

        let cropped = plan_canvas_placement_for(
            580,
            820,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );
        let uncropped = plan_canvas_placement_for(
            700,
            1_000,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert_eq!((cropped.left, cropped.top), (60, 0));
        assert_eq!((uncropped.left, uncropped.top), (0, 0));
        assert_eq!(cropped.content_width, 580);
        assert_eq!(cropped.content_height, 820);
    }

    #[test]
    fn spread_vertical_alignment_pins_asymmetric_crop_headroom_to_one_anchor() {
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let placement = |top| CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 0,
            top,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 0,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![
            Some((placement(100), canvas)),
            Some((placement(100), canvas)),
        ];

        align_spread_vertical_placements(
            &mut placements,
            &[1_000, 1_000],
            &[Some(20.0), Some(120.0)],
            &canvas,
        );

        let first = placements[0].as_ref().unwrap().0;
        let second = placements[1].as_ref().unwrap().0;
        let first_content_top = first.top as f64 + 20.0 * 0.7;
        let second_content_top = second.top as f64 + 120.0 * 0.7;
        assert_eq!(first.top, 170);
        assert_eq!(second.top, 100);
        assert!((first_content_top - second_content_top).abs() <= 0.5);
    }

    #[test]
    fn deferred_spread_placement_uses_the_shared_vertical_content_anchor() {
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let placement = |top| CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 0,
            top,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 0,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![placement(100), placement(100)];
        let outputs = [
            DeferredSpreadVerticalPlacement {
                source_page_index: 7,
                half: crate::pipeline::PageHalf::Left,
                intrinsic_height: 1_000,
                content_top: Some(20.0),
            },
            DeferredSpreadVerticalPlacement {
                source_page_index: 7,
                half: crate::pipeline::PageHalf::Right,
                intrinsic_height: 1_000,
                content_top: Some(120.0),
            },
        ];

        align_deferred_spread_vertical_placements(
            &mut placements,
            &outputs,
            &HashMap::from([(7, 1.0)]),
            &canvas,
        );

        assert_eq!(placements[0].top, 170);
        assert_eq!(placements[1].top, 100);
        assert_eq!(placements[0].intrinsic_overflow_top, 0);
        assert_eq!(placements[1].intrinsic_overflow_top, 0);
    }

    #[test]
    fn deferred_vertical_alignment_leaves_a_single_page_unchanged() {
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let original = CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 150,
            top: 125,
            requested_margins: [10, 20, 30, 40],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 150,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![original];
        let outputs = [DeferredSpreadVerticalPlacement {
            source_page_index: 3,
            half: crate::pipeline::PageHalf::Full,
            intrinsic_height: 1_000,
            content_top: Some(60.0),
        }];

        align_deferred_spread_vertical_placements(
            &mut placements,
            &outputs,
            &HashMap::<usize, f64>::new(),
            &canvas,
        );

        assert_eq!(placements, [original]);
    }

    #[test]
    fn matched_canvas_aligns_intrinsic_whitespace_with_the_raster() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        // The intrinsic raster carries 50 px of synthetic paper to its left.
        // Placement aligns that raster as one unit; source-space crop origins
        // remain mapping metadata and cannot move the raster on the canvas.
        let placement = plan_canvas_placement_for(
            850,
            1_000,
            800.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );
        assert_eq!(placement.left, 75);

        let mut intrinsic = GrayImage::new(850, 1_000, 255);
        intrinsic.set(50, 100, 0);
        let composed = place_on_white_canvas(
            &intrinsic,
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(100, 100), 255);
        assert_eq!(composed.get(125, 100), 0);
    }

    #[test]
    fn matched_canvas_centers_transformed_optical_ink_not_intrinsic_raster() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let mut binary = BinaryImage::new(580, 820);
        binary.set(100, 100, true);
        binary.set(120, 100, true);
        let optical_raster = CleanupRaster::Bilevel(binary);
        let optical_bounds = optical_content_bounds_x(&optical_raster);
        assert_eq!(optical_bounds, Some((100.0, 121.0)));
        let optical_center = optical_content_center_x(&optical_raster);
        assert_eq!(optical_center, Some(110.5));

        let placement = plan_canvas_placement_for_with_optical_center(
            580,
            820,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            optical_bounds,
        );

        assert_eq!(placement.left, 390);
        let scaled_center = optical_center.unwrap() * placement.content_width as f64 / 580.0;
        let placed_center = placement.left as f64 + scaled_center;
        assert!((placed_center - 500.0).abs() <= 0.5);
    }

    #[test]
    fn optical_bounds_ignore_a_sparse_corner_folio() {
        let mut binary = BinaryImage::new(400, 240);
        for y in 90..150 {
            for x in 100..300 {
                binary.set(x, y, true);
            }
        }
        binary.set(4, 4, true);
        let bounds = optical_binary_bounds_x(&binary).expect("title ink");
        assert!(bounds.0 >= 100.0);
        assert!(bounds.1 <= 300.0);

        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 480.0,
            height_points: 288.0,
            width_px: 480,
            height_px: 288,
        };
        let placement = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some(bounds),
        );
        let scale = placement.content_width as f64 / 400.0;
        let center = placement.left as f64 + (bounds.0 + bounds.1) * 0.5 * scale;
        assert!((center - canvas.width_px as f64 / 2.0).abs() <= 0.5);
    }

    #[test]
    fn optical_placement_boundary_handles_empty_and_full_bleed_pages() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_pixels: Some([20.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 480.0,
            height_points: 288.0,
            width_px: 480,
            height_px: 288,
        };
        let empty = BinaryImage::new(400, 240);
        let empty_placement = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            optical_binary_bounds_x(&empty),
        );
        assert!(!empty_placement.optical_content_centered);
        assert_eq!(empty_placement.optical_content_bounds_x, None);

        let full_bleed = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some((0.0, 400.0)),
        );
        let scale = full_bleed.content_width as f64 / 400.0;
        assert!(
            full_bleed.left as f64 + 400.0 * scale
                <= canvas.width_px as f64 - options.margins_pixels.unwrap()[2] + 0.5
        );
        assert_eq!(full_bleed.intrinsic_overflow_right, 0);
    }

    #[test]
    fn matched_canvas_centers_optical_box_when_white_raster_tail_overhangs() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let optical_bounds = Some((10.0, 1_811.0));
        let placement = plan_canvas_placement_for_with_optical_center(
            2_038,
            2_940,
            2_196.0,
            3_241.0,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            optical_bounds,
        );

        // The white tail may not push the payload past the canvas: the raster
        // slides back inside, and the ink center drifts from ideal by at most
        // the tail width it displaced.
        assert!(placement.left + placement.content_width <= canvas.width_px);
        assert_eq!(placement.left, canvas.width_px - placement.content_width);
        assert_eq!(placement.intrinsic_overflow_right, 0);
        let scaled_center = 910.5 * placement.content_width as f64 / 2_038.0;
        let drift = (placement.left as f64 + scaled_center - 1_098.0).abs();
        assert!(
            drift <= 30.0,
            "center drift {drift} exceeds the displaced tail"
        );
    }

    #[test]
    fn sparse_left_title_leaf_centers_visible_stencil_with_proven_outer_overhang() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::TopCenter,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let left = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            2_298,
            2_810,
            2_196.0,
            3_136.0,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            Some((336.0, 2_002.0)),
            Some(1.0),
            FoldSideTrim {
                left: 0,
                right: 219,
            },
            NearPaperEdgeRuns {
                left: 300,
                right: 0,
            },
        );
        let right = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            1_605,
            3_098,
            2_196.0,
            3_136.0,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
            Some((175.0, 1_301.0)),
            Some(1.0),
            FoldSideTrim::default(),
            NearPaperEdgeRuns::default(),
        );

        assert_eq!(left.intrinsic_overflow_left, 71);
        assert_eq!(left.intrinsic_overflow_right, 31);
        assert_eq!(left.materialization_source_offset_left, 71);
        assert_eq!(left.materialization_source_offset_right, 219);
        let left_optical_center = -71.0 + (336.0 + 2_002.0) * 0.5;
        assert_eq!(left_optical_center, canvas.width_px as f64 * 0.5);
        // The balanced facing leaf is pinned to its pre-fix placement.
        assert_eq!(right.left, 360);
        assert_eq!(right.intrinsic_overflow_left, 0);
        assert_eq!(right.intrinsic_overflow_right, 0);
    }

    #[test]
    fn deferred_sparse_leaf_uses_carried_optical_bounds_and_outer_edge_proof() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::TopCenter,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let output = WrittenOutput {
            output_path: PathBuf::new(),
            metadata_path: PathBuf::new(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
            options: options.clone(),
            source_page_index: 0,
            half: crate::pipeline::PageHalf::Left,
            width: 2_298,
            height: 2_810,
            paper_width: 2_196.0,
            paper_height: 3_136.0,
            content_detected: true,
            spread_content_top: None,
            optical_content_bounds_x: Some((336.0, 2_002.0)),
            fold_side_near_paper_run: 219,
            outer_near_paper_edge_runs: NearPaperEdgeRuns {
                left: 300,
                right: 0,
            },
            matched_in_memory: false,
        };
        let shared_plan = SharedSpreadOverflowPlan {
            shared_fit: 1.0,
            trims: vec![FoldSideTrim {
                left: 0,
                right: 219,
            }],
        };

        let deferred = plan_canvas_placement_with_shared_fit(&output, &canvas, Some(&shared_plan));
        let in_memory = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            output.width,
            output.height,
            output.paper_width,
            output.paper_height,
            output.content_detected,
            &options,
            output.half,
            &canvas,
            output.optical_content_bounds_x,
            Some(shared_plan.shared_fit),
            shared_plan.trims[0],
            output.outer_near_paper_edge_runs,
        );

        assert_eq!(deferred, in_memory);
        assert!(deferred.optical_content_centered);
        assert_eq!(deferred.intrinsic_overflow_left, 71);
        assert_eq!(deferred.intrinsic_overflow_right, 31);

        // Tightening a false outer-rail content bound removes the rail from
        // the intrinsic raster. The genuine paper-only fold tail must still
        // authorize the same optical placement, or the visible stencil moves
        // even though its ownership box is unchanged.
        let tightened = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            2_010,
            2_811,
            output.paper_width,
            output.paper_height,
            output.content_detected,
            &options,
            output.half,
            &canvas,
            Some((47.0, 1_713.0)),
            Some(shared_plan.shared_fit),
            FoldSideTrim::default(),
            NearPaperEdgeRuns {
                left: 0,
                right: 220,
            },
        );
        assert!(tightened.optical_content_centered);
        assert_eq!(tightened.left, 218);
        assert_eq!(tightened.intrinsic_overflow_right, 32);
        let original_optical_left =
            deferred.left as isize - deferred.intrinsic_overflow_left as isize + 336;
        let tightened_optical_left =
            tightened.left as isize - tightened.intrinsic_overflow_left as isize + 47;
        assert_eq!(tightened_optical_left, original_optical_left);
    }

    #[test]
    fn outer_edge_glyph_blocks_optical_overhang() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 360.0,
            width_px: 1_000,
            height_px: 500,
        };
        let mut leaf = GrayImage::new(1_000, 500, 255);
        leaf.set(0, 250, 0);
        let outer_run = edge_near_paper_run_in_gray(&leaf, HorizontalEdge::Left);
        let placement = plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
            1_000,
            500,
            1_000.0,
            500.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some((300.0, 950.0)),
            None,
            FoldSideTrim::default(),
            NearPaperEdgeRuns {
                left: outer_run,
                right: 0,
            },
        );

        assert_eq!(outer_run, 0);
        assert_eq!(placement.left, 0);
        assert_eq!(placement.intrinsic_overflow_left, 0);
        assert_eq!(placement.intrinsic_overflow_right, 0);
    }

    #[test]
    fn matched_canvas_records_and_clips_a_white_left_raster_tail() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 360.0,
            width_px: 1_000,
            height_px: 500,
        };
        let placement = plan_canvas_placement_for_with_optical_center(
            1_000,
            500,
            1_000.0,
            500.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some((300.0, 950.0)),
        );

        // A full-width raster cannot shift at all: it stays at the origin
        // with no overhang, and every source pixel keeps its coordinate.
        assert_eq!(placement.left, 0);
        assert_eq!(placement.intrinsic_overflow_left, 0);
        assert_eq!(placement.intrinsic_overflow_right, 0);

        let mut source = GrayImage::new(1_000, 500, 255);
        source.set(625, 250, 0);
        let materialized = place_on_white_canvas_with_source_offset(
            &source,
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
            placement.intrinsic_overflow_left,
        );
        assert_eq!(materialized.get(625, 250), 0);
    }

    #[test]
    fn matched_gray_primary_with_intrinsic_margins_is_materialized_on_canvas() {
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 600.0,
            width_px: 12,
            height_px: 10,
        };
        let placement = CanvasPlacement {
            content_width: 6,
            content_height: 4,
            left: 3,
            top: 2,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 3,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let source = GrayImage::new(10, 8, 0);
        let materialized = materialize_gray_primary_on_canvas(&source, placement, &canvas);

        assert_eq!((materialized.width(), materialized.height()), (12, 10));
        assert_eq!(materialized.get(2, 2), 255);
        assert_eq!(materialized.get(3, 2), 0);
        assert_eq!(materialized.get(8, 5), 0);
        assert_eq!(materialized.get(9, 2), 255);
    }

    #[test]
    fn matched_canvas_keeps_requested_margins_on_the_final_grid() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            margins_pixels: Some([20.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        let placement = plan_canvas_placement_for(
            1_000,
            1_000,
            1_000.0,
            1_000.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert_eq!(placement.requested_margins, [20; 4]);
        assert_eq!((placement.left, placement.top), (20, 20));
        assert_eq!(
            (placement.content_width, placement.content_height),
            (960, 960)
        );
        let intrinsic = GrayImage::new(1_000, 1_000, 0);
        let composed = place_on_white_canvas(
            &intrinsic.resample_to_dimensions(placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(19, 20), 255);
        assert_eq!(composed.get(20, 20), 0);
        assert_eq!(composed.get(979, 979), 0);
        assert_eq!(composed.get(980, 979), 255);
    }

    #[test]
    fn matched_canvas_converts_millimeter_margins_on_the_final_grid() {
        let options = CleanupOptions {
            dpi: 360.0,
            page_alignment: crate::PageAlignment::Center,
            margins_mm: Some(crate::MarginsMm {
                left_mm: 5.0,
                top_mm: 5.0,
                right_mm: 5.0,
                bottom_mm: 5.0,
            }),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 200.0,
            height_points: 200.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        let placement = plan_canvas_placement_for(
            1_000,
            1_000,
            1_000.0,
            1_000.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        // 5 mm at 360 DPI is 70.866 px: reserve the nearest final-grid
        // pixel. Alignment/cropping may leave a larger band, never a smaller
        // one.
        assert_eq!(placement.requested_margins, [71; 4]);
        assert_eq!((placement.left, placement.top), (71, 71));
        assert_eq!(
            (placement.content_width, placement.content_height),
            (858, 858)
        );
        let intrinsic = GrayImage::new(1_000, 1_000, 0);
        let composed = place_on_white_canvas(
            &intrinsic.resample_to_dimensions(placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(70, 71), 255);
        assert_eq!(composed.get(71, 71), 0);
        assert_eq!(composed.get(928, 928), 0);
        assert_eq!(composed.get(929, 928), 255);
    }

    #[test]
    fn matched_canvas_honors_every_alignment_inside_asymmetric_margins() {
        let canvas = DocumentCanvas {
            width_points: 144.0,
            height_points: 129.6,
            width_px: 200,
            height_px: 180,
        };
        let cases = [
            (crate::PageAlignment::TopLeft, (11, 13)),
            (crate::PageAlignment::TopCenter, (67, 13)),
            (crate::PageAlignment::TopRight, (123, 13)),
            (crate::PageAlignment::CenterLeft, (11, 67)),
            (crate::PageAlignment::Center, (67, 67)),
            (crate::PageAlignment::CenterRight, (123, 67)),
            (crate::PageAlignment::BottomLeft, (11, 121)),
            (crate::PageAlignment::BottomCenter, (67, 121)),
            (crate::PageAlignment::BottomRight, (123, 121)),
        ];

        for (page_alignment, expected) in cases {
            let options = CleanupOptions {
                dpi: 100.0,
                page_alignment,
                margins_pixels: Some([11.0, 13.0, 17.0, 19.0]),
                ..CleanupOptions::default()
            };
            let placement = plan_canvas_placement_for(
                60,
                40,
                200.0,
                180.0,
                true,
                &options,
                crate::pipeline::PageHalf::Full,
                &canvas,
            );

            assert_eq!(placement.requested_margins, [11, 13, 17, 19]);
            assert_eq!(
                (placement.content_width, placement.content_height),
                (60, 40)
            );
            assert_eq!((placement.left, placement.top), expected);
        }
    }

    #[test]
    fn matched_canvas_keeps_bottom_right_alignment_when_margins_are_reduced() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::BottomRight,
            margins_pixels: Some([8.0, 9.0, 4.0, 3.0]),
            ..CleanupOptions::default()
        };
        let canvas = DocumentCanvas {
            width_points: 7.2,
            height_points: 5.76,
            width_px: 10,
            height_px: 8,
        };

        let placement = plan_canvas_placement_for(
            4,
            4,
            10.0,
            8.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert!(placement.margins_reduced);
        assert_eq!(placement.requested_margins, [6, 5, 3, 2]);
        assert_eq!((placement.content_width, placement.content_height), (1, 1));
        assert_eq!((placement.left, placement.top), (6, 5));
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
            + 5.0 * estimate_peak_page_bytes(2119, 3204, Operation::Render, OutputMode::Bw) as f64;
        let ratio = modelled / MEASURED_PEAK_BYTES;
        assert!(
            (0.75..=1.25).contains(&ratio),
            "modelled {modelled:.0} B is {ratio:.2}x the measured 1.60 GB peak",
        );
    }

    #[test]
    fn peak_page_estimate_accounts_for_rgb_analysis_and_auto_render() {
        let pixels = 2_000 * 1_500;
        let gray_render = estimate_peak_page_bytes(2_000, 1_500, Operation::Render, OutputMode::Bw);
        let analysis = estimate_peak_page_bytes(2_000, 1_500, Operation::Analyze, OutputMode::Bw);
        let auto_render =
            estimate_peak_page_bytes(2_000, 1_500, Operation::Render, OutputMode::Auto);

        assert_eq!(gray_render, pixels * 40);
        assert_eq!(analysis, pixels * 80);
        assert_eq!(auto_render, pixels * 80);
    }

    #[test]
    fn manifest_worker_sizing_applies_the_decode_policy() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-policy-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |operation, output_mode| ManifestV3 {
            version: VERSION,
            operation,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            // 600 kB remains after the process/cache split: enough for two
            // 40-Bpp pages, but only one 80-Bpp page.
            host_memory_bytes: Some(2_000_000),
            raster_window: 1,
            pages: (0..2)
                .map(|source_page_index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index,
                    page_metadata_path: dir.join(format!("page-{source_page_index}.json")),
                    options: CleanupOptions {
                        output_mode,
                        ..CleanupOptions::default()
                    },
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };

        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Render, OutputMode::Bw)).unwrap(),
            2
        );
        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Analyze, OutputMode::Bw)).unwrap(),
            1
        );
        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Render, OutputMode::Auto)).unwrap(),
            1
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_path_preflight_rejects_hardlink_aliases() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-manifest-aliases-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        let input_alias = dir.join("input-alias.png");
        fs::write(&input, b"input").unwrap();
        fs::hard_link(&input, &input_alias).unwrap();
        let mut manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            pages: vec![Page {
                input_path: input,
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: None,
                trusted_mrc_background_path: None,
                source_page_index: 0,
                page_metadata_path: input_alias,
                options: CleanupOptions::default(),
                document_prior: None,
                detail_render_plan: None,
                outputs: Vec::new(),
            }],
        };
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("aliases an input file"));

        let shared_destination = dir.join("shared-destination");
        let destination_alias = dir.join("destination-alias");
        fs::write(&shared_destination, b"old output").unwrap();
        fs::hard_link(&shared_destination, &destination_alias).unwrap();
        manifest.operation = Operation::Render;
        manifest.pages[0].options.match_page_size = false;
        manifest.pages[0].page_metadata_path = shared_destination.clone();
        manifest.pages[0].outputs.push(PageOutput {
            output_path: dir.join("output.png"),
            metadata_path: destination_alias.clone(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        });
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("different files"));
        assert_eq!(fs::read(&shared_destination).unwrap(), b"old output");
        assert_eq!(fs::read(&destination_alias).unwrap(), b"old output");

        let _ = fs::remove_dir_all(dir);
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
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes,
            raster_window: 1,
            pages: (0..8)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
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

    #[cfg(unix)]
    #[test]
    fn streamed_inputs_use_one_page_worker_to_avoid_fifo_pool_deadlock() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-worker-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("page.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            pages: (0..8)
                .map(|index| Page {
                    input_path: fifo.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };

        assert_eq!(page_worker_threads(&manifest).unwrap(), 1);
        let _ = fs::remove_file(fifo);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn streamed_pages_are_bounded_materialized_files_during_processing() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-materialization-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..3)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            pages: fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| Page {
                    input_path: input_path.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let producer_paths = fifo_paths.clone();
        let producer = std::thread::spawn(move || {
            for (index, path) in producer_paths.iter().enumerate() {
                fs::write(path, format!("page-{index}")).unwrap();
            }
        });

        let processed = run_stream_page_jobs(&manifest, |(index, page)| {
            let metadata = fs::metadata(&page.input_path).unwrap();
            assert!(metadata.is_file(), "the task must never reopen a FIFO");
            let bytes = fs::read(&page.input_path).unwrap();
            assert_eq!(bytes, format!("page-{index}").as_bytes());
            Ok::<_, NativeError>(bytes)
        })
        .unwrap();

        producer.join().unwrap();
        assert_eq!(processed.len(), 3);
        assert!(
            fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".raster")),
            "bounded materializations must be removed after processing"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn streamed_page_window_overlaps_materialization_without_exceeding_its_bound() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-window-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..5)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 3,
            pages: fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| Page {
                    input_path: input_path.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let producer_paths = fifo_paths.clone();
        let producer = std::thread::spawn(move || {
            for (index, path) in producer_paths.iter().enumerate() {
                fs::write(path, format!("page-{index}")).unwrap();
            }
        });
        let observed_lookahead = AtomicBool::new(false);
        let peak_materializations = AtomicUsize::new(0);
        let count_materializations = || {
            fs::read_dir(&dir)
                .unwrap()
                .filter(|entry| {
                    entry
                        .as_ref()
                        .is_ok_and(|entry| entry.file_name().to_string_lossy().contains(".raster"))
                })
                .count()
        };

        let processed = run_stream_page_jobs(&manifest, |(index, page)| {
            if index == 0 {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    let live = count_materializations();
                    peak_materializations.fetch_max(live, Ordering::AcqRel);
                    if live == manifest.raster_window {
                        observed_lookahead.store(true, Ordering::Release);
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "reader did not fill the promised raster window"
                    );
                    std::thread::yield_now();
                }
            }
            let live = count_materializations();
            peak_materializations.fetch_max(live, Ordering::AcqRel);
            assert!(live <= manifest.raster_window);
            let bytes = fs::read(&page.input_path).unwrap();
            assert_eq!(bytes, format!("page-{index}").as_bytes());
            Ok::<_, NativeError>(bytes)
        })
        .unwrap();

        producer.join().unwrap();
        assert_eq!(processed.len(), 5);
        assert!(observed_lookahead.load(Ordering::Acquire));
        assert_eq!(peak_materializations.load(Ordering::Acquire), 3);
        assert!(
            fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".raster")),
            "windowed materializations must be removed after processing"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_stream_removes_its_partial_materialization() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-oversize-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("page.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let page = Page {
            input_path: fifo.clone(),
            analysis_input_path: None,
            analysis_dpi: None,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
            source_page_index: 0,
            page_metadata_path: dir.join("page.json"),
            options: CleanupOptions::default(),
            document_prior: None,
            detail_render_plan: None,
            outputs: Vec::new(),
        };
        let producer = std::thread::spawn(move || {
            let _ = fs::write(fifo, b"this stream is larger than eight bytes");
        });

        let error = match materialize_stream_page(0, &page, 8, || false) {
            Ok(_) => panic!("oversize stream unexpectedly materialized"),
            Err(error) => error,
        };

        producer.join().unwrap();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn first_stream_task_failure_never_opens_an_unwritten_next_fifo() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-turnstile-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = [dir.join("page-0.fifo"), dir.join("page-1.fifo")];
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            pages: fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| Page {
                    input_path: input_path.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let first_fifo = fifo_paths[0].clone();
        let producer = std::thread::spawn(move || fs::write(first_fifo, b"first page"));

        let error = run_stream_page_jobs(&manifest, |(index, _)| {
            Err::<(), _>(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("page {} failed", index + 1),
            ))
        })
        .unwrap_err();

        producer.join().unwrap().unwrap();
        assert!(error.to_string().contains("page 1 failed"));
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn windowed_stream_task_failure_cancels_an_open_unwritten_fifo() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-window-failure-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..3)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 3,
            pages: fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| Page {
                    input_path: input_path.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let first_fifo = fifo_paths[0].clone();
        let producer = std::thread::spawn(move || fs::write(first_fifo, b"first page"));
        let (finished_sender, finished_receiver) = std::sync::mpsc::channel();
        let run = std::thread::spawn(move || {
            let result = run_stream_page_jobs(&manifest, |(index, _)| {
                Err::<(), _>(NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("page {} failed", index + 1),
                ))
            });
            let _ = finished_sender.send(result.map_err(|error| error.to_string()));
        });

        producer.join().unwrap().unwrap();
        let error = finished_receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("windowed reader remained blocked on an unwritten future FIFO")
            .unwrap_err();
        run.join().unwrap();
        assert!(error.contains("page 1 failed"));
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn streamed_reconciliation_uses_existing_evidence_without_reopening_inputs() {
        let dir = PathBuf::from(format!("/tmp/evb-scan-reconcile-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Reconciliation must use the page evidence already in memory. An
        // existing directory passes the cache's path metadata check but
        // cannot be decoded as a raster, proving the invariant without a Unix
        // socket (creation of which restricted macOS runners may deny).
        let input = dir.join("already-consumed-input");
        fs::create_dir(&input).unwrap();
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            pages: (0..4)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let result = |index: usize, verdict, confidence: f64| PageRunResult {
            outputs: Vec::new(),
            metadata: PageResultMetadata {
                source_page_index: index,
                layout_classification: verdict,
                layout_confidence: confidence,
                cutter_x_px: (verdict == LayoutClassification::TwoPageSpread).then_some(120.0),
                split_seam: None,
                rotation_degrees: OrthogonalRotation::None,
                canvas_scope: CanvasScope::default(),
                excluded: false,
                blank_outputs_skipped: 0,
                output_count: usize::from(verdict == LayoutClassification::TwoPageSpread) + 1,
                outputs: Vec::new(),
                tier1_verdict: verdict,
                reconciled: false,
                cluster_agreement: 0.0,
                split_diagnostics: crate::split::SplitDiagnostics::default(),
                document_prior: None,
                text_axis: None,
                recommended_output_mode: None,
                recommended_output_mode_confidence: None,
                recommended_output_mode_reason: None,
                soft_alpha_foreground_recommendation: None,
                output_mode_diagnostics: None,
                rotated_width: 240,
                rotated_height: 200,
                candidate_cutter_ratio: Some(0.5),
                whitespace_score: 0.9,
                reconciliation_eligible: true,
                tier1_confidence: confidence,
                calibration_stroke_width_px: None,
                calibration_x_height_px: None,
            },
            page_metadata_path: dir.join(format!("page-{index}.json")),
            timings: PageStageTimings::default(),
        };
        let mut results = vec![
            result(0, LayoutClassification::TwoPageSpread, 0.92),
            result(1, LayoutClassification::TwoPageSpread, 0.91),
            result(2, LayoutClassification::TwoPageSpread, 0.90),
            result(3, LayoutClassification::SingleUncutPage, 0.40),
        ];

        reconcile_classification_batch(&manifest, &mut results, &manifest_cache(None)).unwrap();

        assert_eq!(
            results[3].metadata.layout_classification,
            LayoutClassification::TwoPageSpread
        );
        assert!(results[3].metadata.reconciled);
        assert!(results[3].metadata.document_prior.is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn color_peak_estimate_accounts_for_rgb_working_copies() {
        assert_eq!(
            estimate_peak_page_bytes(100, 50, Operation::Render, OutputMode::Bw),
            200_000
        );
        assert_eq!(
            estimate_peak_page_bytes(100, 50, Operation::Render, OutputMode::Color),
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
            split_diagnostics: crate::split::SplitDiagnostics::default(),
            document_prior: None,
            text_axis: None,
            recommended_output_mode: None,
            recommended_output_mode_confidence: None,
            recommended_output_mode_reason: None,
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
            rotated_width: 240,
            rotated_height: 200,
            candidate_cutter_ratio: Some(0.505),
            whitespace_score: 0.8,
            reconciliation_eligible: true,
            tier1_confidence: 0.0,
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
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
            stroke_width_median_px: None,
            x_height_median_px: None,
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
