use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::engine::render::{
    analyze_page_with_color_and_document_prior_cached, clean_detail_page_with_color,
    clean_page_with_color_and_document_prior_cached, downscale_rgb_to_dimensions, CleanupRaster,
    CleanupResult, DetailRenderSources, LayeredForegroundKind,
};
use crate::mode_select::{OutputModeDiagnostics, OutputModeRecommendationReason};
use crate::mrc::{derive_picture_zones, derive_tone_mask_excluding_foreground};
use crate::{
    cache::{ByteLru, PageCache, SourceFingerprint, StageCacheKey, DEFAULT_CACHE_BUDGET_BYTES},
    io::{
        copy_bounded_cancelable, pbm, raster, BoundedIoError, StagedFileBackup,
        MAX_STREAM_INPUT_BYTES,
    },
    pipeline::{AnalysisOutputMetadata, CleanupMetadata, MatchedCanvasPolicy, PdfImagePlacement},
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
use evb_native_support::{NativeError, NativeErrorCode, NativeErrorEnvelope};
use rayon::prelude::*;
use scan_primitives::{BinaryImage, GrayImage};
use serde::Serialize;
use std::{
    collections::HashSet,
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
// continuous-tone plate should remain coarse: raising it to the mask grid adds
// no detail and turns compact MRC scans into hundreds of megabytes of JPEGs.
const LAYERED_BACKGROUND_MAX_DPI: f64 = 200.0;
const SOFT_FOREGROUND_MAX_DPI: f64 = 300.0;

fn layered_background_dpi(options: &CleanupOptions) -> f64 {
    options
        .source_background_dpi()
        .min(options.dpi)
        .min(LAYERED_BACKGROUND_MAX_DPI)
}

fn layered_foreground_dpi(options: &CleanupOptions) -> f64 {
    options
        .source_dpi()
        .min(options.dpi)
        .min(SOFT_FOREGROUND_MAX_DPI)
}

fn box_downsample_gray(source: &GrayImage, factor: usize) -> GrayImage {
    let width = (source.width() / factor).max(1);
    let height = (source.height() / factor).max(1);
    let mut output = GrayImage::new(width, height, 0);
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0usize;
            let mut count = 0usize;
            for sy in y * factor..((y + 1) * factor).min(source.height()) {
                for sx in x * factor..((x + 1) * factor).min(source.width()) {
                    sum += usize::from(source.get(sx, sy));
                    count += 1;
                }
            }
            output.set(x, y, (sum / count.max(1)) as u8);
        }
    }
    output
}

fn box_downsample_rgb(source: &RgbImage, factor: usize) -> RgbImage {
    let width = (source.width() / factor).max(1);
    let height = (source.height() / factor).max(1);
    let mut output = RgbImage::new(width, height, [0; 3]);
    for y in 0..height {
        for x in 0..width {
            let mut sums = [0usize; 3];
            let mut count = 0usize;
            for sy in y * factor..((y + 1) * factor).min(source.height()) {
                for sx in x * factor..((x + 1) * factor).min(source.width()) {
                    let pixel = source.get(sx, sy);
                    for channel in 0..3 {
                        sums[channel] += usize::from(pixel[channel]);
                    }
                    count += 1;
                }
            }
            output.set(x, y, sums.map(|sum| (sum / count.max(1)) as u8));
        }
    }
    output
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
    /// Origin of the intrinsic crop within that paper. Matched-canvas
    /// placement must compose this with the paper's alignment; aligning the
    /// cropped raster itself moves every retained mark toward the page edge.
    crop_x: f64,
    crop_y: f64,
    content_detected: bool,
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
        &page_cache,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path) -> Result<(), Box<dyn Error>> {
    let bytes = fs::read(path)?;
    let manifest: ManifestV3 = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("Invalid v3 batch manifest: {error}")))?;
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
    let trusted_foreground_mask = page
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
            Ok(normalize_trusted_foreground_selection(
                &selection,
                input_gray,
            ))
        })
        .transpose()?;
    let mut background_factor = 1;
    let trusted_mrc_background = page
        .trusted_mrc_background_path
        .as_ref()
        .map(|path| {
            let mut background = raster::read_image(path, options.max_pixels, options.max_dimension)
                .map_err(map_image_error)?;
            let input_aspect = input_gray.width() as f64 / input_gray.height().max(1) as f64;
            let background_aspect =
                background.gray.width() as f64 / background.gray.height().max(1) as f64;
            if (input_aspect / background_aspect - 1.0).abs() > 0.02 {
                return Err(invalid(format!(
                    "Trusted MRC background aspect ratio does not match page input: {}x{} versus {}x{}",
                    background.gray.width(),
                    background.gray.height(),
                    input_gray.width(),
                    input_gray.height(),
                )));
            }
            // A genuine low-resolution MRC background layer is roughly one third of
            // the page resolution. A background authored at (near-)full resolution
            // still carries only the low-frequency layer semantically, but the tuned
            // mm-based tone thresholds assume the compact regime, so bring it there.
            background_factor = if background.gray.width().saturating_mul(2)
                > input_gray.width()
            {
                (background.gray.width() * 3 / input_gray.width().max(1)).clamp(2, 4)
            } else {
                1
            };
            if background_factor > 1 {
                background.gray = box_downsample_gray(&background.gray, background_factor);
                background.rgb = box_downsample_rgb(&background.rgb, background_factor);
            }
            Ok(background)
        })
        .transpose()?;
    let effective_background_dpi = options.source_background_dpi() / background_factor as f64;
    // A full-resolution background marks producer pages whose selection mask
    // is not a complete ink carrier. Keep the compatibility hint available to
    // late output-mode resolution. The renderer rebuilds the background while
    // retaining selected ink and raw-supported additions in the foreground.
    let mut options = options;
    options.trusted_selection_incomplete = background_factor > 1;
    let trusted_tone_mask = trusted_mrc_background
        .as_ref()
        .zip(trusted_foreground_mask.as_ref())
        .map(|(background, foreground)| {
            derive_tone_mask_excluding_foreground(
                &background.gray,
                effective_background_dpi,
                foreground,
            )
        });
    let trusted_tone_mask = trusted_tone_mask.map(|tone| {
        derive_picture_zones(
            &tone,
            &trusted_mrc_background
                .as_ref()
                .expect("zip guarantees background")
                .gray,
            effective_background_dpi,
        )
    });
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
            trusted_foreground_mask.as_ref(),
            trusted_tone_mask.as_ref(),
            trusted_mrc_background
                .as_ref()
                .map(|background| &background.gray),
            trusted_mrc_background
                .as_ref()
                .map(|background| &background.rgb),
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
    };
    let destinations = resolve_destinations(page, result.outputs.len(), fallback_destination)?;
    let mut written = Vec::with_capacity(result.outputs.len());
    let write_started = Instant::now();
    let publication_result = (|| -> Result<(), Box<dyn Error>> {
        for (output, destination) in result.outputs.iter_mut().zip(&destinations) {
            let layer_destinations_available = final_render
                && output.mixed_layers.as_ref().is_some_and(|layers| {
                    destination.background_output_path.is_some()
                        && if layers.foreground_alpha.is_some() {
                            destination.foreground_alpha_output_path.is_some()
                        } else {
                            destination.foreground_mask_output_path.is_some()
                        }
                });
            let matched_placement = if final_render && options.match_page_size && !options.ocr_mode
            {
                let mut canvas = document_canvas
                    .ok_or_else(|| invalid("Matched page size requires a documentCanvas plan"))?;
                // PDF page matching is a physical-points contract, not a
                // same-number-of-pixels contract. Reusing the document's
                // finest raster grid upscaled lower-DPI B&W/Mixed pages after
                // cleanup, adding no information while changing stroke
                // geometry and bloating masks. Each page keeps the DPI at
                // which it was actually cleaned.
                canvas = canvas.at_dpi(options.dpi);
                validate_canvas_for_options(canvas.width_px, canvas.height_px, &options)?;
                let placement = plan_canvas_placement_for(
                    output.image.width(),
                    output.image.height(),
                    output.metadata.crop_rect.x,
                    output.metadata.crop_rect.y,
                    output.metadata.source_region.width,
                    output.metadata.source_region.height,
                    output.metadata.content_box.is_some(),
                    &options,
                    output.metadata.half,
                    &canvas,
                );
                apply_canvas_metadata(&mut output.metadata, placement, &canvas);
                match_picture_mask_in_memory(output, placement, &canvas);
                match_tone_preservation_alpha_in_memory(output, placement, &canvas);
                if layer_destinations_available {
                    // Layered and bilevel publication still materializes the
                    // document canvas, so its intrinsic output is the placed
                    // content rectangle on that grid.
                    output.metadata.output_width = placement.content_width;
                    output.metadata.output_height = placement.content_height;
                    match_layers_in_memory(output, &options, placement, &canvas);
                } else {
                    match_primary_raster_in_memory(output, placement, &canvas);
                }
                Some((placement, canvas))
            } else {
                None
            };
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
                    let layer_result = (|| -> Result<(), String> {
                        let background_dpi = layered_background_dpi(&options);
                        let matched_background_width =
                            ((layers.foreground_mask.width() as f64 * background_dpi / options.dpi)
                                .round() as usize)
                                .max(1);
                        let matched_background_height = ((layers.foreground_mask.height() as f64
                            * background_dpi
                            / options.dpi)
                            .round()
                            as usize)
                            .max(1);
                        let background_is_already_matched = layers.background.width()
                            == matched_background_width
                            && layers.background.height() == matched_background_height;
                        let background_width = if background_is_already_matched {
                            matched_background_width
                        } else {
                            ((layers.background.width() as f64 * background_dpi / options.dpi)
                                .round() as usize)
                                .max(1)
                        };
                        let background_height = if background_is_already_matched {
                            matched_background_height
                        } else {
                            ((layers.background.height() as f64 * background_dpi / options.dpi)
                                .round() as usize)
                                .max(1)
                        };
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
                        if layers.source_mrc {
                            return Err(Box::new(invalid(format!(
                                "Source MRC layers could not be published safely: {error}"
                            ))));
                        }
                        restore_mixed_composite_from_layers(output);
                        output.metadata.warnings.push(format!(
                            "Mixed layers were not written; the composite fallback was published instead: {error}"
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
                        output.metadata.layered_background_dpi =
                            Some(layered_background_dpi(&options));
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
                is_color: output.color_image.is_some(),
                half: output.metadata.half,
                width: output.image.width(),
                height: output.image.height(),
                paper_width: output.metadata.source_region.width,
                paper_height: output.metadata.source_region.height,
                crop_x: output.metadata.crop_rect.x,
                crop_y: output.metadata.crop_rect.y,
                content_detected: output.metadata.content_box.is_some(),
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
    /// Requested physical margin inset on the final canvas grid. The actual
    /// paper band can be larger when crop coordinates or alignment leave more
    /// whitespace, but content never crosses these edges.
    requested_margins: [usize; 4],
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
    plan_canvas_placement_for(
        output.width,
        output.height,
        output.crop_x,
        output.crop_y,
        output.paper_width,
        output.paper_height,
        output.content_detected,
        &output.options,
        output.half,
        canvas,
    )
}

// Kept as explicit scalar geometry at the test seam: grouping these values
// would hide which coordinate space each call supplies.
#[allow(clippy::too_many_arguments)]
fn plan_canvas_placement_for(
    width: usize,
    height: usize,
    crop_x: f64,
    crop_y: f64,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: crate::pipeline::PageHalf,
    canvas: &DocumentCanvas,
) -> CanvasPlacement {
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
    let mut render_scale = pixel_scale;
    let mut scaled_width = width as f64 * render_scale;
    let mut scaled_height = height as f64 * render_scale;
    let overflow = scaled_width > inner_width as f64 + CANVAS_GRID_TOLERANCE_PX
        || scaled_height > inner_height as f64 + CANVAS_GRID_TOLERANCE_PX;
    if overflow {
        let fit = (inner_width as f64 / scaled_width.max(1.0))
            .min(inner_height as f64 / scaled_height.max(1.0));
        render_scale *= fit;
        scaled_width *= fit;
        scaled_height *= fit;
    }
    let content_width = (scaled_width.round() as usize).clamp(1, inner_width);
    let content_height = (scaled_height.round() as usize).clamp(1, inner_height);
    let aligned_paper_width = (paper_width * render_scale).round() as usize;
    let aligned_paper_height = (paper_height * render_scale).round() as usize;
    let (paper_left, paper_top) = options.placement_for(half).offset(
        canvas.width_px.saturating_sub(aligned_paper_width),
        canvas.height_px.saturating_sub(aligned_paper_height),
    );
    // Cropping selects a rectangle from the aligned paper; it does not give
    // that rectangle a new page origin. Compose the crop offset after paper
    // alignment so crop-on and crop-off retain identical page coordinates.
    // A requested margin can move the crop origin above or to the left of the
    // source paper. Preserve that signed offset: clamping the crop before it
    // is composed shifts the paper by the synthetic margin whenever the
    // selected alignment leaves slack on the canvas. Round the completed sum
    // once so negative and positive crop origins follow the same grid rule.
    let left = ((paper_left as f64) + crop_x * render_scale).round().clamp(
        margin_left as f64,
        canvas
            .width_px
            .saturating_sub(margin_right.saturating_add(content_width)) as f64,
    ) as usize;
    let top = ((paper_top as f64) + crop_y * render_scale).round().clamp(
        margin_top as f64,
        canvas
            .height_px
            .saturating_sub(margin_bottom.saturating_add(content_height)) as f64,
    ) as usize;
    CanvasPlacement {
        content_width,
        content_height,
        left,
        top,
        requested_margins,
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
        ..
    } = placement;
    metadata.soft_margins_pixels = [
        left,
        top,
        canvas.width_px - content_width - left,
        canvas.height_px - content_height - top,
    ];
    metadata.applied_margins = requested_margins.map(|margin| margin as f64).into();
    metadata.uniform_canvas = true;
    metadata.canvas_policy = MatchedCanvasPolicy::StrictMaximum;
    metadata.canvas_overflow = placement.overflow;
    metadata.matched_canvas_target_width = Some(canvas.width_px);
    metadata.matched_canvas_target_height = Some(canvas.height_px);
    metadata.matched_canvas_target_width_points = Some(canvas.width_points);
    metadata.matched_canvas_target_height_points = Some(canvas.height_points);
    metadata.matched_canvas_content_width = Some(content_width);
    metadata.matched_canvas_content_height = Some(content_height);
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
    output.image = match &output.image {
        CleanupRaster::Gray(image) => {
            output.metadata.pdf_image_placement = pdf_image_placement(placement, canvas);
            CleanupRaster::Gray(image.clone())
        }
        CleanupRaster::Bilevel(image) => {
            output.metadata.output_width = placement.content_width;
            output.metadata.output_height = placement.content_height;
            let gray = CleanupRaster::Bilevel(image.clone()).into_gray();
            let canvas_image = place_on_white_canvas(
                &resample_bilevel(&gray, placement.content_width, placement.content_height),
                canvas.width_px,
                canvas.height_px,
                placement.left,
                placement.top,
            );
            CleanupRaster::Bilevel(BinaryImage::from_fn_parallel(
                canvas.width_px,
                canvas.height_px,
                |x, y| canvas_image.get(x, y) < 128,
            ))
        }
    };
    if let Some(color) = output.color_image.as_ref() {
        output.metadata.pdf_image_placement = pdf_image_placement(placement, canvas);
        output.color_image = Some(color.clone());
    }
}

fn pdf_image_placement(
    placement: CanvasPlacement,
    canvas: &DocumentCanvas,
) -> Option<PdfImagePlacement> {
    if placement.content_width == canvas.width_px
        && placement.content_height == canvas.height_px
        && placement.left == 0
        && placement.top == 0
    {
        return None;
    }
    let point_scale_x = canvas.width_points / canvas.width_px as f64;
    let point_scale_y = canvas.height_points / canvas.height_px as f64;
    Some(PdfImagePlacement {
        x_points: placement.left as f64 * point_scale_x,
        y_points: canvas.height_points
            - (placement.top + placement.content_height) as f64 * point_scale_y,
        width_points: placement.content_width as f64 * point_scale_x,
        height_points: placement.content_height as f64 * point_scale_y,
    })
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
    let placed = place_on_white_canvas(
        &resample_bilevel(&gray, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.left,
        placement.top,
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
    let placed = place_on_gray_canvas(
        &tone_preservation_alpha
            .resample_to_dimensions(placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.left,
        placement.top,
        0,
    );
    output.tone_preservation_alpha = Some(placed);
}

fn restore_mixed_composite_from_layers(output: &mut CleanupResult) {
    let Some(layers) = output.mixed_layers.as_ref() else {
        return;
    };
    let mask = &layers.foreground_mask;
    let mut image = layers
        .background
        .resample_to_dimensions(mask.width(), mask.height());
    let alpha = layers
        .foreground_alpha
        .as_ref()
        .map(|alpha| alpha.resample_to_dimensions(mask.width(), mask.height()));
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
        let mut color = background.resample_to_dimensions(mask.width(), mask.height());
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
    let Some(layers) = output.mixed_layers.as_mut() else {
        return;
    };
    let foreground_gray = CleanupRaster::Bilevel(layers.foreground_mask.clone()).into_gray();
    let foreground = place_on_white_canvas(
        &resample_bilevel(
            &foreground_gray,
            placement.content_width,
            placement.content_height,
        ),
        canvas.width_px,
        canvas.height_px,
        placement.left,
        placement.top,
    );
    layers.foreground_mask =
        BinaryImage::from_fn_parallel(canvas.width_px, canvas.height_px, |x, y| {
            foreground.get(x, y) < 128
        });
    if let Some(alpha) = layers.foreground_alpha.as_ref() {
        layers.foreground_alpha = Some(place_on_gray_canvas(
            &alpha.resample_to_dimensions(placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
            0,
        ));
    }
    let background_dpi = layered_background_dpi(options);
    // The matched canvas is intentionally the high-resolution bilevel grid.
    // Deriving the JPEG plate from `background_dpi / options.dpi` therefore
    // upscaled it whenever the document canvas used a finer B&W DPI than the
    // source page. Derive the plate from physical PDF points and map placement
    // proportionally between the two grids instead.
    let background_canvas = canvas.at_dpi(background_dpi);
    let background_width = background_canvas.width_px;
    let background_height = background_canvas.height_px;
    let scale_x = background_width as f64 / canvas.width_px.max(1) as f64;
    let scale_y = background_height as f64 / canvas.height_px.max(1) as f64;
    let content_width = ((placement.content_width as f64 * scale_x).round() as usize)
        .max(1)
        .min(background_width);
    let content_height = ((placement.content_height as f64 * scale_y).round() as usize)
        .max(1)
        .min(background_height);
    let left =
        ((placement.left as f64 * scale_x).round() as usize).min(background_width - content_width);
    let top =
        ((placement.top as f64 * scale_y).round() as usize).min(background_height - content_height);
    layers.background = place_on_white_canvas(
        &layers
            .background
            .resample_to_dimensions(content_width, content_height),
        background_width,
        background_height,
        left,
        top,
    );
    if let Some(color) = layers.color_background.as_ref() {
        layers.color_background = Some(place_rgb_on_white_canvas(
            &color.resample_to_dimensions(content_width, content_height),
            background_width,
            background_height,
            left,
            top,
        ));
    }
}

fn match_page_sizes(
    outputs: &[&WrittenOutput],
    preview_mode: bool,
    document_canvas: Option<DocumentCanvas>,
) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
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
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            apply_canvas_metadata(&mut metadata, placement, &canvas);

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
                    if metadata.layered_foreground_kind == Some(LayeredForegroundKind::SoftAlpha) {
                        let alpha_path =
                            output.foreground_alpha_output_path.as_ref().ok_or_else(|| {
                                invalid(
                                    "Soft layered cleanup metadata is missing its alpha destination",
                                )
                            })?;
                        let alpha = raster::read_gray(
                            alpha_path,
                            output.options.max_pixels,
                            output.options.max_dimension,
                        )
                        .map_err(map_image_error)?;
                        let alpha = place_on_gray_canvas(
                            &alpha.resample_to_dimensions(content_width, content_height),
                            target_width,
                            target_height,
                            left,
                            top,
                            0,
                        );
                        write_gray_layer_background(alpha_path, &alpha)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    } else {
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
                    }

                    // The background carries the same page at a coarser grid,
                    // so it is normalized on its own grid rather than on the
                    // mask's: the pair keeps the ratio the assembler expects.
                    let background_dpi = metadata
                        .layered_background_dpi
                        .unwrap_or_else(|| layered_background_dpi(&output.options));
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

fn place_on_white_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> GrayImage {
    place_on_gray_canvas(source, width, height, left, top, 255)
}

fn place_on_gray_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    fill: u8,
) -> GrayImage {
    let mut canvas = GrayImage::new(width, height, fill);
    canvas
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y.checked_sub(top).filter(|&y| y < source.height()) {
                row[left..left + source.width()].copy_from_slice(source.row(source_y));
            }
        });
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
    canvas
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y.checked_sub(top).filter(|&y| y < source.height()) {
                let start = left * 3;
                row[start..start + source.width() * 3].copy_from_slice(source.row(source_y));
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
        adaptive_thread_count, box_downsample_gray, estimate_peak_page_bytes, manifest_cache,
        manifest_worker_threads, map_image_error, materialize_stream_page,
        normalize_trusted_foreground_selection, page_worker_threads, parse_cli_args,
        place_on_white_canvas, plan_canvas_placement_for, preflight_manifest_paths,
        preserve_tier1_provenance_after_rerun, reconcile_classification_batch,
        robust_quantile_dimension, run_manifest_transaction, run_stream_page_jobs,
        PageResultMetadata, PageRunResult, ScanCleanupCliInvocation, Tier1Provenance,
        FALLBACK_SYSTEM_MEMORY_BYTES,
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
    fn box_downsample_gray_uses_box_means() {
        let source =
            GrayImage::from_vec(6, 6, 6, (0..36).map(|value| value as u8).collect()).unwrap();

        assert_eq!(
            box_downsample_gray(&source, 3),
            GrayImage::from_vec(2, 2, 2, vec![7, 10, 25, 28]).unwrap(),
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
    fn matched_canvas_composes_crop_origin_after_paper_alignment() {
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
            60.0,
            90.0,
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
            0.0,
            0.0,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert_eq!((cropped.left, cropped.top), (60, 90));
        assert_eq!((uncropped.left, uncropped.top), (0, 0));
        assert_eq!(cropped.content_width, 580);
        assert_eq!(cropped.content_height, 820);
    }

    #[test]
    fn matched_canvas_preserves_paper_alignment_for_negative_crop_origins() {
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

        // The 800x1000 source paper is centered at x=100. The intrinsic crop
        // carries 50 px of synthetic paper to its left, so the crop itself
        // starts at x=50 and source-paper x=0 still lands at x=100.
        let placement = plan_canvas_placement_for(
            850,
            1_000,
            -50.0,
            0.0,
            800.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );
        assert_eq!(placement.left, 50);

        let mut intrinsic = GrayImage::new(850, 1_000, 255);
        intrinsic.set(50, 100, 0);
        let composed = place_on_white_canvas(
            &intrinsic,
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(100, 100), 0);
        assert_eq!(composed.get(150, 100), 255);
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
            0.0,
            0.0,
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
            0.0,
            0.0,
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
        // Unix-domain socket paths are limited to roughly one hundred bytes
        // on macOS, while the per-user temporary directory is much longer.
        let dir = PathBuf::from(format!("/tmp/evb-scan-reconcile-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("one-shot-input.socket");
        let listener = std::os::unix::net::UnixListener::bind(&input).unwrap();
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
        drop(listener);
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
