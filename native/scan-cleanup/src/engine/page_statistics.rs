//! Robust page-level statistics used by reconciliation.
use crate::adapters::batch_cli::*;
use crate::adapters::single_ocr_cli::invalid;
use crate::cache::{PageCache, StageCacheKey};
use crate::engine::output_geometry::*;
use crate::engine::render::*;
use crate::ink_consistency::PageInkConsistencyContext;
use crate::io::{pbm, raster};
use crate::pipeline::CleanupMetadata;
use crate::png;
use crate::protocol::manifest_v3::{CanvasScope, DocumentCanvas, Page};
use crate::protocol::progress::PageStageTimings;
use crate::split::LayoutClassification;
use crate::{CleanupOptions, OrthogonalRotation, OutputMode};
use evb_native_support::{bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode};
use scan_primitives::{BinaryImage, GrayImage, RgbImage};
use std::error::Error;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const MAX_DETAIL_METADATA_BYTES: usize = 16 * 1024 * 1024;
const SOFT_FOREGROUND_MAX_DPI: f64 = 300.0;

pub(crate) fn dimensions_within_tolerance(left: usize, right: usize) -> bool {
    left.abs_diff(right) as f64 / left.max(right).max(1) as f64 <= 0.02
}
pub(crate) fn classification_bucket(classification: LayoutClassification) -> usize {
    match classification {
        LayoutClassification::SingleUncutPage => 0,
        LayoutClassification::PageWithOffcut => 1,
        LayoutClassification::TwoPageSpread => 2,
    }
}
pub(crate) fn bucket_classification(bucket: usize) -> LayoutClassification {
    match bucket {
        0 => LayoutClassification::SingleUncutPage,
        1 => LayoutClassification::PageWithOffcut,
        _ => LayoutClassification::TwoPageSpread,
    }
}
/// Returns the median of an ascending-sorted slice.
pub(crate) fn median(values: &[f64]) -> Option<f64> {
    match values.len() {
        0 => None,
        length if length % 2 == 1 => Some(values[length / 2]),
        length => Some((values[length / 2 - 1] + values[length / 2]) * 0.5),
    }
}
pub(crate) fn robust_typographic_median(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut values = values
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if values.len() < 3 {
        return None;
    }
    values.sort_by(f64::total_cmp);
    median(&values)
}
pub(crate) fn ramp_local(value: f64, low: f64, high: f64) -> f64 {
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}
type DecodedPageInputs = (Option<Arc<raster::DecodedRaster>>, Option<Arc<GrayImage>>);
pub(crate) fn decode_page_inputs(
    page: &Page,
    options: &CleanupOptions,
    cache: &PageCache,
    retain_decoded: bool,
    decode_color: bool,
) -> Result<DecodedPageInputs, Box<dyn Error>> {
    let color_input = if decode_color {
        let key = StageCacheKey::decoded(&cache.source, true, options);
        let cached = retain_decoded
            .then(|| {
                cache
                    .shared
                    .lock()
                    .ok()
                    .and_then(|mut shared| shared.get::<raster::DecodedRaster>(&key))
            })
            .flatten();
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                raster::read_image(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(|error| {
                        map_raster_error(error, &page.input_path, page.source_page_index)
                    })?,
            );
            if retain_decoded {
                let bytes = decoded.gray.data().len().saturating_add(
                    decoded
                        .rgb
                        .width()
                        .saturating_mul(decoded.rgb.height())
                        .saturating_mul(3),
                );
                if let Ok(mut shared) = cache.shared.lock() {
                    shared.insert(key, Arc::clone(&decoded), bytes);
                }
            }
            decoded
        })
    } else {
        None
    };
    let gray_input = if color_input.is_none() {
        let key = StageCacheKey::decoded(&cache.source, false, options);
        let cached = retain_decoded
            .then(|| {
                cache
                    .shared
                    .lock()
                    .ok()
                    .and_then(|mut shared| shared.get::<GrayImage>(&key))
            })
            .flatten();
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(
                raster::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
                    .map_err(|error| {
                        map_raster_error(error, &page.input_path, page.source_page_index)
                    })?,
            );
            if retain_decoded {
                let bytes = decoded.data().len();
                if let Ok(mut shared) = cache.shared.lock() {
                    shared.insert(key, Arc::clone(&decoded), bytes);
                }
            }
            decoded
        })
    } else {
        None
    };
    Ok((color_input, gray_input))
}
pub(crate) fn run_page(
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
    // Render pages retain reusable analysis-stage artifacts, but decoded
    // source rasters are intentionally scoped to this invocation. Analyze's
    // classification path opts into decoded memoization below because its
    // document-prior reconciliation may replay a page.
    let decode_color = matches!(
        options.output_mode,
        OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
    );
    let (color_input, gray_input) = decode_page_inputs(page, &options, cache, false, decode_color)?;
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
                .map_err(|error| map_raster_error(error, path, page.source_page_index))
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
                .map_err(|error| map_raster_error(error, path, page.source_page_index))?;
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
                    .map_err(|error| map_raster_error(error, path, page.source_page_index))?;
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
        .map_err(|error| {
            map_raster_error(error, &detail_plan.base_raster_path, page.source_page_index)
        })?;
        let base_cleaned = detail_plan
            .base_cleaned_raster_path
            .as_ref()
            .map(|path| raster::read_image(path, options.max_pixels, options.max_dimension))
            .transpose()
            .map_err(|error| {
                map_raster_error(
                    error,
                    detail_plan
                        .base_cleaned_raster_path
                        .as_deref()
                        .expect("base cleaned path exists when decoding succeeds"),
                    page.source_page_index,
                )
            })?;
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
                let mut placement =
                    plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim(
                        output.image.width(),
                        output.image.height(),
                        paper_width,
                        paper_height,
                        output.metadata.content_box.is_some(),
                        &options,
                        output.metadata.half,
                        &canvas,
                        PLACEMENT_CENTERING_BOUNDS_X,
                        shared_spread_overflow_plan
                            .as_ref()
                            .map(|plan| plan.shared_fit),
                        fold_trim,
                        placement_near_paper_edge_runs_for_output(output),
                    );
                placement.optical_content_bounds_x = optical_content_bounds_x;
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
pub(crate) fn run_classification(
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
    let (color_input, gray_input) =
        decode_page_inputs(page, &options, cache, true, recommend_output_mode)?;
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

pub(crate) fn layered_foreground_dpi(options: &CleanupOptions) -> f64 {
    options
        .source_dpi()
        .min(options.dpi)
        .min(SOFT_FOREGROUND_MAX_DPI)
}

pub(crate) fn normalize_trusted_foreground_selection(
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

pub(crate) fn write_layer_background(path: &Path, image: &RgbImage) -> Result<(), String> {
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
