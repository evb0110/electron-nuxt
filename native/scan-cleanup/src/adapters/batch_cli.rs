use crate::adapters::manifest_publication::run_manifest_transaction;
use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::engine::batch_reconciliation::reconcile_classification_batch;
use crate::engine::output_geometry::{
    align_deferred_spread_vertical_placements, apply_canvas_metadata,
    plan_canvas_placement_with_shared_fit, shared_spread_overflow_fits_for_written_outputs,
    validate_canvas_for_options, DeferredSpreadVerticalPlacement, WrittenOutput,
};
use crate::engine::page_statistics::{
    derive_page_ink_contexts, run_classification, run_page, EnginePageTimings, PageRunResult,
};
use crate::engine::resource_planning::{manifest_cache, page_cache_for, run_page_jobs};
use crate::engine::staged_input::{
    assert_manifest_paths_within_root, preflight_manifest_paths, with_announced_staged_page_input,
    LeaseEvent,
};
#[cfg(test)]
use crate::io::raster;
use crate::{
    pipeline::CleanupMetadata,
    protocol::{
        manifest_v3::{AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, RenderMode},
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

fn protocol_timings(timings: EnginePageTimings) -> PageStageTimings {
    PageStageTimings {
        decode_ms: timings.decode_ms,
        analysis_level_ms: timings.analysis_level_ms,
        normalization_ms: timings.normalization_ms,
        illumination_preparation_ms: timings.illumination_preparation_ms,
        layout_normalization_ms: timings.layout_normalization_ms,
        calibration_ms: timings.calibration_ms,
        picture_mask_ms: timings.picture_mask_ms,
        mode_recommendation_ms: timings.mode_recommendation_ms,
        quality_normalization_ms: timings.quality_normalization_ms,
        text_axis_ms: timings.text_axis_ms,
        split_ms: timings.split_ms,
        deskew_ms: timings.deskew_ms,
        content_ms: timings.content_ms,
        rasterization_ms: timings.rasterization_ms,
        mask_rasterization_ms: timings.mask_rasterization_ms,
        binarization_ms: timings.binarization_ms,
        threshold_preparation_ms: timings.threshold_preparation_ms,
        thresholding_ms: timings.thresholding_ms,
        binary_postprocess_ms: timings.binary_postprocess_ms,
        mixed_composition_ms: timings.mixed_composition_ms,
        output_processing_ms: timings.output_processing_ms,
        render_ms: timings.render_ms,
        write_ms: timings.write_ms,
    }
}

fn match_page_sizes(
    outputs: &[&WrittenOutput],
    document_canvas: Option<crate::protocol::manifest_v3::DocumentCanvas>,
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
    let Some(canvas) = document_canvas else {
        return Err(NativeError::new(
            NativeErrorCode::InvalidRequest,
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
            validate_canvas_for_options(target_width, target_height, &output.options)?;
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            metadata.intrinsic_raster_width.get_or_insert(output.width);
            metadata
                .intrinsic_raster_height
                .get_or_insert(output.height);
            apply_canvas_metadata(&mut metadata, placement, &canvas);
            write_json_atomic(&output.metadata_path, &metadata)?;
            Ok(())
        })();
        if let Err(error) = repad_result {
            let _ = fs::remove_file(&output.output_path);
            let _ = fs::remove_file(&output.metadata_path);
            if let Some(path) = &output.bilevel_output_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &output.background_output_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &output.foreground_mask_output_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &output.foreground_alpha_output_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &output.picture_mask_output_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &output.tone_preservation_alpha_output_path {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
    }
    Ok(())
}

const MAX_MANIFEST_BYTES: usize = 256 * 1024 * 1024;

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
    let publication = CliPagePublication;
    run_page(
        &page,
        CanvasScope::Page,
        false,
        None,
        Some((&output, &metadata)),
        None,
        &page_cache,
        &publication,
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
    let announce_lease = |event: LeaseEvent, page_number: usize, total: usize| {
        let stage = match event {
            LeaseEvent::Required => ProgressStage::PageInputRequired,
            LeaseEvent::Released => ProgressStage::PageInputReleased,
        };
        write_progress(Progress::page_input(stage, page_number, total)).map_err(|error| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("Unable to publish scan-cleanup staged input lease: {error}"),
            )
        })
    };
    let analyzing = manifest.operation == Operation::Analyze;
    let page_ink_contexts = if analyzing {
        vec![None; manifest.pages.len()]
    } else {
        derive_page_ink_contexts(manifest)?
    };
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let run_analysis = |(index, page): (usize, &Page)| -> Result<PageRunResult, NativeError> {
        let result = with_announced_staged_page_input(manifest, page, &announce_lease, || {
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
        let publication = CliPagePublication;
        let result = run_page(
            page,
            manifest.canvas_scope,
            manifest.render_mode == RenderMode::Final,
            manifest.document_canvas,
            None,
            page_ink_contexts[index],
            &page_cache,
            &publication,
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
        reconcile_classification_batch(manifest, &mut page_results, &cache, &announce_lease)?;
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
    let stage_timings = protocol_timings(result.timings);
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
        stage_timings: (!stage_timings.is_empty()).then_some(stage_timings),
        recommended_output_mode: metadata.recommended_output_mode,
        recommended_output_mode_confidence: metadata.recommended_output_mode_confidence,
        recommended_output_mode_reason: metadata.recommended_output_mode_reason,
        soft_alpha_foreground_recommendation: metadata.soft_alpha_foreground_recommendation,
        output_mode_diagnostics: metadata.output_mode_diagnostics,
    }
}

pub(crate) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::io::write_atomic(path, &bytes).map_err(|error| std::io::Error::other(error).into())
}

struct CliPagePublication;

impl crate::engine::page_statistics::PagePublication for CliPagePublication {
    fn write_metadata(
        &self,
        path: &Path,
        metadata: &CleanupMetadata,
    ) -> Result<(), Box<dyn Error>> {
        write_json_atomic(path, metadata)
    }

    fn remove_file(&self, path: &Path) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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
        ScanCleanupCliInvocation,
    };
    use crate::engine::page_statistics::write_gray_layer_background;
    use crate::io::raster::RasterReadError;
    use evb_native_support::NativeErrorCode;
    use scan_primitives::GrayImage;
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
}
