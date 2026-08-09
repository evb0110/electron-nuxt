#[cfg(test)]
use crate::background::normalize_illumination;
pub use crate::domain::geometry::{AppliedMargins, PageHalf};
use crate::engine::prepare::{build_analysis_level, AnalysisLevel};
use crate::engine::render_plan::{
    content_result_for_dimensions, output_regions, ComposedRenderPlan,
};
use crate::engine::text_axis::{detect_text_axis, TextAxisHint};
use crate::mode_select::{
    independent_chroma_mask, is_blank_scan_candidate, is_line_art_picture,
    protect_bilevel_text_fidelity, recommend_output_mode_with_tone, should_veto_bilevel_fidelity,
    text_soft_edge_to_ink_ratio, OutputModeDiagnostics, OutputModeRecommendation,
    PreparedModeEvidence,
};
use crate::{
    auto_dewarp::detect_curves_at_dpi_with_depth,
    background::{
        normalize_illumination_for_layout_prepared, normalize_illumination_pair_with_masks,
        normalize_illumination_prepared_with_masks, normalize_illumination_rgb_with_masks,
        normalize_illumination_with_masks, normalize_region_with_reusable_model,
        normalize_rgb_region_with_reusable_model, prepare_illumination,
        reusable_illumination_model,
    },
    bw::{
        binarize_normalized_with_diagnostics, binarize_normalized_with_diagnostics_excluding,
        binary_to_gray, paper_reference, picture_protection_radius,
        postprocess_binary_with_diagnostics_and_raw, resolve_binarization_diagnostics,
        BinarizationDiagnostics, BLEED_CRISPNESS_FLOOR, BLEED_SHALLOW_DEPTH, RULE_RAW_DEPTH,
    },
    cache::{PageCache, StageCacheKey},
    calibration::{CalibrationConfig, PageCalibration},
    content::{analyze_content_evidence_calibrated, detect_content_and_margins_calibrated},
    deskew::{detect_skew, DeskewResult},
    dewarp::{
        rasterize_inverse_area_rgb_with, rasterize_inverse_area_with, DewarpModel, DEWARP_GRID_SIZE,
    },
    ink_consistency::{stabilize_trusted_stroke_mass, InkConsistencyDiagnostics},
    mrc::derive_halftone_zones,
    picture::{
        apply_manual_zones, detect_continuous_tone_mask, detect_picture_mask_with_continuous_tone,
        extend_picture_mask_for_content, extend_tone_mask_for_content,
        flat_graphic_tone_preservation_alpha, photo_tone_preservation_alpha,
        rectangularize_corroborated_photos, refine_line_art_preservation_alpha,
        refine_tone_preservation_alpha, resample_binary_mask_nearest,
        semantic_tone_preservation_alpha, veto_text_like_regions,
    },
    png::RgbImage,
    protocol::{
        manifest_v3::{ContentDiagnostics, DetailRenderPlan},
        progress::PageStageTimings,
    },
    split::{
        detect_split_at_analysis_level_with_threshold, DocumentPrior, LayoutClassification,
        ReconciliationMetadata, SplitDiagnostics, SplitResult, SPLIT_ANALYSIS_DPI,
    },
    text_tone::{
        apply_text_tone, apply_text_tone_excluding, derive_text_tone_diagnostics,
        outside_tonal_evidence_with_mask, OutsideTonalEvidence, TextToneDiagnostics,
    },
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, dilate_gray, erode, erode_gray},
    threshold::otsu_threshold,
    Affine, BinaryImage, ComponentMap, GrayImage, Point, Polygon, Rect,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{borrow::Cow, sync::Arc, time::Instant};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpMappingGrid {
    pub columns: usize,
    pub rows: usize,
    pub output_origin: Point,
    pub output_width: usize,
    pub output_height: usize,
    pub output_to_source: Vec<Point>,
    pub source_to_output: Vec<Point>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImagePlacement {
    pub x_points: f64,
    pub y_points: f64,
    pub width_points: f64,
    pub height_points: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupMetadata {
    pub source_page_index: usize,
    pub half: PageHalf,
    pub detected_skew_degrees: f64,
    pub skew_confidence: f64,
    pub skew_applied: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_skew: bool,
    pub layout_classification: LayoutClassification,
    pub layout_confidence: f64,
    #[serde(rename = "cutterXPx")]
    pub cutter_x: Option<f64>,
    pub split_geometry: Vec<Polygon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    #[serde(with = "pixel_rect_serde")]
    pub source_region: Rect,
    #[serde(with = "optional_pixel_rect_serde")]
    pub content_box: Option<Rect>,
    /// Applied crop in deskewed/dewarped page-region coordinates.
    #[serde(with = "pixel_rect_serde")]
    pub crop_rect: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_diagnostics: Option<ContentDiagnostics>,
    pub applied_margins: AppliedMargins,
    #[serde(rename = "softMarginsPx")]
    pub soft_margins_pixels: [usize; 4],
    pub uniform_canvas: bool,
    #[serde(default)]
    pub canvas_policy: MatchedCanvasPolicy,
    #[serde(default)]
    pub canvas_overflow: bool,
    #[serde(default, rename = "matchedCanvasTargetWidthPx")]
    pub matched_canvas_target_width: Option<usize>,
    #[serde(default, rename = "matchedCanvasTargetHeightPx")]
    pub matched_canvas_target_height: Option<usize>,
    #[serde(default, rename = "matchedCanvasTargetWidthPoints")]
    pub matched_canvas_target_width_points: Option<f64>,
    #[serde(default, rename = "matchedCanvasTargetHeightPoints")]
    pub matched_canvas_target_height_points: Option<f64>,
    /// Size the intrinsic raster takes on the matched canvas. A final run has
    /// already resampled its raster to it; a preview reports it so the renderer
    /// presents the page at the document's scale without a second render.
    #[serde(default, rename = "matchedCanvasContentWidthPx")]
    pub matched_canvas_content_width: Option<usize>,
    #[serde(default, rename = "matchedCanvasContentHeightPx")]
    pub matched_canvas_content_height: Option<usize>,
    /// Physical PDF rectangle for a source-grid continuous-tone raster. When
    /// absent, assemblers retain the legacy behavior of covering the MediaBox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_image_placement: Option<PdfImagePlacement>,
    pub output_mode: OutputMode,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bilevel_written: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub layered_written: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_foreground_kind: Option<LayeredForegroundKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_background_dpi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_foreground_dpi: Option<f64>,
    /// Compatibility field for the explicit lossless source path. Fresh
    /// raster cleanup never sets this bit, even when producer MRC layers are
    /// supplied as analysis hints.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted_mrc_background_preserved: bool,
    /// Compatibility field for legacy consumers. Fresh raster cleanup keeps
    /// producer selection masks as hints and never sets this bit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted_selection_applied: bool,
    #[serde(default)]
    pub illumination_normalized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_tone_diagnostics: Option<TextToneDiagnostics>,
    pub binarization_mode: Option<crate::BinarizationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binarization_diagnostics: Option<BinarizationDiagnostics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink_consistency_diagnostics: Option<InkConsistencyDiagnostics>,
    #[serde(default)]
    pub despeckle_fallback: bool,
    pub forward_transform: Option<Affine>,
    pub inverse_transform: Option<Affine>,
    pub dewarp_model: Option<crate::DewarpOptions>,
    pub dewarp_mapping: Option<DewarpMappingGrid>,
    pub dewarp_confidence: Option<f64>,
    #[serde(rename = "inputWidthPx")]
    pub input_width: usize,
    #[serde(rename = "inputHeightPx")]
    pub input_height: usize,
    /// Intrinsic, unpadded cleaned-raster width.
    #[serde(rename = "outputWidthPx")]
    pub output_width: usize,
    /// Intrinsic, unpadded cleaned-raster height.
    #[serde(rename = "outputHeightPx")]
    pub output_height: usize,
    /// Actual preview payload bounds inside the full intrinsic output.
    #[serde(
        default,
        rename = "renderRegion",
        skip_serializing_if = "Option::is_none",
        with = "optional_pixel_rect_serde"
    )]
    pub render_region: Option<Rect>,
    #[serde(rename = "canvasWidthPx")]
    pub canvas_width: usize,
    #[serde(rename = "canvasHeightPx")]
    pub canvas_height: usize,
    #[serde(rename = "placementOffsetXPx")]
    pub placement_offset_x: usize,
    #[serde(rename = "placementOffsetYPx")]
    pub placement_offset_y: usize,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
    #[serde(default)]
    pub canvas_scope: crate::protocol::manifest_v3::CanvasScope,
    pub resample_passes: usize,
    pub source_dpi: f64,
    pub render_dpi: f64,
    pub requested_render_dpi: f64,
    pub raster_scale_limited: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedCanvasPolicy {
    #[default]
    Intrinsic,
    StrictMaximum,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayeredForegroundKind {
    Stencil,
    SoftAlpha,
    SourceMrc,
}

pub struct CleanupResult {
    pub image: CleanupRaster,
    pub color_image: Option<RgbImage>,
    pub metadata: CleanupMetadata,
    pub(crate) picture_mask: Option<BinaryImage>,
    pub(crate) tone_preservation_alpha: Option<GrayImage>,
    pub(crate) mixed_layers: Option<MixedLayers>,
    effectively_blank: bool,
}

/// The rendered page, in whichever representation produced it. A binarized page
/// stays in the binarizer's packed bits all the way to the PBM writer, which is
/// the same MSB-first layout; only consumers that need 8-bit samples widen it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CleanupRaster {
    Gray(GrayImage),
    Bilevel(BinaryImage),
}

impl CleanupRaster {
    pub fn width(&self) -> usize {
        match self {
            Self::Gray(image) => image.width(),
            Self::Bilevel(image) => image.width(),
        }
    }

    pub fn height(&self) -> usize {
        match self {
            Self::Gray(image) => image.height(),
            Self::Bilevel(image) => image.height(),
        }
    }

    pub fn get(&self, x: usize, y: usize) -> u8 {
        match self {
            Self::Gray(image) => image.get(x, y),
            Self::Bilevel(image) => {
                if image.get(x, y) {
                    0
                } else {
                    255
                }
            }
        }
    }

    pub fn bilevel(&self) -> Option<&BinaryImage> {
        match self {
            Self::Gray(_) => None,
            Self::Bilevel(image) => Some(image),
        }
    }

    pub fn to_gray(&self) -> Cow<'_, GrayImage> {
        match self {
            Self::Gray(image) => Cow::Borrowed(image),
            Self::Bilevel(image) => Cow::Owned(binary_to_gray(image)),
        }
    }

    pub fn into_gray(self) -> GrayImage {
        match self {
            Self::Gray(image) => image,
            Self::Bilevel(image) => binary_to_gray(&image),
        }
    }

    fn cropped(&self, rect: Rect) -> Self {
        match self {
            Self::Gray(image) => Self::Gray(crop_gray(image, rect)),
            Self::Bilevel(image) => Self::Bilevel(crop_binary(image, rect)),
        }
    }
}

pub(crate) struct MixedLayers {
    pub foreground_mask: BinaryImage,
    /// Eight-bit foreground opacity for undersampled antialiased text.
    /// When present, this is the authoritative foreground and the bilevel
    /// mask is retained only as diagnostic/fallback evidence.
    pub foreground_alpha: Option<GrayImage>,
    pub background: GrayImage,
    pub color_background: Option<RgbImage>,
    /// The assembler may replace this fresh foreground with the extracted
    /// source JPX through its authored smask. It is set only for confirmed
    /// photos whose page geometry remains affine and source-aligned.
    pub source_mrc: bool,
}

pub struct PageCleanupResult {
    pub outputs: Vec<CleanupResult>,
    pub classification: LayoutClassification,
    pub layout_confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub blank_outputs_skipped: usize,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

pub(crate) struct DetailRenderSources<'a> {
    pub source_crop: &'a GrayImage,
    pub color_source_crop: Option<&'a RgbImage>,
    pub base_source: &'a GrayImage,
    pub base_color_source: Option<&'a RgbImage>,
    pub base_cleaned: Option<(&'a GrayImage, Option<&'a RgbImage>)>,
}

pub(crate) fn clean_detail_page_with_color(
    sources: DetailRenderSources<'_>,
    options: &CleanupOptions,
    source_page_index: usize,
    plan: &DetailRenderPlan,
    base_metadata: &CleanupMetadata,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, String> {
    let DetailRenderSources {
        source_crop,
        color_source_crop,
        base_source,
        base_color_source,
        base_cleaned,
    } = sources;
    options.validate()?;
    if options.output_mode == OutputMode::Mixed {
        return Err("Mixed-mode detail rendering requires the full-page picture mask".into());
    }
    if options.output_mode == OutputMode::Auto {
        return Err("Detail rendering requires an output mode resolved from the full page".into());
    }
    if !options.manual_zones.picture.is_empty() || !options.manual_zones.fill.is_empty() {
        return Err("Detail rendering with manual zones requires the full-page source".into());
    }
    let scale = plan.scale;
    let source_crop_rect = plan.source_crop.as_rect();
    let render_region = plan.render_region.as_rect();
    let sampled_region = plan.sampled_region.as_rect();
    if source_crop_rect.width.ceil() as usize != source_crop.width()
        || source_crop_rect.height.ceil() as usize != source_crop.height()
    {
        return Err("Detail source crop dimensions do not match its raster".into());
    }
    let canonical_replay = base_cleaned.filter(|_| {
        matches!(
            options.output_mode,
            OutputMode::Grayscale | OutputMode::Color
        )
    });
    let normalized_gray;
    let normalized_color;
    let processing_source = if canonical_replay.is_some() {
        normalized_color = color_source_crop.cloned();
        source_crop
    } else if options.normalize_illumination {
        let rotated_base = rotate_orthogonal(base_source, options.rotation);
        let model = reusable_illumination_model(&rotated_base);
        let coordinate = |x, y| {
            rotated_normalized_detail_coordinate(
                source_crop_rect.x + x as f64,
                source_crop_rect.y + y as f64,
                plan.full_source_width_px,
                plan.full_source_height_px,
                options.rotation,
            )
        };
        normalized_gray = normalize_region_with_reusable_model(source_crop, &model, coordinate);
        normalized_color = color_source_crop.map(|source| {
            normalize_rgb_region_with_reusable_model(source_crop, source, &model, coordinate)
        });
        &normalized_gray
    } else {
        normalized_color = color_source_crop.cloned();
        source_crop
    };
    let processing_color = normalized_color.as_ref();
    let sampled_width = sampled_region.width.ceil().max(1.0) as usize;
    let sampled_height = sampled_region.height.ceil().max(1.0) as usize;
    let map_output = |point: Point| {
        let target_output = Point::new(sampled_region.x + point.x, sampled_region.y + point.y);
        let base_output = Point::new(target_output.x / scale, target_output.y / scale);
        let rotated_source = if let Some(inverse) = base_metadata.inverse_transform {
            inverse.apply(base_output)
        } else if let Some(grid) = &base_metadata.dewarp_mapping {
            interpolate_dewarp_output_to_source(grid, base_output)?
        } else {
            return None;
        };
        let base_source = inverse_rotate_point(
            rotated_source,
            base_metadata.input_width,
            base_metadata.input_height,
            base_metadata.rotation,
        );
        let cropped = Point::new(
            base_source.x * scale - source_crop_rect.x,
            base_source.y * scale - source_crop_rect.y,
        );
        Some(cropped)
    };
    let mut mapped_gray =
        rasterize_inverse_area_with(processing_source, sampled_width, sampled_height, map_output);
    let mut mapped_color = processing_color.map(|source| {
        rasterize_inverse_area_rgb_with(source, sampled_width, sampled_height, map_output)
    });
    if let Some((base_cleaned_gray, base_cleaned_color)) = canonical_replay {
        replay_canonical_detail_transfer(
            &mut mapped_gray,
            mapped_color.as_mut(),
            base_source,
            base_color_source,
            base_cleaned_gray,
            base_cleaned_color,
            sampled_region,
            scale,
            base_metadata,
        );
    }

    // Geometry is replayed from the trusted base metadata above. Reuse the
    // ordinary cleanup pipeline for tonal normalization, binarization,
    // thickness, and despeckle so detail tiles cannot grow a second processing
    // implementation, but skip the layout analysis the replayed geometry
    // already answers.
    let mut tile_options = options.clone();
    tile_options.render_crop = None;
    tile_options.rotation = OrthogonalRotation::None;
    tile_options.layout = crate::LayoutMode::Single;
    tile_options.manual_split_x = None;
    tile_options.automatic_split = None;
    tile_options.manual_skew_degrees = Some(0.0);
    tile_options.manual_content_boxes = Default::default();
    tile_options.automatic_skew_degrees = Default::default();
    tile_options.automatic_content_boxes = Default::default();
    tile_options.manual_zones = Default::default();
    tile_options.normalize_illumination = false;
    tile_options.crop_content = false;
    tile_options.match_page_size = false;
    tile_options.margins_mm = None;
    tile_options.margins_pixels = None;
    tile_options.dewarp = None;
    tile_options.experimental = Default::default();
    // The detail tile applies the canonical full-page curve below. Leaving
    // reusable page-plan tone evidence here would apply the same LUT once in
    // the ordinary pipeline and then a second time after geometry replay.
    tile_options.resolved_text_tone_diagnostics = Default::default();
    tile_options.skip_blank_pages = false;
    let mut processed = clean_page_with_color_and_calibration_config(
        &mapped_gray,
        mapped_color.as_ref(),
        None,
        None,
        &tile_options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::DETAIL_TILE,
        timings,
    )?;
    let mut output = processed
        .outputs
        .pop()
        .ok_or("Detail processing produced no output")?;
    if canonical_replay.is_none() {
        if let (CleanupRaster::Gray(image), Some(diagnostics)) =
            (&mut output.image, base_metadata.text_tone_diagnostics)
        {
            apply_text_tone(image, diagnostics);
        }
    }
    let payload_rect = Rect::new(
        render_region.x - sampled_region.x,
        render_region.y - sampled_region.y,
        render_region.width,
        render_region.height,
    );
    output.image = output.image.cropped(payload_rect);
    output.color_image = output
        .color_image
        .map(|image| crop_rgb(&image, payload_rect));
    output.picture_mask = output
        .picture_mask
        .map(|mask| crop_binary(&mask, payload_rect));
    output.mixed_layers = output.mixed_layers.map(|layers| MixedLayers {
        foreground_mask: crop_binary(&layers.foreground_mask, payload_rect),
        foreground_alpha: layers
            .foreground_alpha
            .map(|alpha| crop_gray(&alpha, payload_rect)),
        background: crop_gray(&layers.background, payload_rect),
        color_background: layers
            .color_background
            .map(|image| crop_rgb(&image, payload_rect)),
        source_mrc: layers.source_mrc,
    });

    let mut metadata = scale_detail_metadata(base_metadata, scale);
    metadata.source_page_index = source_page_index;
    metadata.render_region = Some(render_region);
    metadata.input_width = plan.full_source_width_px;
    metadata.input_height = plan.full_source_height_px;
    metadata.output_mode = options.output_mode;
    metadata.binarization_mode = output.metadata.binarization_mode;
    metadata.binarization_diagnostics = output.metadata.binarization_diagnostics;
    metadata.despeckle_fallback = output.metadata.despeckle_fallback;
    metadata.illumination_normalized = base_metadata.illumination_normalized;
    metadata.source_dpi = options.source_dpi();
    metadata.render_dpi = options.dpi;
    metadata.requested_render_dpi = options.requested_render_dpi();
    metadata.raster_scale_limited = options.dpi + f64::EPSILON < options.requested_render_dpi();
    metadata.canvas_scope = crate::protocol::manifest_v3::CanvasScope::Page;
    metadata.warnings = output.metadata.warnings;
    output.metadata = metadata;
    output.effectively_blank = false;

    let classification = base_metadata.layout_classification;
    let split_seam = base_metadata.split_seam.as_ref().map(|seam| {
        let mut seam = seam.clone();
        for point in &mut seam.points {
            point.x *= scale;
            point.y *= scale;
        }
        seam
    });
    Ok(PageCleanupResult {
        outputs: vec![output],
        classification,
        layout_confidence: base_metadata.layout_confidence,
        cutter_x: base_metadata.cutter_x.map(|x| x * scale),
        split_seam,
        reconciliation: ReconciliationMetadata {
            tier1_verdict: classification,
            reconciled: false,
            cluster_agreement: 0.0,
        },
        split_diagnostics: SplitDiagnostics::default(),
        blank_outputs_skipped: 0,
        excluded: false,
        rotation: base_metadata.rotation,
        output_mode_recommendation: None,
    })
}

#[derive(Clone, Copy)]
struct CanonicalTransferTap {
    weight: f64,
    gray_gain: f64,
    color_gain: Option<[f64; 3]>,
}

/// Replays the completed base preview's actual source-to-cleaned transfer.
///
/// The base raster already contains every page-global decision: protected
/// picture/tone masks, paper calibration, cover policy, and the text-tone
/// curve. A detail tile therefore samples that transfer instead of refitting
/// those decisions on a viewport crop. Around a discontinuity, only taps from
/// the nearest tap's gain class contribute; this keeps a paper whitening gain
/// from bleeding into a protected photograph (and vice versa).
#[allow(clippy::too_many_arguments)]
fn replay_canonical_detail_transfer(
    detail_gray: &mut GrayImage,
    mut detail_color: Option<&mut RgbImage>,
    base_source: &GrayImage,
    base_color_source: Option<&RgbImage>,
    base_cleaned_gray: &GrayImage,
    base_cleaned_color: Option<&RgbImage>,
    sampled_region: Rect,
    scale: f64,
    base_metadata: &CleanupMetadata,
) {
    const GAIN_CLASS_TOLERANCE: f64 = 0.18;
    let width = detail_gray.width();
    let height = detail_gray.height();
    for y in 0..height {
        for x in 0..width {
            let base_output = Point::new(
                (sampled_region.x + x as f64) / scale,
                (sampled_region.y + y as f64) / scale,
            );
            let taps = canonical_transfer_taps(
                base_output,
                base_source,
                base_color_source,
                base_cleaned_gray,
                base_cleaned_color,
                base_metadata,
            );
            let reference = taps[0].map_or(1.0, |tap| tap.gray_gain);
            let mut gray_weight = 0.0;
            let mut gray_gain = 0.0;
            for tap in taps.into_iter().flatten() {
                if (tap.gray_gain - reference).abs() <= GAIN_CLASS_TOLERANCE {
                    gray_weight += tap.weight;
                    gray_gain += tap.weight * tap.gray_gain;
                }
            }
            let gray_gain = if gray_weight > f64::EPSILON {
                gray_gain / gray_weight
            } else {
                reference
            };
            detail_gray.set(
                x,
                y,
                (f64::from(detail_gray.get(x, y)) * gray_gain)
                    .round()
                    .clamp(0.0, 255.0) as u8,
            );

            let Some(color) = detail_color.as_deref_mut() else {
                continue;
            };
            let source_pixel = color.get(x, y);
            let reference_color = taps[0].and_then(|tap| tap.color_gain);
            let mut target = source_pixel;
            for channel in 0..3 {
                let reference_gain = reference_color.map_or(gray_gain, |gain| gain[channel]);
                let mut weight = 0.0;
                let mut gain = 0.0;
                for tap in taps.into_iter().flatten() {
                    let tap_gain = tap
                        .color_gain
                        .map_or(tap.gray_gain, |values| values[channel]);
                    if (tap_gain - reference_gain).abs() <= GAIN_CLASS_TOLERANCE {
                        weight += tap.weight;
                        gain += tap.weight * tap_gain;
                    }
                }
                let gain = if weight > f64::EPSILON {
                    gain / weight
                } else {
                    reference_gain
                };
                target[channel] = (f64::from(source_pixel[channel]) * gain)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
            color.set(x, y, target);
        }
    }
}

fn canonical_transfer_taps(
    base_output: Point,
    base_source: &GrayImage,
    base_color_source: Option<&RgbImage>,
    base_cleaned_gray: &GrayImage,
    base_cleaned_color: Option<&RgbImage>,
    base_metadata: &CleanupMetadata,
) -> [Option<CanonicalTransferTap>; 4] {
    let maximum_x = base_cleaned_gray.width().saturating_sub(1) as f64;
    let maximum_y = base_cleaned_gray.height().saturating_sub(1) as f64;
    let x = base_output.x.clamp(0.0, maximum_x);
    let y = base_output.y.clamp(0.0, maximum_y);
    let left = x.floor() as usize;
    let top = y.floor() as usize;
    let right = (left + 1).min(base_cleaned_gray.width().saturating_sub(1));
    let bottom = (top + 1).min(base_cleaned_gray.height().saturating_sub(1));
    let tx = x - left as f64;
    let ty = y - top as f64;
    let coordinates = [
        (left, top, (1.0 - tx) * (1.0 - ty)),
        (right, top, tx * (1.0 - ty)),
        (left, bottom, (1.0 - tx) * ty),
        (right, bottom, tx * ty),
    ];
    coordinates.map(|(output_x, output_y, weight)| {
        let source_point = base_output_to_unrotated_source(
            base_metadata,
            Point::new(output_x as f64, output_y as f64),
        )?;
        let source_gray =
            sample_bilinear_white(base_source, source_point.x + 0.5, source_point.y + 0.5);
        let cleaned_gray = base_cleaned_gray.get(output_x, output_y);
        let gray_gain = transfer_gain(source_gray, cleaned_gray);
        let color_gain = base_color_source
            .zip(base_cleaned_color)
            .map(|(source, cleaned)| {
                let source_pixel =
                    sample_bilinear_rgb_white(source, source_point.x + 0.5, source_point.y + 0.5);
                let cleaned_pixel = cleaned.get(
                    output_x.min(cleaned.width().saturating_sub(1)),
                    output_y.min(cleaned.height().saturating_sub(1)),
                );
                std::array::from_fn(|channel| {
                    transfer_gain(source_pixel[channel], cleaned_pixel[channel])
                })
            });
        Some(CanonicalTransferTap {
            weight,
            gray_gain,
            color_gain,
        })
    })
}

fn transfer_gain(source: u8, cleaned: u8) -> f64 {
    if source <= 4 {
        if cleaned <= 4 {
            1.0
        } else {
            f64::from(cleaned) / 4.0
        }
    } else {
        f64::from(cleaned) / f64::from(source)
    }
}

fn base_output_to_unrotated_source(metadata: &CleanupMetadata, output: Point) -> Option<Point> {
    let rotated_source = if let Some(inverse) = metadata.inverse_transform {
        inverse.apply(output)
    } else if let Some(grid) = &metadata.dewarp_mapping {
        interpolate_dewarp_output_to_source(grid, output)?
    } else {
        return None;
    };
    Some(inverse_rotate_point(
        rotated_source,
        metadata.input_width,
        metadata.input_height,
        metadata.rotation,
    ))
}

fn rotated_normalized_detail_coordinate(
    x: f64,
    y: f64,
    source_width: usize,
    source_height: usize,
    rotation: OrthogonalRotation,
) -> (f64, f64) {
    let (rotated_x, rotated_y, rotated_width, rotated_height) = match rotation {
        OrthogonalRotation::None => (x, y, source_width, source_height),
        OrthogonalRotation::Clockwise90 => (
            source_height as f64 - 1.0 - y,
            x,
            source_height,
            source_width,
        ),
        OrthogonalRotation::Clockwise180 => (
            source_width as f64 - 1.0 - x,
            source_height as f64 - 1.0 - y,
            source_width,
            source_height,
        ),
        OrthogonalRotation::Clockwise270 => (
            y,
            source_width as f64 - 1.0 - x,
            source_height,
            source_width,
        ),
    };
    (
        rotated_x / rotated_width.saturating_sub(1).max(1) as f64,
        rotated_y / rotated_height.saturating_sub(1).max(1) as f64,
    )
}

fn inverse_rotate_point(
    point: Point,
    source_width: usize,
    source_height: usize,
    rotation: OrthogonalRotation,
) -> Point {
    // Pixel-index convention: a W x H image occupies indices 0..W-1, 0..H-1,
    // matching the forward transform above; "W - x" instead of "W-1 - x"
    // shifts every rotated detail tile by one pixel and clips the far edge.
    match rotation {
        OrthogonalRotation::None => point,
        OrthogonalRotation::Clockwise90 => {
            Point::new(point.y, source_height as f64 - 1.0 - point.x)
        }
        OrthogonalRotation::Clockwise180 => Point::new(
            source_width as f64 - 1.0 - point.x,
            source_height as f64 - 1.0 - point.y,
        ),
        OrthogonalRotation::Clockwise270 => {
            Point::new(source_width as f64 - 1.0 - point.y, point.x)
        }
    }
}

fn interpolate_dewarp_output_to_source(grid: &DewarpMappingGrid, output: Point) -> Option<Point> {
    if grid.columns < 2 || grid.rows < 2 || grid.output_width == 0 || grid.output_height == 0 {
        return None;
    }
    let grid_x = (output.x / grid.output_width as f64 * (grid.columns - 1) as f64)
        .clamp(0.0, (grid.columns - 1) as f64);
    let grid_y = (output.y / grid.output_height as f64 * (grid.rows - 1) as f64)
        .clamp(0.0, (grid.rows - 1) as f64);
    let left = grid_x.floor() as usize;
    let top = grid_y.floor() as usize;
    let right = (left + 1).min(grid.columns - 1);
    let bottom = (top + 1).min(grid.rows - 1);
    let tx = grid_x - left as f64;
    let ty = grid_y - top as f64;
    let at = |column: usize, row: usize| {
        grid.output_to_source
            .get(row * grid.columns + column)
            .copied()
    };
    let top_left = at(left, top)?;
    let top_right = at(right, top)?;
    let bottom_left = at(left, bottom)?;
    let bottom_right = at(right, bottom)?;
    Some(Point::new(
        (top_left.x * (1.0 - tx) + top_right.x * tx) * (1.0 - ty)
            + (bottom_left.x * (1.0 - tx) + bottom_right.x * tx) * ty,
        (top_left.y * (1.0 - tx) + top_right.y * tx) * (1.0 - ty)
            + (bottom_left.y * (1.0 - tx) + bottom_right.y * tx) * ty,
    ))
}

fn scale_detail_metadata(base: &CleanupMetadata, scale: f64) -> CleanupMetadata {
    let mut metadata = base.clone();
    let scale_rect = |rect: Rect| {
        Rect::new(
            rect.x * scale,
            rect.y * scale,
            rect.width * scale,
            rect.height * scale,
        )
    };
    metadata.source_region = scale_rect(metadata.source_region);
    metadata.content_box = metadata.content_box.map(scale_rect);
    metadata.crop_rect = scale_rect(metadata.crop_rect);
    metadata.applied_margins.left_px *= scale;
    metadata.applied_margins.top_px *= scale;
    metadata.applied_margins.right_px *= scale;
    metadata.applied_margins.bottom_px *= scale;
    metadata.soft_margins_pixels = metadata
        .soft_margins_pixels
        .map(|value| (value as f64 * scale).round() as usize);
    for transform in [
        metadata.forward_transform.as_mut(),
        metadata.inverse_transform.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        transform.matrix[0][2] *= scale;
        transform.matrix[1][2] *= scale;
    }
    if let Some(mapping) = &mut metadata.dewarp_mapping {
        mapping.output_origin.x *= scale;
        mapping.output_origin.y *= scale;
        mapping.output_width = (mapping.output_width as f64 * scale).round().max(1.0) as usize;
        mapping.output_height = (mapping.output_height as f64 * scale).round().max(1.0) as usize;
        for point in mapping
            .output_to_source
            .iter_mut()
            .chain(&mut mapping.source_to_output)
        {
            point.x *= scale;
            point.y *= scale;
        }
    }
    metadata.output_width = (metadata.output_width as f64 * scale).round().max(1.0) as usize;
    metadata.output_height = (metadata.output_height as f64 * scale).round().max(1.0) as usize;
    metadata.canvas_width = metadata.output_width;
    metadata.canvas_height = metadata.output_height;
    metadata.placement_offset_x = 0;
    metadata.placement_offset_y = 0;
    metadata.matched_canvas_target_width = None;
    metadata.matched_canvas_target_height = None;
    metadata.matched_canvas_target_width_points = None;
    metadata.matched_canvas_target_height_points = None;
    metadata.matched_canvas_content_width = None;
    metadata.matched_canvas_content_height = None;
    metadata.canvas_policy = MatchedCanvasPolicy::Intrinsic;
    metadata.canvas_overflow = false;
    metadata
}

pub struct PageClassificationResult {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub rotated_width: usize,
    pub rotated_height: usize,
    pub candidate_cutter_ratio: Option<f64>,
    pub whitespace_score: f64,
    pub text_axis: Option<TextAxisHint>,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOutputMetadata {
    pub half: PageHalf,
    #[serde(with = "pixel_rect_serde")]
    pub source_region: Rect,
    #[serde(with = "optional_pixel_rect_serde")]
    pub content_box: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_diagnostics: Option<ContentDiagnostics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_tone_diagnostics: Option<TextToneDiagnostics>,
    #[serde(with = "pixel_rect_serde")]
    pub crop_rect: Rect,
    pub applied_margins: AppliedMargins,
    #[serde(rename = "inputWidthPx")]
    pub input_width: usize,
    #[serde(rename = "inputHeightPx")]
    pub input_height: usize,
}

mod pixel_rect_serde {
    use super::*;

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PixelRect {
        x_px: f64,
        y_px: f64,
        width_px: f64,
        height_px: f64,
    }

    pub fn serialize<S>(rect: &Rect, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        PixelRect {
            x_px: rect.x,
            y_px: rect.y,
            width_px: rect.width,
            height_px: rect.height,
        }
        .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Rect, D::Error>
    where
        D: Deserializer<'de>,
    {
        let rect = PixelRect::deserialize(deserializer)?;
        Ok(Rect::new(
            rect.x_px,
            rect.y_px,
            rect.width_px,
            rect.height_px,
        ))
    }
}

mod optional_pixel_rect_serde {
    use super::*;

    pub fn serialize<S>(rect: &Option<Rect>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match rect {
            Some(rect) => serializer.serialize_some(&PixelRectRef(rect)),
            None => serializer.serialize_none(),
        }
    }

    struct PixelRectRef<'a>(&'a Rect);

    impl Serialize for PixelRectRef<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            pixel_rect_serde::serialize(self.0, serializer)
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Rect>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PixelRect {
            x_px: f64,
            y_px: f64,
            width_px: f64,
            height_px: f64,
        }
        Ok(Option::<PixelRect>::deserialize(deserializer)?
            .map(|rect| Rect::new(rect.x_px, rect.y_px, rect.width_px, rect.height_px)))
    }
}

pub struct PageAnalysisResult {
    pub outputs: Vec<AnalysisOutputMetadata>,
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub rotated_width: usize,
    pub rotated_height: usize,
    pub candidate_cutter_ratio: Option<f64>,
    pub whitespace_score: f64,
    pub text_axis: Option<TextAxisHint>,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

struct PreparedPage<'a> {
    /// `None` when the rotated source and `normalized` are the same buffer.
    rotated_source: Option<Cow<'a, GrayImage>>,
    normalized: Arc<GrayImage>,
    analysis_normalized: Option<Arc<GrayImage>>,
    analysis_scale_x: f64,
    analysis_scale_y: f64,
    calibration: PageCalibration,
    rotated_color: Option<RgbImage>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tone_picture_mask: Option<Arc<BinaryImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    trusted_foreground_mask: Option<BinaryImage>,
    split: SplitResult,
    split_cache_key: Option<StageCacheKey>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
}

struct PreparedAnalysis {
    normalized: Arc<GrayImage>,
    split: SplitResult,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
    calibration: PageCalibration,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
    text_axis: Option<TextAxisHint>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    photo_preservation_alpha: Option<Arc<GrayImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    split_cache_key: Option<StageCacheKey>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
}

struct AnalysisArtifact {
    normalized: Arc<GrayImage>,
    layout_normalized: Arc<GrayImage>,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
    calibration: PageCalibration,
    effective_dpi: f64,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    photo_preservation_alpha: Option<Arc<GrayImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
    analysis_threshold: Option<u8>,
    text_axis: Option<TextAxisHint>,
}

fn union_optional_masks(
    left: Option<&Arc<BinaryImage>>,
    right: Option<&Arc<BinaryImage>>,
) -> Option<Arc<BinaryImage>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(Arc::new(left.or(right))),
        (Some(mask), None) | (None, Some(mask)) => Some(Arc::clone(mask)),
        (None, None) => None,
    }
}

fn retain_trusted_mrc_tone_components(mask: BinaryImage, effective_dpi: f64) -> BinaryImage {
    let page_pixels = mask.width().saturating_mul(mask.height()).max(1);
    let minimum_area = (page_pixels as f64 * 0.005).round().max(1.0) as usize;
    let minimum_span = (effective_dpi * 0.20).round().max(12.0) as usize;
    ComponentMap::from_binary(&mask).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        component.area >= minimum_area && width >= minimum_span && height >= minimum_span
    })
}

fn carve_trusted_mrc_tone_owner(
    source: &GrayImage,
    trusted_tone: BinaryImage,
    text_vicinity_mask: Option<&BinaryImage>,
    effective_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    let component_vetoed = veto_text_like_regions(source, trusted_tone, effective_dpi, calibration);
    // Component rejection and the pixel-level text carve are cumulative
    // safeguards. A genuine photo component can contain a caption or an
    // antialiased producer-text ghost without being text-like as a whole;
    // conversely, subtracting from the original producer mask here would
    // silently revive components that the stricter veto already rejected.
    let carved = if let Some(text) = text_vicinity_mask {
        component_vetoed.subtract(text)
    } else {
        component_vetoed
    };
    retain_trusted_mrc_tone_components(carved, effective_dpi)
}

fn union_optional_gray_fields(
    left: Option<&Arc<GrayImage>>,
    right: Option<&Arc<GrayImage>>,
) -> Option<Arc<GrayImage>> {
    match (left, right) {
        (Some(left), Some(right)) => {
            debug_assert_eq!(left.width(), right.width());
            debug_assert_eq!(left.height(), right.height());
            let mut combined = GrayImage::new(left.width(), left.height(), 0);
            combined
                .data_mut()
                .iter_mut()
                .zip(left.data())
                .zip(right.data())
                .for_each(|((target, &left), &right)| *target = left.max(right));
            Some(Arc::new(combined))
        }
        (Some(field), None) | (None, Some(field)) => Some(Arc::clone(field)),
        (None, None) => None,
    }
}

fn coherent_photo_field(alpha: &GrayImage, source: &GrayImage) -> Option<Arc<BinaryImage>> {
    debug_assert_eq!(alpha.width(), source.width());
    debug_assert_eq!(alpha.height(), source.height());
    let width = alpha.width();
    let height = alpha.height();
    let dark_tone_threshold = otsu_threshold(source).saturating_add(32);
    let dense_rows = (0..height)
        .map(|y| {
            (0..width)
                .filter(|&x| alpha.get(x, y) >= 128 && source.get(x, y) <= dark_tone_threshold)
                .count()
                .saturating_mul(5)
                >= width
        })
        .collect::<Vec<_>>();
    let mut retained = BinaryImage::new(width, height);
    let mut row_start = None;
    for (y, is_dense) in dense_rows
        .iter()
        .copied()
        .chain(std::iter::once(false))
        .enumerate()
    {
        match (row_start, is_dense) {
            (None, true) => row_start = Some(y),
            (Some(top), false) => {
                let bottom = y - 1;
                let row_span = bottom - top + 1;
                if row_span.saturating_mul(8) >= height {
                    let dense_columns = (0..width)
                        .map(|x| {
                            (top..=bottom)
                                .filter(|&row| {
                                    alpha.get(x, row) >= 128
                                        && source.get(x, row) <= dark_tone_threshold
                                })
                                .count()
                                .saturating_mul(5)
                                >= row_span.saturating_mul(2)
                        })
                        .collect::<Vec<_>>();
                    let mut column_start = None;
                    let mut significant_runs = Vec::new();
                    for (x, is_dense) in dense_columns
                        .iter()
                        .copied()
                        .chain(std::iter::once(false))
                        .enumerate()
                    {
                        match (column_start, is_dense) {
                            (None, true) => column_start = Some(x),
                            (Some(left), false) => {
                                let right = x - 1;
                                if (right - left + 1).saturating_mul(20) >= width {
                                    significant_runs.push((left, right));
                                }
                                column_start = None;
                            }
                            _ => {}
                        }
                    }
                    if let (Some((left, _)), Some((_, right))) =
                        (significant_runs.first(), significant_runs.last())
                    {
                        if (right - left + 1).saturating_mul(8) >= width {
                            for row in top..=bottom {
                                for column in *left..=*right {
                                    retained.set(column, row, true);
                                }
                            }
                        }
                    }
                }
                row_start = None;
            }
            _ => {}
        }
    }
    (retained.count_black() > 0).then(|| Arc::new(retained))
}

#[derive(Clone)]
struct CachedContentDetection {
    detected_content: Option<Rect>,
    source_content_box: Option<Rect>,
    diagnostics: Option<ContentDiagnostics>,
}

pub fn classify_page(
    source: &GrayImage,
    options: &CleanupOptions,
) -> Result<PageClassificationResult, String> {
    classify_page_with_document_prior(source, options, None)
}

pub fn classify_page_with_document_prior(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageClassificationResult, String> {
    let mut timings = PageStageTimings::default();
    classify_page_with_document_prior_impl(source, options, document_prior, None, &mut timings)
}

fn classify_page_with_document_prior_impl(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    timings: &mut PageStageTimings,
) -> Result<PageClassificationResult, String> {
    options.validate()?;
    let prepared = prepare_analysis_page(
        source,
        None,
        options,
        false,
        PageRenderPolicy {
            create_mixed_layers: false,
            create_mixed_composite: false,
            recommend_output_mode: true,
            analyze_layout: true,
        },
        document_prior,
        CalibrationConfig::default(),
        cache,
        None,
        timings,
    );
    Ok(PageClassificationResult {
        classification: prepared.split.classification,
        confidence: prepared.split.confidence,
        cutter_x: prepared.split.cutter_x,
        split_seam: prepared.split.split_seam,
        excluded: options.excluded,
        rotation: options.rotation,
        reconciliation: prepared.split.reconciliation,
        split_diagnostics: prepared.split.diagnostics,
        rotated_width: prepared.full_width,
        rotated_height: prepared.full_height,
        candidate_cutter_ratio: prepared.candidate_cutter_ratio,
        whitespace_score: prepared.whitespace_score,
        text_axis: prepared.text_axis,
        output_mode_recommendation: prepared.output_mode_recommendation,
    })
}

pub fn analyze_page(
    source: &GrayImage,
    options: &CleanupOptions,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_document_prior(source, options, None)
}

pub fn analyze_page_with_document_prior(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_color_and_document_prior(source, None, options, document_prior)
}

pub fn analyze_page_with_color_and_document_prior(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageAnalysisResult, String> {
    let mut timings = PageStageTimings::default();
    analyze_page_with_color_and_document_prior_impl(
        source,
        color_source,
        options,
        document_prior,
        true,
        true,
        None,
        &mut timings,
    )
}

pub(crate) fn analyze_page_with_color_and_document_prior_cached(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: &PageCache,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_color_and_document_prior_impl(
        source,
        color_source,
        options,
        document_prior,
        recommend_output_mode,
        plan_content,
        Some(cache),
        timings,
    )
}

#[cfg(test)]
pub(crate) fn analyze_page_with_document_prior_cached(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    cache: &PageCache,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_color_and_document_prior_cached(
        source,
        None,
        options,
        document_prior,
        true,
        true,
        cache,
        timings,
    )
}

fn analyze_page_with_color_and_document_prior_impl(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: Option<&PageCache>,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, String> {
    options.validate()?;
    if options.excluded {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            confidence: 1.0,
            cutter_x: None,
            split_seam: None,
            excluded: true,
            rotation: options.rotation,
            reconciliation: ReconciliationMetadata {
                tier1_verdict: LayoutClassification::SingleUncutPage,
                reconciled: false,
                cluster_agreement: 0.0,
            },
            split_diagnostics: SplitDiagnostics::default(),
            rotated_width: source.width(),
            rotated_height: source.height(),
            candidate_cutter_ratio: None,
            whitespace_score: 0.0,
            text_axis: None,
            output_mode_recommendation: None,
        });
    }
    let prepared = prepare_analysis_page(
        source,
        color_source,
        options,
        plan_content,
        PageRenderPolicy {
            create_mixed_layers: false,
            create_mixed_composite: false,
            recommend_output_mode,
            analyze_layout: true,
        },
        document_prior,
        CalibrationConfig::default(),
        cache,
        None,
        timings,
    );
    if !plan_content {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: prepared.split.classification,
            confidence: prepared.split.confidence,
            cutter_x: prepared.split.cutter_x,
            split_seam: prepared.split.split_seam,
            excluded: false,
            rotation: options.rotation,
            reconciliation: prepared.split.reconciliation,
            split_diagnostics: prepared.split.diagnostics,
            rotated_width: prepared.full_width,
            rotated_height: prepared.full_height,
            candidate_cutter_ratio: prepared.candidate_cutter_ratio,
            whitespace_score: prepared.whitespace_score,
            text_axis: prepared.text_axis,
            output_mode_recommendation: prepared.output_mode_recommendation,
        });
    }
    let content_started = Instant::now();
    let outputs = output_regions(
        prepared.full_width,
        prepared.full_height,
        &prepared.split,
        options.layout,
    )
    .into_iter()
    .map(|(region, half)| {
        let analysis_region = Rect::new(
            region.x * prepared.scale_x,
            region.y * prepared.scale_y,
            region.width * prepared.scale_x,
            region.height * prepared.scale_y,
        );
        let working = crop_gray(&prepared.normalized, analysis_region);
        let text_tone_diagnostics = if prepared.resolved_output_mode == OutputMode::Grayscale {
            prepared
                .text_mask
                .as_ref()
                .zip(prepared.text_vicinity_mask.as_ref())
                .map(|(text_mask, text_vicinity_mask)| {
                    let picture_mask = prepared
                        .picture_mask
                        .as_ref()
                        .map(|mask| crop_binary(mask, analysis_region))
                        .unwrap_or_else(|| BinaryImage::new(working.width(), working.height()));
                    derive_text_tone_diagnostics(
                        &working,
                        &crop_binary(text_mask, analysis_region),
                        &crop_binary(text_vicinity_mask, analysis_region),
                        &picture_mask,
                    )
                })
        } else {
            None
        };
        let content_picture_mask = prepared
            .content_picture_mask
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let (detected_content, content_diagnostics) = if let Some(manual) =
            options.resolved_content_for(half, prepared.full_width, prepared.full_height)
        {
            let left = manual.x.clamp(0.0, region.width.max(1.0) - 1.0);
            let top = manual.y.clamp(0.0, region.height.max(1.0) - 1.0);
            let right = manual.right().clamp(left + 1.0, region.width);
            let bottom = manual.bottom().clamp(top + 1.0, region.height);
            (Some(Rect::new(left, top, right - left, bottom - top)), None)
        } else {
            let detected = detect_content_and_margins_calibrated(
                &working,
                content_picture_mask.as_ref(),
                prepared.calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                prepared.calibration,
            );
            let content = detected.content.map(|content| {
                Rect::new(
                    content.x / prepared.scale_x,
                    content.y / prepared.scale_y,
                    content.width / prepared.scale_x,
                    content.height / prepared.scale_y,
                )
            });
            (content, detected.diagnostics)
        };
        if options.match_page_size {
            // Matched margins are composed on the final document grid, but
            // their untrusted request geometry still has to pass the same
            // finite-arithmetic checks before the engine omits them here.
            content_result_for_dimensions(
                region.width.ceil().max(1.0) as usize,
                region.height.ceil().max(1.0) as usize,
                options.dpi,
                detected_content,
                options.margins_mm.map(crate::MarginsMm::values),
                options.margins_pixels,
            )?;
        }
        let content = content_result_for_dimensions(
            region.width.ceil().max(1.0) as usize,
            region.height.ceil().max(1.0) as usize,
            options.dpi,
            detected_content,
            if options.match_page_size {
                None
            } else {
                options.margins_mm.map(crate::MarginsMm::values)
            },
            if options.match_page_size {
                Some([0.0; 4])
            } else {
                options.margins_pixels
            },
        )?;
        options.validate_derived_raster_dimensions(
            content.output_rect.width,
            content.output_rect.height,
        )?;
        let crop_enabled = options.crop_content && content.content.is_some();
        let local_crop = if crop_enabled {
            content.output_rect
        } else {
            Rect::new(0.0, 0.0, region.width, region.height)
        };
        Ok(AnalysisOutputMetadata {
            half,
            source_region: region,
            content_box: content.content,
            content_diagnostics,
            text_tone_diagnostics,
            crop_rect: Rect::new(
                region.x + local_crop.x,
                region.y + local_crop.y,
                local_crop.width,
                local_crop.height,
            ),
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            }
            .into(),
            input_width: source.width(),
            input_height: source.height(),
        })
    })
    .collect::<Result<Vec<_>, String>>()?;
    timings.content_ms += content_started.elapsed().as_secs_f64() * 1_000.0;
    Ok(PageAnalysisResult {
        outputs,
        classification: prepared.split.classification,
        confidence: prepared.split.confidence,
        cutter_x: prepared.split.cutter_x,
        split_seam: prepared.split.split_seam,
        excluded: false,
        rotation: options.rotation,
        reconciliation: prepared.split.reconciliation,
        split_diagnostics: prepared.split.diagnostics,
        rotated_width: prepared.full_width,
        rotated_height: prepared.full_height,
        candidate_cutter_ratio: prepared.candidate_cutter_ratio,
        whitespace_score: prepared.whitespace_score,
        text_axis: prepared.text_axis,
        output_mode_recommendation: prepared.output_mode_recommendation,
    })
}

#[derive(Clone, Copy)]
struct PageRenderPolicy {
    create_mixed_layers: bool,
    create_mixed_composite: bool,
    recommend_output_mode: bool,
    /// Picture mask, mode recommendation, text axis and split detection. A
    /// caller that already knows the page layout keeps calibration and
    /// binarization without paying for them. Only legal when the layout is
    /// already resolved to a single region.
    analyze_layout: bool,
}

impl PageRenderPolicy {
    const COMPLETE: Self = Self {
        create_mixed_layers: true,
        create_mixed_composite: true,
        recommend_output_mode: true,
        analyze_layout: true,
    };

    const DETAIL_TILE: Self = Self {
        create_mixed_layers: false,
        create_mixed_composite: true,
        recommend_output_mode: false,
        analyze_layout: false,
    };
}

pub fn clean_page(
    source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        None,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
}

#[doc(hidden)]
pub fn clean_page_with_calibration_config(
    source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
    calibration_config: CalibrationConfig,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        None,
        None,
        None,
        options,
        source_page_index,
        calibration_config,
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
}

pub fn clean_page_with_color(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
}

pub fn clean_page_with_color_and_document_prior(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    document_prior: Option<DocumentPrior>,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn clean_page_with_color_and_document_prior_cached(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    document_prior: Option<DocumentPrior>,
    cache: &PageCache,
    create_mixed_layers: bool,
    recommend_output_mode: bool,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, String> {
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        trusted_foreground_mask,
        trusted_mrc_background,
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        Some(cache),
        PageRenderPolicy {
            create_mixed_layers,
            // The batch adapter can publish the cheaper separable representation
            // only when it supplied destinations for both layers. Library callers
            // and ordinary single-raster outputs still need the composite.
            create_mixed_composite: !create_mixed_layers,
            recommend_output_mode,
            analyze_layout: true,
        },
        timings,
    )
}

#[allow(clippy::too_many_arguments)]
fn clean_page_with_color_and_calibration_config(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    calibration_config: CalibrationConfig,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    render_policy: PageRenderPolicy,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, String> {
    options.validate()?;
    if options.excluded {
        return Ok(PageCleanupResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            layout_confidence: 1.0,
            cutter_x: None,
            split_seam: None,
            reconciliation: ReconciliationMetadata {
                tier1_verdict: LayoutClassification::SingleUncutPage,
                reconciled: false,
                cluster_agreement: 0.0,
            },
            split_diagnostics: SplitDiagnostics::default(),
            blank_outputs_skipped: 0,
            excluded: true,
            rotation: options.rotation,
            output_mode_recommendation: None,
        });
    }
    let prepared = prepare_page(
        source,
        color_source,
        trusted_foreground_mask,
        trusted_mrc_background,
        options,
        calibration_config,
        document_prior,
        cache,
        render_policy,
        timings,
    );
    let auto_resolved_color = options.output_mode == OutputMode::Auto
        && prepared.resolved_output_mode == OutputMode::Color;
    let mut resolved_options;
    let options = if prepared.resolved_output_mode == options.output_mode && !auto_resolved_color {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = prepared.resolved_output_mode;
        if auto_resolved_color {
            resolved_options.normalize_illumination = false;
        }
        &resolved_options
    };
    let PreparedPage {
        rotated_source,
        normalized,
        analysis_normalized,
        analysis_scale_x,
        analysis_scale_y,
        calibration,
        rotated_color,
        content_picture_mask,
        picture_mask,
        halftone_zone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tone_picture_mask,
        tone_preservation_alpha,
        text_mask,
        text_vicinity_mask,
        trusted_foreground_mask,
        split,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode: _,
    } = prepared;
    let regions = output_regions(
        normalized.width(),
        normalized.height(),
        &split,
        options.layout,
    );
    let mut outputs = Vec::with_capacity(regions.len());
    for (region, half) in regions {
        outputs.push(clean_region(
            source,
            rotated_source.as_deref().unwrap_or(&normalized),
            &normalized,
            analysis_normalized.as_deref().unwrap_or(&normalized),
            analysis_scale_x,
            analysis_scale_y,
            calibration,
            rotated_color.as_ref(),
            content_picture_mask.as_deref(),
            picture_mask.as_deref(),
            halftone_zone_mask.as_deref(),
            spatial_tone_mask.as_deref(),
            chroma_picture_mask.as_deref(),
            tone_picture_mask.as_deref(),
            preserve_confirmed_photo_tones,
            use_soft_alpha_foreground,
            tone_preservation_alpha.as_deref(),
            text_mask.as_deref(),
            text_vicinity_mask.as_deref(),
            trusted_foreground_mask.as_ref(),
            options,
            source_page_index,
            &split,
            region,
            half,
            cache,
            split_cache_key.as_ref(),
            source_effectively_blank,
            render_policy.create_mixed_layers,
            render_policy.create_mixed_composite,
            timings,
        )?);
    }
    let before_blank_filter = outputs.len();
    if options.skip_blank_pages && options.render_crop.is_none() {
        outputs.retain(|output| !output.effectively_blank);
    }
    let blank_outputs_skipped = before_blank_filter - outputs.len();
    Ok(PageCleanupResult {
        outputs,
        classification: split.classification,
        layout_confidence: split.confidence,
        cutter_x: split.cutter_x,
        split_seam: split.split_seam.clone(),
        reconciliation: split.reconciliation,
        split_diagnostics: split.diagnostics,
        blank_outputs_skipped,
        excluded: false,
        rotation: options.rotation,
        output_mode_recommendation,
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_page<'a>(
    source: &'a GrayImage,
    color_source: Option<&RgbImage>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration_config: CalibrationConfig,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    render_policy: PageRenderPolicy,
    timings: &mut PageStageTimings,
) -> PreparedPage<'a> {
    let PreparedAnalysis {
        normalized: analysis_normalized,
        split,
        scale_x,
        scale_y,
        calibration,
        content_picture_mask: analysis_content_picture_mask,
        picture_mask: analysis_picture_mask,
        halftone_zone_mask: analysis_halftone_zone_mask,
        spatial_tone_mask: analysis_spatial_tone_mask,
        chroma_picture_mask: analysis_chroma_picture_mask,
        tonal_protection_mask: analysis_tonal_protection_mask,
        semantic_preservation_alpha: analysis_semantic_preservation_alpha,
        photo_preservation_alpha: analysis_photo_preservation_alpha,
        tone_preservation_alpha: analysis_tone_preservation_alpha,
        text_mask: analysis_text_mask,
        text_vicinity_mask: analysis_text_vicinity_mask,
        full_width,
        full_height,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode,
        ..
    } = prepare_analysis_page(
        source,
        color_source,
        options,
        true,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    );
    // Auto Color is an explicit semantic abstention from paper cleanup: the
    // page is continuous-tone/color content, not paper plus ink. Keeping
    // illumination normalization enabled here made preview invent a visual
    // change while the compact PDF assembler correctly wanted to preserve the
    // source objects. Explicit Color remains user-controlled and may normalize.
    let auto_resolved_color =
        options.output_mode == OutputMode::Auto && resolved_output_mode == OutputMode::Color;
    let mut resolved_options;
    let options = if resolved_output_mode == options.output_mode && !auto_resolved_color {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = resolved_output_mode;
        if auto_resolved_color {
            resolved_options.normalize_illumination = false;
        }
        &resolved_options
    };
    let rotated_source = match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(source),
        rotation => Cow::Owned(rotate_orthogonal(source, rotation)),
    };
    let analysis_is_full = analysis_normalized.width() == full_width
        && analysis_normalized.height() == full_height
        && scale_x == 1.0
        && scale_y == 1.0;
    let quality_normalization_started = Instant::now();
    // Picture segmentation is scale-stable evidence. Keep it at the bounded
    // analysis resolution and map it directly into the final render below;
    // rebuilding the same mask over a 15–35 MP source dominated mixed-page
    // cleanup and only created an intermediate mask that was immediately
    // resampled again.
    let mut picture_mask = if options.output_mode != OutputMode::Bw {
        analysis_picture_mask.clone()
    } else {
        None
    };
    let normalization_model_exclusion = union_optional_masks(
        analysis_picture_mask.as_ref(),
        analysis_tonal_protection_mask.as_ref(),
    );
    let normalization_model_exclusion = match options.output_mode {
        OutputMode::Grayscale => normalization_model_exclusion.as_deref(),
        OutputMode::Mixed => picture_mask.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            normalization_model_exclusion.as_deref()
        }
        // A Color page without an embedded picture is commonly a full-bleed
        // cover. Supplying any mask makes RGB normalization assume that an
        // external paper field exists and can turn the cover into pale noise.
        // The unmasked color path already selects conservative levels when no
        // plausible paper background exists.
        OutputMode::Color => None,
        OutputMode::Bw | OutputMode::Auto => None,
    };
    // Semantic tone is reconstructed from the illumination-corrected raster;
    // only true photo regions may restore the raw scan. Their union remains
    // the render-space suppression field for text enhancement.
    let semantic_preservation_alpha = match options.output_mode {
        OutputMode::Grayscale => analysis_semantic_preservation_alpha.as_deref(),
        OutputMode::Mixed => analysis_semantic_preservation_alpha.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            analysis_semantic_preservation_alpha.as_deref()
        }
        OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
    };
    let photo_preservation_alpha = match options.output_mode {
        OutputMode::Grayscale => analysis_photo_preservation_alpha.as_deref(),
        OutputMode::Mixed => analysis_photo_preservation_alpha.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            analysis_photo_preservation_alpha.as_deref()
        }
        OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
    };
    let rotated_color_source = color_source.map(|image| match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(image),
        rotation => Cow::Owned(rotate_rgb_orthogonal(image, rotation)),
    });
    let trusted_foreground_mask =
        trusted_foreground_mask.map(|mask| rotate_binary_orthogonal(mask, options.rotation));
    let paired_normalized = if !analysis_is_full
        && options.normalize_illumination
        && matches!(options.output_mode, OutputMode::Mixed | OutputMode::Color)
    {
        rotated_color_source.as_ref().map(|rotated_color| {
            normalize_illumination_pair_with_masks(
                &rotated_source,
                rotated_color,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        })
    } else {
        None
    };
    let rotated_color = rotated_color_source.map(|rotated| {
        if let Some((_, normalized_color)) = paired_normalized.as_ref() {
            normalized_color.clone()
        } else if options.normalize_illumination {
            normalize_illumination_rgb_with_masks(
                &rotated_source,
                &rotated,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        } else {
            rotated.into_owned()
        }
    });
    let (rotated_source, normalized, analysis_normalized) = if analysis_is_full {
        (Some(rotated_source), analysis_normalized, None)
    } else if options.normalize_illumination {
        let normalized = if let Some((normalized, _)) = paired_normalized {
            normalized
        } else {
            normalize_illumination_with_masks(
                &rotated_source,
                options.dpi,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        };
        (
            Some(rotated_source),
            Arc::new(normalized),
            Some(analysis_normalized),
        )
    } else {
        (
            None,
            Arc::new(rotated_source.into_owned()),
            Some(analysis_normalized),
        )
    };
    timings.quality_normalization_ms +=
        quality_normalization_started.elapsed().as_secs_f64() * 1_000.0;
    PreparedPage {
        rotated_source,
        normalized,
        analysis_normalized,
        analysis_scale_x: scale_x,
        analysis_scale_y: scale_y,
        calibration,
        rotated_color,
        content_picture_mask: analysis_content_picture_mask,
        picture_mask: picture_mask.take(),
        halftone_zone_mask: analysis_halftone_zone_mask,
        spatial_tone_mask: analysis_spatial_tone_mask,
        chroma_picture_mask: analysis_chroma_picture_mask,
        tone_picture_mask: analysis_tonal_protection_mask,
        tone_preservation_alpha: analysis_tone_preservation_alpha,
        text_mask: analysis_text_mask,
        text_vicinity_mask: analysis_text_vicinity_mask,
        trusted_foreground_mask,
        split,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode,
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_analysis_page(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    prepare_quality_raster: bool,
    render_policy: PageRenderPolicy,
    document_prior: Option<DocumentPrior>,
    calibration_config: CalibrationConfig,
    cache: Option<&PageCache>,
    trusted_mrc_background: Option<&GrayImage>,
    timings: &mut PageStageTimings,
) -> PreparedAnalysis {
    debug_assert!(
        render_policy.analyze_layout
            || matches!(options.layout, crate::LayoutMode::Single) && !options.has_split_evidence(),
        "skipping layout analysis requires an already-resolved single-region layout",
    );
    let analysis_key = cache.map(|cache| {
        StageCacheKey::analysis(
            &cache.source,
            options,
            prepare_quality_raster,
            render_policy.recommend_output_mode,
            render_policy.analyze_layout,
            render_policy.create_mixed_layers,
            calibration_config,
        )
    });
    let cached_analysis = cache
        .zip(analysis_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<AnalysisArtifact>(key));
    let analysis = cached_analysis.unwrap_or_else(|| {
        let analysis_started = Instant::now();
        // A compact MRC page has two independent sampling limits: its
        // high-resolution bilevel foreground and its much coarser
        // continuous-tone background. Running semantic tone detection above
        // the latter's native DPI only measures interpolation around the
        // foreground mask. The same page then acquires "new" coherent tone
        // when the PDF rasterizer is asked for a larger final image even
        // though the authored background contains no additional information.
        //
        // Keep every source at the same 150-DPI analysis ceiling. Producer
        // layers are evidence for optional hints, never a mode-resolution
        // override.
        let analysis_dpi_ceiling = 150.0;
        let AnalysisLevel {
            image,
            effective_dpi,
            scale_x: _,
            scale_y: _,
        } = build_analysis_level(source, options.dpi, analysis_dpi_ceiling);
        let rotated = rotate_orthogonal(&image, options.rotation);
        let analysis_rgb = color_source
            .map(|rgb| downscale_rgb_to_dimensions(rgb, image.width(), image.height()))
            .map(|rgb| rotate_rgb_orthogonal(&rgb, options.rotation));
        let (full_width, full_height) = match options.rotation {
            OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => {
                (source.width(), source.height())
            }
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => {
                (source.height(), source.width())
            }
        };
        let scale_x = rotated.width() as f64 / full_width.max(1) as f64;
        let scale_y = rotated.height() as f64 / full_height.max(1) as f64;
        let blank_scan_candidate = options.manual_content_boxes.is_empty()
            && options.manual_zones.picture.is_empty()
            && options.manual_zones.fill.is_empty()
            && is_blank_scan_candidate(&rotated, analysis_rgb.as_ref());
        // scale_x and scale_y come from independently rounded analysis
        // dimensions; on tiny rasters (1x2, 3x7) they legitimately differ
        // from each other and from min(source scales), so no cross-axis
        // equality holds.
        timings.analysis_level_ms += analysis_started.elapsed().as_secs_f64() * 1_000.0;

        let normalization_started = Instant::now();
        let illumination_preparation_started = Instant::now();
        let illumination_preparation = options.normalize_illumination.then(|| {
            let preparation = prepare_illumination(&rotated);
            timings.illumination_preparation_ms +=
                illumination_preparation_started.elapsed().as_secs_f64() * 1_000.0;
            preparation
        });
        let layout_normalization_started = Instant::now();
        let layout_normalized = if let Some(preparation) = illumination_preparation.as_ref() {
            normalize_illumination_for_layout_prepared(&rotated, preparation)
        } else {
            rotated.clone()
        };
        timings.layout_normalization_ms +=
            layout_normalization_started.elapsed().as_secs_f64() * 1_000.0;
        let calibration_started = Instant::now();
        let calibration =
            PageCalibration::estimate(&layout_normalized, effective_dpi, calibration_config);
        timings.calibration_ms += calibration_started.elapsed().as_secs_f64() * 1_000.0;
        let picture_mask_started = Instant::now();
        let continuous_tone_mask = render_policy.analyze_layout.then(|| {
            Arc::new(if blank_scan_candidate {
                BinaryImage::new(rotated.width(), rotated.height())
            } else {
                derive_halftone_zones(&rotated, effective_dpi)
            })
        });
        let detected_picture_mask = render_policy.analyze_layout.then(|| {
            Arc::new(if blank_scan_candidate {
                BinaryImage::new(rotated.width(), rotated.height())
            } else {
                detect_picture_mask_with_continuous_tone(
                    &rotated,
                    effective_dpi,
                    calibration,
                    continuous_tone_mask
                        .as_deref()
                        .expect("layout analysis must prepare continuous-tone evidence"),
                )
            })
        });
        let automatic_picture_mask = render_policy.analyze_layout.then(|| {
            Arc::new(if blank_scan_candidate {
                BinaryImage::new(rotated.width(), rotated.height())
            } else {
                detected_picture_mask
                    .as_deref()
                    .expect("layout analysis must prepare detected picture evidence")
                    .or(continuous_tone_mask
                        .as_deref()
                        .expect("layout analysis must prepare continuous-tone evidence"))
            })
        });
        let mut picture_mask = automatic_picture_mask.as_deref().map(|automatic| {
            let mut mask = automatic.clone();
            apply_manual_zones(&mut mask, options);
            Arc::new(mask)
        });
        // Keep producer evidence separate until real text-vicinity geometry is
        // available. A low-resolution MRC background can contain antialiased
        // text ghosts joined to a genuine photo; treating that whole joined
        // component as an owner either swallows text or makes the component
        // veto discard the photo with it.
        // The producer-authored continuous-tone layer is independent evidence
        // of photo ownership. Keep it separate until text geometry is known;
        // the existing flattened-page detector may cover only the darkest
        // lobe of the same photograph.
        let corroborated_picture_owner_pixels = detected_picture_mask
            .as_deref()
            .map_or(0, BinaryImage::count_black);
        let trusted_mrc_tone_mask = picture_mask
            .as_deref()
            .filter(|_| options.trusted_mrc_source_available)
            .and(trusted_mrc_background)
            .map(|background| {
                let native_tone =
                    detect_continuous_tone_mask(background, options.source_background_dpi());
                let rotated_tone = rotate_binary_orthogonal(&native_tone, options.rotation);
                Arc::new(resample_binary_mask_nearest(
                    &rotated_tone,
                    rotated.width(),
                    rotated.height(),
                ))
            })
            .filter(|mask| mask.count_black() > 0)
            // Producer tone is a recall fallback, not a second classifier.
            // Once the flattened source already has a corroborated owner,
            // letting the lower-resolution background enlarge it changes
            // otherwise-correct photos and can join paper texture to them.
            .filter(|_| corroborated_picture_owner_pixels == 0);
        let content_evidence_complete = match options.layout {
            crate::LayoutMode::Single => options
                .resolved_content_for(PageHalf::Full, full_width, full_height)
                .is_some(),
            crate::LayoutMode::TwoPage => {
                options
                    .resolved_content_for(PageHalf::Left, full_width, full_height)
                    .is_some()
                    && options
                        .resolved_content_for(PageHalf::Right, full_width, full_height)
                        .is_some()
            }
            crate::LayoutMode::KeepLeft => options
                .resolved_content_for(PageHalf::Left, full_width, full_height)
                .is_some(),
            crate::LayoutMode::KeepRight => options
                .resolved_content_for(PageHalf::Right, full_width, full_height)
                .is_some(),
            crate::LayoutMode::Auto | crate::LayoutMode::PageWithOffcut => {
                [PageHalf::Full, PageHalf::Left, PageHalf::Right]
                    .into_iter()
                    .all(|half| {
                        options
                            .resolved_content_for(half, full_width, full_height)
                            .is_some()
                    })
            }
        };
        let mut content_picture_mask = if options.crop_content && !content_evidence_complete {
            picture_mask
                .as_deref()
                .map(|mask| Arc::new(extend_picture_mask_for_content(&rotated, mask, calibration)))
        } else {
            None
        };
        timings.picture_mask_ms += picture_mask_started.elapsed().as_secs_f64() * 1_000.0;
        let text_axis_started = Instant::now();
        let analysis_threshold = render_policy
            .analyze_layout
            .then(|| otsu_threshold(&layout_normalized));
        let text_axis = analysis_threshold
            .and_then(|threshold| detect_text_axis(&layout_normalized, threshold));
        timings.text_axis_ms += text_axis_started.elapsed().as_secs_f64() * 1_000.0;
        let mode_recommendation_started = Instant::now();
        // Automatic mode reuses the normal line detector. A normalized crop
        // needs the same text-vicinity evidence even after Auto has resolved
        // to an explicit mode: quality normalization otherwise erases faint
        // running furniture before the crop detector sees it. Destructive
        // blank-page cleanup itself depends only on raw luminance, chroma and
        // coherent edge structure: normalized texture is exactly the unstable
        // evidence that caused preview/final disagreements here.
        let content_evidence = picture_mask.as_deref().and_then(|picture_mask| {
            if render_policy.recommend_output_mode
                || (prepare_quality_raster
                    && options.crop_content
                    && options.normalize_illumination)
                || matches!(
                    options.output_mode,
                    OutputMode::Grayscale | OutputMode::Mixed
                )
            {
                Some(analyze_content_evidence_calibrated(
                    &layout_normalized,
                    Some(picture_mask),
                    calibration,
                ))
            } else {
                None
            }
        });
        let text_line_count = content_evidence
            .as_ref()
            .map_or(0, |evidence| evidence.diagnostics.text_mask.line_count);
        let (text_mask, text_vicinity_mask) = content_evidence.map_or((None, None), |evidence| {
            (
                Some(Arc::new(evidence.text_mask)),
                Some(Arc::new(evidence.text_vicinity_mask)),
            )
        });
        let mut trusted_mrc_owned_tone_mask = None;
        if let Some(trusted_tone) = trusted_mrc_tone_mask.as_deref() {
            let carved = carve_trusted_mrc_tone_owner(
                &rotated,
                trusted_tone.clone(),
                text_vicinity_mask.as_deref(),
                effective_dpi,
                calibration,
            );
            if carved.count_black() > 0 {
                trusted_mrc_owned_tone_mask = Some(Arc::new(carved));
            }
        }
        // Rectangular photo ownership is inferred only from automatic,
        // corroborated evidence. Explicit painter/eraser zones stay outside
        // the inference and are applied once, last, so an operator override
        // cannot be enlarged and a final eraser cannot be silently undone.
        let automatic_picture_owner = union_optional_masks(
            automatic_picture_mask.as_ref(),
            trusted_mrc_owned_tone_mask.as_ref(),
        );
        // `automatic_picture_owner` contains only detector-corroborated tone or
        // trusted producer tone that survived the text/component veto above.
        // Rectangularization may still decline to enlarge it; that decision
        // must not revoke exact source appearance inside the original owner.
        let confirmed_automatic_photo_owner = automatic_picture_owner
            .as_deref()
            .is_some_and(|owner| owner.count_black() > 0);
        let mut exact_photo_owner = None;
        if let Some(automatic) = automatic_picture_owner.as_deref() {
            let empty_text = BinaryImage::new(rotated.width(), rotated.height());
            let rectangular = rectangularize_corroborated_photos(
                &rotated,
                automatic,
                text_mask.as_deref().unwrap_or(&empty_text),
                text_vicinity_mask.as_deref().unwrap_or(&empty_text),
                effective_dpi,
            );
            let rectangle_added = rectangular.count_black() > automatic.count_black();
            let mut final_owner = rectangular;
            apply_manual_zones(&mut final_owner, options);
            let final_owner = Arc::new(final_owner);
            if rectangle_added || trusted_mrc_owned_tone_mask.is_some() {
                // Once a component has passed the text and tone safeguards,
                // its whole rectangle is one source-preserved owner. Keeping
                // the final manual-zone result here prevents later text-field
                // partitioning from recreating detector-shaped holes.
                exact_photo_owner = Some(Arc::clone(&final_owner));
            }
            picture_mask = Some(final_owner);
        }
        if options.crop_content && !content_evidence_complete {
            content_picture_mask = picture_mask
                .as_deref()
                .map(|mask| Arc::new(extend_picture_mask_for_content(&rotated, mask, calibration)));
        }
        let (outside_tone, tonal_seed_mask) = text_vicinity_mask
            .as_deref()
            .map(|mask| outside_tonal_evidence_with_mask(&layout_normalized, mask))
            .unwrap_or_else(|| {
                (
                    OutsideTonalEvidence::default(),
                    BinaryImage::new(rotated.width(), rotated.height()),
                )
            });
        // Flat, sharply bounded diagram fills are semantic tone even when
        // the halftone classifier rejects their low-spread line-art texture.
        // Keep this narrow graphic geometry as a representation channel; it
        // is not the broad tonal-protection field used by normalization.
        let flat_graphic_preservation_alpha =
            flat_graphic_tone_preservation_alpha(&layout_normalized).map(Arc::new);
        let flat_graphic_picture_mask =
            flat_graphic_preservation_alpha
                .as_deref()
                .and_then(|alpha| {
                    let mask =
                        BinaryImage::from_fn_parallel(alpha.width(), alpha.height(), |x, y| {
                            alpha.get(x, y) >= 128
                        });
                    (mask.count_black() > 0).then(|| Arc::new(mask))
                });
        // Any tone strong and coherent enough to veto destructive B&W must
        // also own pixels in a Mixed result. Previously the mode selector
        // could choose Mixed while the renderer kept an empty picture mask,
        // silently publishing a bilevel page and destroying the very map fill
        // or shaded region that caused the veto.
        let destructive_tone_mask = outside_tone.vetoes_destructive_mode().then(|| {
            Arc::new(extend_tone_mask_for_content(
                &layout_normalized,
                &tonal_seed_mask,
                calibration,
            ))
        });
        let structural_tone_mask = outside_tone
            .coherent()
            .then(|| destructive_tone_mask.as_ref().map(Arc::clone))
            .flatten();
        // This is a representation-policy channel, not the broad tonal
        // protection web used by normalization. It is the tile-resolution
        // outside-text evidence that caused a spatial-tone decision, kept
        // separate so Mixed can preserve a neutral illustration without
        // granting every protected-tone pixel ownership of the stencil
        // partition. The exact halftone zone remains the stronger channel for
        // classifier-owned pixels.
        let outside_spatial_tone_mask = (outside_tone.vetoes_destructive_mode()
            && picture_mask
                .as_ref()
                .is_none_or(|mask| mask.count_black() == 0))
        .then(|| (tonal_seed_mask.count_black() > 0).then(|| Arc::new(tonal_seed_mask.clone())))
        .flatten();
        let spatial_tone_mask = union_optional_masks(
            flat_graphic_picture_mask.as_ref(),
            outside_spatial_tone_mask.as_ref(),
        );
        if options.crop_content && !content_evidence_complete {
            // The crop planner needs the same vetted map/illustration geometry
            // as the tone-preservation path. Picture detection can be empty on
            // flat-shaded line art; without this union, cleanup preserves the
            // tones but trims the outer frame or labels that establish their
            // true page extent.
            content_picture_mask =
                union_optional_masks(content_picture_mask.as_ref(), structural_tone_mask.as_ref());
        }
        let continuous_tone_mask =
            continuous_tone_mask.and_then(|mask| (mask.count_black() > 0).then_some(mask));
        // On pages that carry text, the calibrated halftone classifier is
        // the sole owner of layered tone: granting the destructive-tone
        // field ownership there let verso show-through — coherent gray
        // outside every text line — carve tone holes through stencils and
        // republish bleed as "photograph" on plain text pages. A textless
        // sheet has no stencil to protect and no show-through/text
        // ambiguity; its broad tone evidence (a full-page plate or wash)
        // keeps the wider protection.
        let ordinary_tonal_protection_mask = union_optional_masks(
            destructive_tone_mask.as_ref(),
            continuous_tone_mask.as_ref(),
        );
        // The trusted fallback has already passed the component-level text
        // veto and the real text-vicinity carve above. Keep those surviving
        // pixels as an exact tone owner during the final Mixed partition;
        // applying the broader text-vicinity carve a second time otherwise
        // collapses the recovered photograph back to the same sparse
        // halftone islands that A7 is intended to replace.
        let trusted_tonal_protection_mask = union_optional_masks(
            ordinary_tonal_protection_mask.as_ref(),
            trusted_mrc_owned_tone_mask.as_ref(),
        );
        let tonal_protection_mask = union_optional_masks(
            trusted_tonal_protection_mask.as_ref(),
            exact_photo_owner.as_ref(),
        );
        // A textless illustration may legitimately use smooth tone across its
        // full vetted enclosure. On document-like pages, isolate semantic tone
        // from paper on the raw-source scale: deriving this alpha from the
        // already-whitened layout raster erased the very middle-gray map fills
        // it was meant to protect. The endpoint remains illumination-corrected,
        // so this alpha does not restore the page's scanner/paper shade.
        let tone_semantic_preservation_alpha = if text_line_count == 0 {
            tonal_protection_mask
                .as_deref()
                .and_then(semantic_tone_preservation_alpha)
        } else {
            refine_tone_preservation_alpha(
                &rotated,
                &rotated,
                None,
                tonal_protection_mask.as_deref(),
            )
        }
        .map(Arc::new);
        // Text remains on the monotonic paper-normalization path and is
        // darkened by the dedicated text-tone curve after geometry. A
        // detector-resolution binary text alpha changed antialiased stroke
        // coverage when resampled to the quality raster and made exact glyph
        // geometry depend on source DPI. Semantic ownership is therefore for
        // real tone only; text retention is verified separately against exact
        // synthetic ink coverage.
        let semantic_preservation_alpha = union_optional_gray_fields(
            tone_semantic_preservation_alpha.as_ref(),
            flat_graphic_preservation_alpha.as_ref(),
        );
        let source_effectively_blank = blank_scan_candidate;
        let text_soft_edge_ratio = text_vicinity_mask.as_deref().and_then(|mask| {
            // Permissive tonal evidence serves strictly as an EXCLUSION for
            // glyph-topology measurement: a spread gutter shadow rightly
            // earns no output zone from the halftone classifier, yet its
            // soft tone must not read as antialiased glyph edges and veto
            // a crisp bilevel page.
            let permissive_tone = detect_continuous_tone_mask(&rotated, effective_dpi);
            let exclusion = match picture_mask.as_deref() {
                Some(zones) => zones.or(&permissive_tone),
                None => permissive_tone,
            };
            text_soft_edge_to_ink_ratio(&rotated, mask, Some(&exclusion))
        });
        let mut output_mode_recommendation = picture_mask
            .as_deref()
            .filter(|_| render_policy.recommend_output_mode)
            .map(|picture_mask| {
                let recommendation = recommend_output_mode_with_tone(
                    PreparedModeEvidence {
                        analysis: &rotated,
                        analysis_rgb: analysis_rgb.as_ref(),
                        picture_mask,
                        text_line_count,
                    },
                    outside_tone,
                );
                protect_bilevel_text_fidelity(
                    recommendation,
                    calibration,
                    options.source_dpi(),
                    text_line_count,
                    text_soft_edge_ratio,
                )
            });
        // Maps and dense line art often satisfy the generous picture detector
        // over almost the whole page. Restoring that full rectangle also
        // restores its gray paper. Use pixel-refined preservation when the
        // page-global evidence says "large, bimodal, low-midtone line art";
        // genuine continuous photographs keep their full mask so highlights
        // and smooth gradients cannot become contrast stencils.
        let picture_ownership_diagnostics = output_mode_recommendation
            .map(|recommendation| recommendation.diagnostics)
            .or_else(|| {
                picture_mask.as_deref().map(|picture_mask| {
                    protect_bilevel_text_fidelity(
                        recommend_output_mode_with_tone(
                            PreparedModeEvidence {
                                analysis: &rotated,
                                analysis_rgb: analysis_rgb.as_ref(),
                                picture_mask,
                                text_line_count,
                            },
                            outside_tone,
                        ),
                        calibration,
                        options.source_dpi(),
                        text_line_count,
                        text_soft_edge_ratio,
                    )
                    .diagnostics
                })
            });
        let resolved_output_mode = if options.output_mode == OutputMode::Auto {
            output_mode_recommendation
                .map(|recommendation| recommendation.mode)
                .unwrap_or(options.output_mode)
        } else {
            options.output_mode
        };
        let chroma_picture_mask = (resolved_output_mode == OutputMode::Mixed)
            .then(|| {
                independent_chroma_mask(&rotated, analysis_rgb.as_ref(), text_line_count)
                    .map(Arc::new)
            })
            .flatten();
        let significant_picture = picture_ownership_diagnostics
            .is_some_and(|diagnostics| diagnostics.significant_picture);
        let refine_picture_ownership = picture_ownership_diagnostics
            .is_some_and(|diagnostics| should_refine_line_art_picture_ownership(&diagnostics));
        // Stencil legality is a property of the newly encoded foreground, not
        // of the semantic reason that selected Mixed. Spatial-tone pages can
        // have no detector-owned picture at all, so restricting this check to
        // photo-dominant Mixed output lets undersampled glyphs and map lines
        // bypass the same source-sampling boundary enforced for B&W.
        let mixed_foreground_fidelity_veto = resolved_output_mode == OutputMode::Mixed
            && picture_ownership_diagnostics.is_some_and(|diagnostics| {
                !should_refine_line_art_picture_ownership(&diagnostics)
                    && should_veto_bilevel_fidelity(
                        calibration.valid,
                        diagnostics.calibrated_source_stroke_width_px,
                        diagnostics.calibrated_source_x_height_px,
                        diagnostics.source_dpi,
                        diagnostics.soft_edge_to_ink_ratio,
                        text_line_count,
                    )
            });
        let computed_soft_alpha_foreground = resolved_output_mode == OutputMode::Mixed
            && text_line_count > 0
            && picture_ownership_diagnostics.is_some_and(|diagnostics| {
                mixed_foreground_fidelity_veto
                    || diagnostics.bilevel_fidelity_veto
                    || diagnostics.significant_color
                    || (diagnostics.significant_picture && !refine_picture_ownership)
            });
        let use_soft_alpha_foreground = resolved_output_mode == OutputMode::Mixed
            && options
                .prefer_soft_alpha_foreground
                .unwrap_or(computed_soft_alpha_foreground)
            // The final layered handoff is a fresh MRC composition. Its
            // high-resolution stencil owns ink, while the calibrated plate
            // owns continuous tone. Keeping the preview/library composite
            // soft preserves antialiasing there; publishing an 8-bit alpha
            // plane for final pages defeats the compact JBIG2 foreground
            // representation and carries no additional source ownership.
            && !render_policy.create_mixed_layers;
        if let Some(recommendation) = output_mode_recommendation.as_mut() {
            recommendation.prefer_soft_alpha_foreground = use_soft_alpha_foreground;
            recommendation.diagnostics.bilevel_fidelity_veto |= mixed_foreground_fidelity_veto;
        }
        let protect_tonal_text_vicinity = significant_picture && !refine_picture_ownership;
        // Keep confirmed ownership distinct from the broader policy that
        // suppresses semantic tone around text. A small (0.5--1.2% of page)
        // corroborated photo is intentionally below `significant_picture`, but
        // whitening it locally beside stencil ink would recreate the patchwork
        // boundary that rectangular ownership exists to remove. A rejected
        // rectangle retains exact appearance inside its original vetted mask.
        let preserve_confirmed_photo_tones = confirmed_photo_preservation_policy(
            significant_picture,
            confirmed_automatic_photo_owner,
            refine_picture_ownership,
        );
        let mut output_picture_mask = if resolved_output_mode == OutputMode::Mixed {
            // A directly detected photograph needs one coherent owner across
            // all of its continuous-tone enclosure. The permissive picture
            // detector can cover only one tonal lobe (for example, the dark
            // upper half of a portrait), while the continuous-tone detector
            // correctly covers the whole photograph. Splitting ownership at
            // that detector boundary sends the remainder through bilevel
            // routing and creates a hard posterization seam. Large bimodal
            // line art deliberately keeps the narrower destructive-tone mask
            // so its paper can still be normalized to white.
            // Published Mixed layers carry a stencil, and stencil tone
            // ownership belongs to the calibrated halftone classifier alone:
            // the broader protection field admits verso show-through —
            // coherent gray outside every text line — which carved tone
            // holes through stencils and republished bleed as "photograph"
            // on plain text pages. The wider union still guards
            // normalization and semantic alphas on stencil-free pages.
            let layer_tone_mask = continuous_tone_mask.as_ref();
            let tonal_picture_mask = union_optional_masks(picture_mask.as_ref(), layer_tone_mask);
            union_optional_masks(tonal_picture_mask.as_ref(), chroma_picture_mask.as_ref())
        } else {
            picture_mask.clone()
        };
        // Layer ownership and illumination ownership are deliberately
        // different. A coherent line-art/map field must stay out of the
        // bilevel foreground, but treating that entire field as a photograph
        // also restores its gray paper after normalization. A page with direct
        // significant-picture evidence extends that photographic treatment to
        // the coherent tone mask so detector fragments cannot create seams
        // through a real photo. Without that evidence, only detector-owned
        // pictures and independent chroma bypass the paper model.
        let mut photographic_picture_mask =
            if resolved_output_mode == OutputMode::Mixed && significant_picture {
                output_picture_mask.clone()
            } else if resolved_output_mode == OutputMode::Mixed {
                union_optional_masks(picture_mask.as_ref(), chroma_picture_mask.as_ref())
            } else {
                picture_mask.clone()
            };
        let detected_photo_preservation_alpha = photographic_picture_mask
            .as_deref()
            .and_then(|mask| {
                if refine_picture_ownership {
                    refine_line_art_preservation_alpha(&layout_normalized, &rotated, Some(mask))
                } else {
                    photo_tone_preservation_alpha(mask)
                }
            })
            .map(Arc::new);
        // On a genuine photograph the semantic tone detector can complete
        // smooth highlights that the texture-based picture mask omits. That
        // evidence must select the source-preservation branch, not merely the
        // semantic contrast curve; otherwise the two branches meet as a hard
        // horizontal seam through the image. Line-art pages keep semantic and
        // photo alphas separate so gray paper is still driven to white.
        let expanded_photo_preservation_alpha = if significant_picture && !refine_picture_ownership
        {
            union_optional_gray_fields(
                detected_photo_preservation_alpha.as_ref(),
                tone_semantic_preservation_alpha.as_ref(),
            )
        } else {
            detected_photo_preservation_alpha
        };
        let coherent_photo_mask = exact_photo_owner
            .clone()
            .or_else(|| trusted_mrc_owned_tone_mask.clone())
            .or_else(|| {
                (matches!(
                    resolved_output_mode,
                    OutputMode::Mixed | OutputMode::Grayscale
                ) && significant_picture
                    && !refine_picture_ownership)
                    .then(|| {
                        expanded_photo_preservation_alpha
                            .as_deref()
                            .and_then(|alpha| coherent_photo_field(alpha, &rotated))
                    })
                    .flatten()
            });
        let photo_preservation_alpha = if let Some(field) = coherent_photo_mask.as_ref() {
            // The high-confidence continuous field is the representation
            // boundary. Detector fragments attached to a scanner shadow or a
            // page rule remain outside it, so they can be whitened as paper;
            // the whole photographic enclosure stays on one source-preserved
            // low-DPI layer.
            if resolved_output_mode == OutputMode::Mixed {
                let field_and_chroma =
                    union_optional_masks(Some(field), chroma_picture_mask.as_ref());
                // A coherent-field replacement must not discard the exact
                // classifier zone that selected the layered owner. Keep the
                // zone in the normalization/photo owner as well as carrying
                // it separately into the final Mixed partition.
                output_picture_mask =
                    union_optional_masks(field_and_chroma.as_ref(), continuous_tone_mask.as_ref());
                photographic_picture_mask = output_picture_mask.clone();
            } else {
                photographic_picture_mask = Some(Arc::clone(field));
            }
            photo_tone_preservation_alpha(field).map(Arc::new)
        } else {
            expanded_photo_preservation_alpha
        };
        let tone_preservation_alpha = if protect_tonal_text_vicinity {
            photo_preservation_alpha.clone()
        } else {
            union_optional_gray_fields(
                semantic_preservation_alpha.as_ref(),
                photo_preservation_alpha.as_ref(),
            )
        };
        timings.mode_recommendation_ms +=
            mode_recommendation_started.elapsed().as_secs_f64() * 1_000.0;
        let quality_normalization_started = Instant::now();
        let normalized = if options.normalize_illumination {
            if prepare_quality_raster {
                let grayscale_normalization_exclusion = if resolved_output_mode
                    == OutputMode::Grayscale
                    && coherent_photo_mask.is_some()
                {
                    photographic_picture_mask.clone()
                } else {
                    union_optional_masks(picture_mask.as_ref(), tonal_protection_mask.as_ref())
                };
                let normalization_model_exclusion = match resolved_output_mode {
                    OutputMode::Grayscale => grayscale_normalization_exclusion.as_deref(),
                    OutputMode::Mixed => photographic_picture_mask.as_deref(),
                    OutputMode::Color if significant_picture => {
                        grayscale_normalization_exclusion.as_deref()
                    }
                    OutputMode::Color => None,
                    OutputMode::Bw | OutputMode::Auto => None,
                };
                let semantic_alpha = match resolved_output_mode {
                    OutputMode::Grayscale if protect_tonal_text_vicinity => None,
                    OutputMode::Grayscale => semantic_preservation_alpha.as_deref(),
                    OutputMode::Mixed if protect_tonal_text_vicinity => None,
                    OutputMode::Mixed => semantic_preservation_alpha.as_deref(),
                    OutputMode::Color if significant_picture => {
                        semantic_preservation_alpha.as_deref()
                    }
                    OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
                };
                let photo_alpha = match resolved_output_mode {
                    OutputMode::Grayscale => photo_preservation_alpha.as_deref(),
                    OutputMode::Mixed => photo_preservation_alpha.as_deref(),
                    OutputMode::Color if significant_picture => photo_preservation_alpha.as_deref(),
                    OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
                };
                let preparation = illumination_preparation
                    .expect("illumination preparation exists when normalization is enabled");
                normalize_illumination_prepared_with_masks(
                    &rotated,
                    normalization_model_exclusion,
                    semantic_alpha,
                    photo_alpha,
                    text_vicinity_mask.as_deref(),
                    preparation,
                )
            } else {
                layout_normalized.clone()
            }
        } else {
            rotated
        };
        timings.quality_normalization_ms +=
            quality_normalization_started.elapsed().as_secs_f64() * 1_000.0;
        let artifact = Arc::new(AnalysisArtifact {
            normalized: Arc::new(normalized),
            layout_normalized: Arc::new(layout_normalized),
            scale_x,
            scale_y,
            full_width,
            full_height,
            calibration,
            effective_dpi,
            picture_mask: output_picture_mask,
            halftone_zone_mask: continuous_tone_mask.clone(),
            spatial_tone_mask,
            chroma_picture_mask,
            tonal_protection_mask,
            semantic_preservation_alpha,
            photo_preservation_alpha,
            tone_preservation_alpha,
            text_mask,
            text_vicinity_mask,
            content_picture_mask,
            source_effectively_blank,
            output_mode_recommendation,
            preserve_confirmed_photo_tones,
            use_soft_alpha_foreground,
            resolved_output_mode,
            analysis_threshold,
            text_axis,
        });
        timings.normalization_ms += normalization_started.elapsed().as_secs_f64() * 1_000.0;
        if let (Some(cache), Some(key)) = (cache, analysis_key.clone()) {
            let bytes = analysis_artifact_bytes(&artifact);
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, Arc::clone(&artifact), bytes);
            }
        }
        artifact
    });
    let applicable_prior = document_prior
        .filter(|prior| prior.applies_to_dimensions(analysis.full_width, analysis.full_height));
    let split_key = cache.map(|cache| {
        StageCacheKey::split(
            &cache.source,
            options,
            prepare_quality_raster,
            render_policy.recommend_output_mode,
            render_policy.analyze_layout,
            render_policy.create_mixed_layers,
            calibration_config,
            document_prior,
        )
    });
    let cached_split = cache
        .zip(split_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<SplitResult>(key));
    let split_started = Instant::now();
    let analysis_threshold = analysis.analysis_threshold;
    let text_axis = analysis.text_axis;
    let split = cached_split.as_deref().cloned().unwrap_or_else(|| {
        let mut split = match analysis_threshold {
            None => crate::split::single_page(
                analysis.layout_normalized.width(),
                analysis.layout_normalized.height(),
            ),
            Some(analysis_threshold) if options.ocr_mode => {
                detect_split_at_analysis_level_with_threshold(
                    &analysis.layout_normalized,
                    analysis.effective_dpi,
                    crate::LayoutMode::Single,
                    None,
                    analysis_threshold,
                    None,
                )
            }
            Some(analysis_threshold) => detect_split_at_analysis_level_with_threshold(
                &analysis.layout_normalized,
                analysis.effective_dpi,
                options.layout,
                options.resolved_split_x(analysis.normalized.width()),
                analysis_threshold,
                applicable_prior,
            ),
        };
        if matches!(options.layout, crate::LayoutMode::Auto) && !options.has_split_evidence() {
            if let Some(prior) = applicable_prior {
                split.apply_document_prior(
                    analysis.normalized.width(),
                    analysis.normalized.height(),
                    prior.with_cluster_dimensions(
                        analysis.normalized.width(),
                        analysis.normalized.height(),
                    ),
                );
            }
        }
        if prepare_quality_raster && options.normalize_illumination {
            split.reusable_binary = None;
        }
        if (analysis.scale_x < 1.0
            || analysis.scale_y < 1.0
            || analysis.effective_dpi < SPLIT_ANALYSIS_DPI)
            && matches!(options.layout, crate::LayoutMode::Auto)
            && !options.has_split_evidence()
        {
            split.abstain_from_resolution_limited_offcut();
        }
        scale_split_result(
            &mut split,
            analysis.scale_x,
            analysis.scale_y,
            analysis.full_width,
            analysis.full_height,
        );
        if let (Some(cache), Some(key)) = (cache, split_key.clone()) {
            let value = Arc::new(split.clone());
            let bytes = split_result_bytes(&value);
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, value, bytes);
            }
        }
        split
    });
    timings.split_ms += split_started.elapsed().as_secs_f64() * 1_000.0;
    let candidate_cutter_ratio = (split.diagnostics.decision_x > 0.0)
        .then_some(split.diagnostics.decision_x / analysis.normalized.width().max(1) as f64);
    let whitespace_score = split.diagnostics.whitespace_score;
    PreparedAnalysis {
        normalized: Arc::clone(&analysis.normalized),
        split,
        scale_x: analysis.scale_x,
        scale_y: analysis.scale_y,
        full_width: analysis.full_width,
        full_height: analysis.full_height,
        calibration: analysis.calibration,
        candidate_cutter_ratio,
        whitespace_score,
        text_axis,
        content_picture_mask: analysis.content_picture_mask.clone(),
        picture_mask: analysis.picture_mask.clone(),
        halftone_zone_mask: analysis.halftone_zone_mask.clone(),
        spatial_tone_mask: analysis.spatial_tone_mask.clone(),
        chroma_picture_mask: analysis.chroma_picture_mask.clone(),
        tonal_protection_mask: analysis.tonal_protection_mask.clone(),
        semantic_preservation_alpha: analysis.semantic_preservation_alpha.clone(),
        photo_preservation_alpha: analysis.photo_preservation_alpha.clone(),
        tone_preservation_alpha: analysis.tone_preservation_alpha.clone(),
        text_mask: analysis.text_mask.clone(),
        text_vicinity_mask: analysis.text_vicinity_mask.clone(),
        split_cache_key: split_key,
        source_effectively_blank: analysis.source_effectively_blank,
        output_mode_recommendation: analysis.output_mode_recommendation,
        preserve_confirmed_photo_tones: analysis.preserve_confirmed_photo_tones,
        use_soft_alpha_foreground: analysis.use_soft_alpha_foreground,
        resolved_output_mode: analysis.resolved_output_mode,
    }
}

fn analysis_artifact_bytes(artifact: &AnalysisArtifact) -> usize {
    let gray = artifact.normalized.data().len() + artifact.layout_normalized.data().len();
    let picture_mask = artifact
        .picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let halftone_zone_mask = artifact
        .halftone_zone_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let spatial_tone_mask = artifact
        .spatial_tone_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let chroma_picture_mask = artifact
        .chroma_picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let tonal_protection_mask = artifact
        .tonal_protection_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let tone_preservation_alpha = artifact
        .tone_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let semantic_preservation_alpha = artifact
        .semantic_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let photo_preservation_alpha = artifact
        .photo_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let text_mask = artifact
        .text_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let text_vicinity_mask = artifact
        .text_vicinity_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let content_picture_mask = artifact
        .content_picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    gray.saturating_add(picture_mask)
        .saturating_add(halftone_zone_mask)
        .saturating_add(spatial_tone_mask)
        .saturating_add(chroma_picture_mask)
        .saturating_add(tonal_protection_mask)
        .saturating_add(semantic_preservation_alpha)
        .saturating_add(photo_preservation_alpha)
        .saturating_add(tone_preservation_alpha)
        .saturating_add(text_mask)
        .saturating_add(text_vicinity_mask)
        .saturating_add(content_picture_mask)
        .saturating_add(std::mem::size_of::<AnalysisArtifact>())
}

fn split_result_bytes(split: &SplitResult) -> usize {
    let polygons = split
        .pages
        .iter()
        .map(|polygon| polygon.points.len() * std::mem::size_of::<Point>())
        .sum::<usize>();
    let seam = split
        .split_seam
        .as_ref()
        .map_or(0, |seam| seam.points.len() * std::mem::size_of::<Point>());
    let binary = split
        .reusable_binary
        .as_ref()
        .map_or(0, |binary| std::mem::size_of_val(binary.words()));
    std::mem::size_of::<SplitResult>()
        .saturating_add(polygons)
        .saturating_add(seam)
        .saturating_add(binary)
}

fn scale_split_result(
    split: &mut SplitResult,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
) {
    split.cutter_x = split.cutter_x.map(|x| x / scale_x);
    if let Some(seam) = &mut split.split_seam {
        for point in &mut seam.points {
            point.x = (point.x / scale_x).clamp(0.0, full_width as f64);
            point.y = (point.y / scale_y).clamp(0.0, full_height as f64);
        }
    }
    for page in &mut split.pages {
        for point in &mut page.points {
            point.x /= scale_x;
            point.y /= scale_y;
        }
    }
    for page in &mut split.pages {
        for point in &mut page.points {
            point.x = point.x.clamp(0.0, full_width as f64);
            point.y = point.y.clamp(0.0, full_height as f64);
        }
    }
}

fn should_refine_line_art_picture_ownership(diagnostics: &OutputModeDiagnostics) -> bool {
    is_line_art_picture(diagnostics)
}

fn confirmed_photo_preservation_policy(
    significant_picture: bool,
    confirmed_automatic_photo_owner: bool,
    refine_picture_ownership: bool,
) -> bool {
    (significant_picture || confirmed_automatic_photo_owner) && !refine_picture_ownership
}

/// Illumination fitting can occasionally model a small isolated mark as part
/// of the paper field before binarization sees it. Reclaim only raw-dark
/// components that have printable line-art geometry and are outside the
/// semantic picture/chroma owner. Broad scanner shadows and photo plates are
/// therefore ineligible regardless of their absolute shade.
fn rescue_isolated_raw_ink(raw: &GrayImage, picture_mask: &BinaryImage, dpi: f64) -> BinaryImage {
    debug_assert_eq!(raw.width(), picture_mask.width());
    debug_assert_eq!(raw.height(), picture_mask.height());
    let threshold = otsu_threshold(raw);
    let candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= threshold && !picture_mask.get(x, y)
    });
    let px_per_mm = dpi.max(1.0) / 25.4;
    let compact_extent = (px_per_mm * 12.0).round().max(2.0) as usize;
    let compact_area = ((px_per_mm * 6.0).round().max(2.0) as usize).pow(2);
    let rule_minor_extent = (px_per_mm * 1.5).round().max(1.0) as usize;
    let rule_major_extent = (px_per_mm * 60.0).round().max(2.0) as usize;
    ComponentMap::from_binary(&candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let major = width.max(height);
        let minor = width.min(height);
        component.area >= 2
            && ((component.area <= compact_area && major <= compact_extent)
                || (minor <= rule_minor_extent && major <= rule_major_extent))
    })
}

// The verdict is per component, never per pixel: a binarized glyph edge
// legitimately extends a little past the raw dark core, and intersecting
// pixel-wise chews those contours into ragged type at high zoom. A component
// whose own pixels find almost no darker-than-local-paper source evidence is
// fabricated and dies whole; one with real support keeps its exact rendered
// shape.
const SOURCE_SUPPORT_MINIMUM_FRACTION_PERCENT: usize = 30;

fn enforce_source_ink_support(
    binary: BinaryImage,
    raw: &GrayImage,
    trusted_foreground: Option<&BinaryImage>,
    trusted_selection_complete: bool,
    dpi: f64,
) -> BinaryImage {
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    if let Some(trusted_foreground) = trusted_foreground {
        debug_assert_eq!(binary.width(), trusted_foreground.width());
        debug_assert_eq!(binary.height(), trusted_foreground.height());
        // A complete high-resolution MRC selection already records the
        // producer's exact glyph boundary. Re-thresholding the flattened page
        // can only grow or reshape those one-bit contours, which is especially
        // visible on serif text at high zoom. Full-resolution MRC backgrounds
        // are classified as incomplete by the batch adapter and retain the
        // raw-supported union below because real ink may live outside their
        // selection mask.
        if trusted_selection_complete {
            return trusted_foreground.clone();
        }
    }
    let components = ComponentMap::from_binary(&binary);
    let padding = (dpi.max(1.0) * 0.7 / 25.4).round().max(2.0) as usize;
    let accepted = components.retain(|component| {
        let left = component.left.saturating_sub(padding);
        let top = component.top.saturating_sub(padding);
        let right = component
            .right
            .saturating_add(padding)
            .min(raw.width().saturating_sub(1));
        let bottom = component
            .bottom
            .saturating_add(padding)
            .min(raw.height().saturating_sub(1));
        let mut histogram = [0usize; 256];
        let mut sample_count = 0usize;
        for y in top..=bottom {
            for x in left..=right {
                histogram[usize::from(raw.get(x, y))] += 1;
                sample_count += 1;
            }
        }
        let target = sample_count.saturating_sub(1) * 3 / 4;
        let mut cumulative = 0usize;
        let mut paper = 255u8;
        for (value, count) in histogram.into_iter().enumerate() {
            cumulative += count;
            if cumulative > target {
                paper = value as u8;
                break;
            }
        }
        let mut supported = 0usize;
        let mut total = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label {
                    continue;
                }
                total += 1;
                let sample = raw.get(x, y);
                if sample < paper || paper == 0 && sample == 0 {
                    supported += 1;
                }
            }
        }
        supported * 100 >= total * SOURCE_SUPPORT_MINIMUM_FRACTION_PERCENT
    });
    if let Some(trusted) = trusted_foreground {
        trusted.or(&accepted)
    } else {
        accepted
    }
}

fn trusted_mixed_foreground(
    trusted_foreground: Option<&BinaryImage>,
    picture_mask: &BinaryImage,
) -> Option<BinaryImage> {
    trusted_foreground.map(|trusted| trusted.subtract(picture_mask))
}

fn filter_soft_shallow_bleed_components(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> BinaryImage {
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    debug_assert!(picture_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    if binary.count_black() == 0 {
        return binary.clone();
    }

    const LARGE_CRISPNESS_FLOOR: f64 = 24.0;
    const LARGE_SHALLOW_DEPTH: u8 = 72;
    let crispness_floor = f64::from(BLEED_CRISPNESS_FLOOR);
    let shallow_depth = BLEED_SHALLOW_DEPTH;

    let gradient_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    let boundary_radius = (dpi * 0.07 / 25.4).round().clamp(1.0, 3.0) as usize;
    let boundary = erode(binary, boundary_radius, boundary_radius);
    let (raw_max, raw_min) = rayon::join(
        || erode_gray(raw, gradient_radius, gradient_radius),
        || dilate_gray(raw, gradient_radius, gradient_radius),
    );
    let components = ComponentMap::from_binary(binary);
    let (raw_sums, raw_counts) = components.gray_sums_by_component(raw);
    let mut gradient_sums = vec![0u64; components.components().len() + 1];
    let mut gradient_counts = vec![0usize; components.components().len() + 1];
    let paper = paper_reference(raw);
    let shallow_floor = paper.saturating_sub(shallow_depth);
    let mut deep_pixels = vec![0usize; components.components().len() + 1];
    let mut text_overlap = vec![0usize; components.components().len() + 1];
    let mut protected = vec![false; components.components().len() + 1];
    let protected_picture = picture_mask.map(|mask| {
        let radius = picture_protection_radius(dpi);
        dilate(mask, radius, radius)
    });
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if !binary.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if protected_picture
                .as_ref()
                .is_some_and(|mask| mask.get(x, y))
            {
                protected[label] = true;
            }
            if raw.get(x, y) < shallow_floor {
                deep_pixels[label] += 1;
            }
            if text_mask.is_some_and(|mask| mask.get(x, y)) {
                text_overlap[label] += 1;
            }
            if !boundary.get(x, y) {
                gradient_sums[label] +=
                    u64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)));
                gradient_counts[label] += 1;
            }
        }
    }
    let area_ceiling = ((dpi.max(1.0) * 2.0 / 25.4).powi(2)).round().max(16.0) as usize;
    let underline_major_extent = (dpi.max(1.0) * 15.0 / 25.4).round().max(24.0) as usize;
    let underline_max_thickness = (dpi.max(1.0) * 2.0 / 25.4).round().max(2.0) as usize;
    let underline_max_gap = (dpi.max(1.0) * 14.0 / 25.4).round().max(8.0) as usize;
    let trace_bleed = std::env::var_os("EVB_SCAN_CLEANUP_TRACE_BLEED").is_some();
    let underline_components = components.components().iter().fold(
        vec![false; components.components().len() + 1],
        |mut flags, component| {
            let label = component.label as usize;
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let text_row_above = {
                let left = component.left;
                let right = component.right.min(binary.width().saturating_sub(1));
                let top = component.top.saturating_sub(underline_max_gap);
                (top..component.top).any(|y| {
                    (left..=right).any(|x| {
                        text_mask.is_some_and(|mask| mask.get(x, y))
                            || text_vicinity_mask.is_some_and(|mask| mask.get(x, y))
                    })
                })
            };
            let horizontal_rule = width >= underline_major_extent
                && width >= height.saturating_mul(4)
                && height <= underline_max_thickness;
            let has_depth_or_crispness = deep_pixels[label].saturating_mul(4) >= component.area
                || (gradient_counts[label] > 0
                    && gradient_sums[label] as f64 / gradient_counts[label] as f64
                        >= LARGE_CRISPNESS_FLOOR);
            flags[label] = horizontal_rule
                && text_overlap[label] == 0
                && text_row_above
                && has_depth_or_crispness;
            flags
        },
    );
    let retained = components.retain(|component| {
        let label = component.label as usize;
        if protected[label]
            || underline_components[label]
            || gradient_counts[label] == 0
            || raw_counts[label] == 0
        {
            return true;
        }
        let mean = raw_sums[label] as f64 / raw_counts[label] as f64;
        let crispness = gradient_sums[label] as f64 / gradient_counts[label] as f64;
        let kept = if component.area <= area_ceiling {
            !(crispness < crispness_floor && mean >= f64::from(paper.saturating_sub(shallow_depth)))
        } else {
            !(crispness < LARGE_CRISPNESS_FLOOR
                && mean >= f64::from(paper.saturating_sub(LARGE_SHALLOW_DEPTH)))
        };
        if trace_bleed && component.area >= 8 {
            eprintln!(
                "{{\"event\":\"bleed-component\",\"left\":{},\"top\":{},\
                 \"right\":{},\"bottom\":{},\"area\":{},\"mean\":{mean:.2},\
                 \"crispness\":{crispness:.2},\"paper\":{paper},\"kept\":{kept}}}",
                component.left, component.top, component.right, component.bottom, component.area,
            );
        }
        kept
    });
    // A bleed rule that crosses a running head merges with the glyphs into
    // one component that the verdict above rightly keeps, so the merged
    // strike must be removed pixelwise: a bleed pixel is simultaneously
    // shallow and locally soft, while every genuine glyph pixel is either
    // deep (stroke interior) or crisp (antialiased edge). Erasing only the
    // pixels that fail both tests strips the strike and leaves the glyphs
    // it crossed intact.
    let stripped = BinaryImage::from_fn_parallel(retained.width(), retained.height(), |x, y| {
        let label = components.label_at(x, y) as usize;
        retained.get(x, y)
            && (underline_components[label]
                || raw.get(x, y) < shallow_floor
                || f64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)))
                    >= crispness_floor
                || protected_picture
                    .as_ref()
                    .is_some_and(|mask| mask.get(x, y)))
    });
    if trace_bleed {
        let mut erased = vec![0usize; components.components().len() + 1];
        for y in 0..retained.height() {
            for x in 0..retained.width() {
                if retained.get(x, y) && !stripped.get(x, y) {
                    erased[components.label_at(x, y) as usize] += 1;
                }
            }
        }
        for component in components.components() {
            let count = erased[component.label as usize];
            if count * 4 >= component.area.max(1) {
                eprintln!(
                    "{{\"event\":\"bleed-pixel-erase\",\"left\":{},\"top\":{},\
                     \"right\":{},\"bottom\":{},\"area\":{},\"erased\":{count}}}",
                    component.left,
                    component.top,
                    component.right,
                    component.bottom,
                    component.area,
                );
            }
        }
    }
    stripped
}

/// Reclaims only exact raw-dark pixels from a coherent horizontal rule that
/// survived source analysis but was absent from the binary input. This is a
/// narrow fallback for threshold loss; the primary preservation path exempts
/// rule-scale binary components from post-processing in `bw`.
fn restore_genuine_horizontal_rules(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> BinaryImage {
    // The previous implementation filled the bounding box of any qualifying
    // dark row band, INVENTING solid bars where the source has a thin rule or
    // an unmasked text row (fullbook p8 grew a fabricated thick header bar
    // plus a duplicate mid-page). This fallback never fills a bounding box:
    // it can only re-mark exact raw-dark component pixels.
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    debug_assert!(picture_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    if raw.width() == 0 || raw.height() == 0 {
        return binary.clone();
    }

    let paper = paper_reference(raw);
    let raw_dark_floor = paper.saturating_sub(RULE_RAW_DEPTH);
    let picture_owner = picture_mask.map(|mask| {
        let radius = picture_protection_radius(dpi);
        dilate(mask, radius, radius)
    });
    let raw_candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= raw_dark_floor
            && !picture_owner.as_ref().is_some_and(|mask| mask.get(x, y))
    });
    // A scanned rule thresholds into dashes, so candidacy is measured on a
    // horizontally bridged map; the pixels that are re-marked still come
    // exclusively from the unbridged raw candidates, keeping the
    // no-invention subset property exact.
    let bridge_radius = (dpi.max(1.0) * 1.5 / 25.4).round().max(2.0) as usize;
    let bridged = dilate(&raw_candidates, bridge_radius, 0);
    let components = ComponentMap::from_binary(&bridged);
    if components.components().is_empty() {
        return binary.clone();
    }

    let minimum_span = (dpi.max(1.0) * 15.0 / 25.4).round().max(24.0) as usize;
    let maximum_thickness = (dpi.max(1.0) * 4.0 / 25.4).round().max(2.0) as usize;
    let thin_thickness = (dpi.max(1.0) * 2.0 / 25.4).round().max(2.0) as usize;
    let maximum_text_gap = (dpi.max(1.0) * 14.0 / 25.4).round().max(8.0) as usize;
    let minimum_row_support = (minimum_span / 8).max(8);
    let mut rule_components = vec![false; components.components().len() + 1];
    for component in components.components() {
        let label = component.label as usize;
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let horizontal_rule = width >= minimum_span
            && width >= height.saturating_mul(4)
            && height <= maximum_thickness
            && (height <= thin_thickness || width >= height.saturating_mul(8))
            && component.area >= width;
        if !horizontal_rule {
            continue;
        }

        let overlaps_text = text_mask.is_some_and(|mask| {
            (component.top..=component.bottom).any(|y| {
                (component.left..=component.right)
                    .any(|x| raw_candidates.get(x, y) && mask.get(x, y))
            })
        });
        if overlaps_text {
            continue;
        }

        let text_row_above =
            (component.top.saturating_sub(maximum_text_gap)..component.top).any(|y| {
                (component.left..=component.right).any(|x| {
                    text_mask.is_some_and(|mask| mask.get(x, y))
                        || text_vicinity_mask.is_some_and(|mask| mask.get(x, y))
                })
            });
        let raw_row_above = if text_mask.is_none() && text_vicinity_mask.is_none() {
            (component.top.saturating_sub(maximum_text_gap)..component.top).any(|y| {
                (component.left..=component.right)
                    .filter(|&x| raw_candidates.get(x, y))
                    .count()
                    >= minimum_row_support
            })
        } else {
            false
        };
        rule_components[label] = text_row_above || raw_row_above;
    }

    // Band acceptance came from the bridged map; the marked pixels are the
    // intersection with the unbridged raw candidates, so every new black
    // pixel is dark in `raw` at that exact coordinate.
    let accepted_bands = components.retain(|component| rule_components[component.label as usize]);
    let restored = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        accepted_bands.get(x, y) && raw_candidates.get(x, y)
    });
    binary.or(&restored)
}

fn normalize_tone_to_paper(sample: u8, paper: u8) -> u8 {
    normalize_tone_to_paper_with_shoulder(sample, paper, 48.0)
}

/// Maps paper-level samples to white through a smooth shoulder while keeping
/// darker content proportional. Zone interiors use a narrower shoulder so a
/// producer-authored plate field or a map sea lifts to white while photo
/// midtones and highlights keep their separation.
fn normalize_tone_to_paper_with_shoulder(sample: u8, paper: u8, shoulder: f64) -> u8 {
    if paper == 0 || sample >= paper {
        return 255;
    }
    let paper = f64::from(paper);
    let value = f64::from(sample);
    let scaled = value * 255.0 / paper;
    let shoulder_low = (paper - shoulder).max(0.0);
    if value <= shoulder_low {
        return scaled.round().clamp(0.0, 255.0) as u8;
    }
    let t = ((value - shoulder_low) / (paper - shoulder_low).max(1.0)).clamp(0.0, 1.0);
    let paper_weight = 1.0 - (1.0 - t).powi(3);
    (scaled * (1.0 - paper_weight) + 255.0 * paper_weight)
        .round()
        .clamp(0.0, 255.0) as u8
}

/// Applies the render-space ownership rules for a fresh Mixed partition.
///
/// The halftone classifier's completed zone is an exact stencil exclusion,
/// even when a later text-vicinity pass sees dark pixels inside that zone.
/// Text ownership may still carve a broader picture mask everywhere outside
/// the exact zone; this keeps nearby body text in the high-resolution
/// foreground without allowing it to turn a completed tonal region into
/// bilevel output.
fn partition_mixed_picture_mask(
    picture_mask: &mut Option<BinaryImage>,
    spatial_tone_mask: Option<&BinaryImage>,
    chroma_picture_mask: Option<&BinaryImage>,
    tone_picture_mask: Option<&BinaryImage>,
    halftone_zone_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    text_line_count: usize,
) {
    if let Some(spatial_tone) = spatial_tone_mask {
        *picture_mask = Some(match picture_mask.take() {
            Some(picture) => picture.or(spatial_tone),
            None => spatial_tone.clone(),
        });
    }
    if let Some(zone) = halftone_zone_mask {
        *picture_mask = Some(match picture_mask.take() {
            Some(picture) => picture.or(zone),
            None => zone.clone(),
        });
    }

    let (Some(picture_mask), Some(text_vicinity)) = (picture_mask.as_mut(), text_vicinity_mask)
    else {
        return;
    };
    // Mixed is a representation partition: semantic text belongs to the
    // high-resolution foreground even when a coarse picture mask surrounds
    // it. Coherent tone and the exact classifier zone are exceptions: both
    // retain ownership in the continuous-tone layer.
    // A line detector deliberately publishes tight per-line rectangles. If a
    // coarse picture component also surrounds those lines, carving only the
    // rectangles leaves alternating gray and white bands between baselines.
    // Close vertically by one physical millimetre so neighboring lines form
    // one paper field without changing the outer line boundaries or growing
    // sideways into an adjacent photograph. The larger guarded bridge is
    // applied after the initial ownership exceptions so it sees the actual
    // surviving row fields, not candidates that a tone mask later removes.
    let interline_radius = (dpi.max(1.0) / 25.4).round().clamp(1.0, 32.0) as usize;
    let text_field = erode(
        &dilate(text_vicinity, 0, interline_radius),
        0,
        interline_radius,
    )
    .or(text_vicinity);
    let mut text_owned = chroma_picture_mask
        .map_or_else(|| text_field.clone(), |chroma| text_field.subtract(chroma));
    if let Some(tone) = tone_picture_mask {
        text_owned = text_owned.subtract(tone);
    }
    if let Some(zone) = halftone_zone_mask {
        text_owned = text_owned.subtract(zone);
    }
    // A repeated chain of surviving extra-wide row fields is stronger
    // text-column evidence than a narrow generic gray-paper band between
    // them. Chroma and completed halftone zones remain exact ownership
    // exceptions.
    bridge_aligned_text_rows(&mut text_owned, dpi);
    bridge_scanline_text_rows(&mut text_owned, dpi, text_line_count);
    if let Some(chroma) = chroma_picture_mask {
        text_owned = text_owned.subtract(chroma);
    }
    if let Some(zone) = halftone_zone_mask {
        text_owned = text_owned.subtract(zone);
    }
    *picture_mask = picture_mask.subtract(&text_owned);
}

/// Joins only a repeated chain of wide, vertically separated row fields.
///
/// The content detector can miss one or two low-contrast lines inside an
/// otherwise coherent text column. Requiring three aligned fields with
/// near-total horizontal overlap identifies a column pattern. A chain-global
/// intersection prevents a wide hub from joining two unrelated columns.
fn bridge_aligned_text_rows(text_field: &mut BinaryImage, dpi: f64) {
    #[derive(Clone, Copy)]
    struct RowField {
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
    }

    fn root(parents: &mut [usize], mut index: usize) -> usize {
        while parents[index] != index {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        index
    }

    fn union(parents: &mut [usize], left: usize, right: usize) {
        let left_root = root(parents, left);
        let right_root = root(parents, right);
        if left_root != right_root {
            parents[right_root] = left_root;
        }
    }

    let dpi = dpi.max(1.0);
    let minimum_width = (dpi * 30.0 / 25.4).round().max(1.0) as usize;
    let maximum_gap = (dpi * 9.0 / 25.4).round().max(1.0) as usize;
    let components = ComponentMap::from_binary(text_field);
    let mut rows = components
        .components()
        .iter()
        .filter_map(|component| {
            let width = component.right - component.left + 1;
            (width >= minimum_width).then_some(RowField {
                left: component.left,
                top: component.top,
                right: component.right,
                bottom: component.bottom,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_unstable_by_key(|row| row.top);
    if rows.len() < 3 {
        return;
    }

    let mut parents = (0..rows.len()).collect::<Vec<_>>();
    for (upper_index, upper) in rows.iter().enumerate() {
        for (lower_index, lower) in rows.iter().enumerate().skip(upper_index + 1) {
            if lower.top <= upper.bottom {
                continue;
            }
            let gap = lower.top - upper.bottom - 1;
            if gap > maximum_gap {
                break;
            }
            let left = upper.left.max(lower.left);
            let right = upper.right.min(lower.right);
            if right < left {
                continue;
            }
            let overlap = right - left + 1;
            let smaller_width = (upper.right - upper.left + 1).min(lower.right - lower.left + 1);
            if overlap.saturating_mul(5) >= smaller_width.saturating_mul(4) {
                union(&mut parents, upper_index, lower_index);
            }
        }
    }

    let mut chain_sizes = vec![0usize; rows.len()];
    let mut chain_left = vec![0usize; rows.len()];
    let mut chain_right = vec![usize::MAX; rows.len()];
    let mut chain_top = vec![usize::MAX; rows.len()];
    let mut chain_bottom = vec![0usize; rows.len()];
    for (index, row) in rows.iter().enumerate() {
        let chain_root = root(&mut parents, index);
        chain_sizes[chain_root] += 1;
        chain_left[chain_root] = chain_left[chain_root].max(row.left);
        chain_right[chain_root] = chain_right[chain_root].min(row.right);
        chain_top[chain_root] = chain_top[chain_root].min(row.top);
        chain_bottom[chain_root] = chain_bottom[chain_root].max(row.bottom);
    }
    for chain_root in 0..rows.len() {
        if chain_sizes[chain_root] < 3
            || chain_right[chain_root] < chain_left[chain_root]
            || chain_right[chain_root] - chain_left[chain_root] + 1 < minimum_width
        {
            continue;
        }
        for y in chain_top[chain_root]..=chain_bottom[chain_root] {
            for x in chain_left[chain_root]..=chain_right[chain_root] {
                text_field.set(x, y, true);
            }
        }
    }
}

/// Finds text-column chains that narrow vertical connectors hide from 2-D
/// connected-component analysis.
///
/// On dense pages, a preparatory tier repairs shorter row fragments using the
/// established 30 mm / 9 mm limits. A strict second tier permits the larger
/// measured gaps only when every field is at least 60 mm wide and shares 90%
/// of its span. Both fill one chain-global horizontal intersection, so a run
/// that drifts around an adjacent portrait cannot widen the text owner.
fn bridge_scanline_text_rows(text_field: &mut BinaryImage, dpi: f64, text_line_count: usize) {
    if text_line_count >= 20 {
        bridge_scanline_text_row_tier(text_field, dpi, 30.0, 0.35, 9.0, 4, 5);
        bridge_scanline_text_row_tier(text_field, dpi, 60.0, 1.0, 13.0, 9, 10);
    }
}

#[allow(clippy::too_many_arguments)]
fn bridge_scanline_text_row_tier(
    text_field: &mut BinaryImage,
    dpi: f64,
    minimum_width_mm: f64,
    minimum_height_mm: f64,
    maximum_gap_mm: f64,
    overlap_numerator: usize,
    overlap_denominator: usize,
) {
    #[derive(Clone, Copy)]
    struct RunBand {
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
    }

    fn root(parents: &mut [usize], mut index: usize) -> usize {
        while parents[index] != index {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        index
    }

    fn union(parents: &mut [usize], left: usize, right: usize) {
        let left_root = root(parents, left);
        let right_root = root(parents, right);
        if left_root != right_root {
            parents[right_root] = left_root;
        }
    }

    let dpi = dpi.max(1.0);
    let minimum_width = (dpi * minimum_width_mm / 25.4).round().max(1.0) as usize;
    let minimum_height = (dpi * minimum_height_mm / 25.4).round().max(1.0) as usize;
    let maximum_gap = (dpi * maximum_gap_mm / 25.4).round().max(1.0) as usize;
    let width = text_field.width();
    let height = text_field.height();
    if width < minimum_width || height < minimum_height {
        return;
    }

    // Track every simultaneous run independently. Matching against the
    // band's running intersection prevents a right-side portrait run from
    // being unioned into a left-side text column merely because their outer
    // bounding box overlaps.
    let mut active = Vec::<RunBand>::new();
    let mut finished = Vec::<RunBand>::new();
    for y in 0..height {
        let mut runs = Vec::<(usize, usize)>::new();
        let mut x = 0;
        while x < width {
            while x < width && !text_field.get(x, y) {
                x += 1;
            }
            let left = x;
            while x < width && text_field.get(x, y) {
                x += 1;
            }
            if x > left && x - left >= minimum_width {
                runs.push((left, x - 1));
            }
        }

        let mut used = vec![false; active.len()];
        let mut next = Vec::with_capacity(runs.len());
        for (left, right) in runs {
            let run_width = right - left + 1;
            let mut best = None;
            for (index, band) in active.iter().enumerate() {
                if used[index] || band.bottom + 1 != y {
                    continue;
                }
                let overlap_left = left.max(band.left);
                let overlap_right = right.min(band.right);
                if overlap_right < overlap_left {
                    continue;
                }
                let overlap = overlap_right - overlap_left + 1;
                let band_width = band.right - band.left + 1;
                let smaller_width = run_width.min(band_width);
                if overlap < minimum_width
                    || overlap.saturating_mul(overlap_denominator)
                        < smaller_width.saturating_mul(overlap_numerator)
                {
                    continue;
                }
                if best.is_none_or(|(_, best_overlap)| overlap > best_overlap) {
                    best = Some((index, overlap));
                }
            }
            if let Some((index, _)) = best {
                used[index] = true;
                let band = active[index];
                next.push(RunBand {
                    left: band.left.max(left),
                    top: band.top,
                    right: band.right.min(right),
                    bottom: y,
                });
            } else {
                next.push(RunBand {
                    left,
                    top: y,
                    right,
                    bottom: y,
                });
            }
        }
        finished.extend(
            active
                .into_iter()
                .zip(used)
                .filter_map(|(band, used)| (!used).then_some(band)),
        );
        active = next;
    }
    finished.extend(active);
    let mut bands = finished
        .into_iter()
        .filter(|band| band.bottom - band.top + 1 >= minimum_height)
        .collect::<Vec<_>>();
    bands.sort_unstable_by_key(|band| band.top);
    if bands.len() < 3 {
        return;
    }

    let mut parents = (0..bands.len()).collect::<Vec<_>>();
    for (upper_index, upper) in bands.iter().enumerate() {
        for (lower_index, lower) in bands.iter().enumerate().skip(upper_index + 1) {
            if lower.top <= upper.bottom {
                continue;
            }
            let gap = lower.top - upper.bottom - 1;
            if gap > maximum_gap {
                break;
            }
            let left = upper.left.max(lower.left);
            let right = upper.right.min(lower.right);
            if right < left {
                continue;
            }
            let overlap = right - left + 1;
            let smaller_width = (upper.right - upper.left + 1).min(lower.right - lower.left + 1);
            if overlap >= minimum_width
                && overlap.saturating_mul(overlap_denominator)
                    >= smaller_width.saturating_mul(overlap_numerator)
            {
                union(&mut parents, upper_index, lower_index);
            }
        }
    }

    let mut chain_sizes = vec![0usize; bands.len()];
    let mut chain_left = vec![0usize; bands.len()];
    let mut chain_right = vec![usize::MAX; bands.len()];
    let mut chain_top = vec![usize::MAX; bands.len()];
    let mut chain_bottom = vec![0usize; bands.len()];
    for (index, band) in bands.iter().enumerate() {
        let chain_root = root(&mut parents, index);
        chain_sizes[chain_root] += 1;
        chain_left[chain_root] = chain_left[chain_root].max(band.left);
        chain_right[chain_root] = chain_right[chain_root].min(band.right);
        chain_top[chain_root] = chain_top[chain_root].min(band.top);
        chain_bottom[chain_root] = chain_bottom[chain_root].max(band.bottom);
    }
    for chain_root in 0..bands.len() {
        if chain_sizes[chain_root] < 3
            || chain_right[chain_root] < chain_left[chain_root]
            || chain_right[chain_root] - chain_left[chain_root] + 1 < minimum_width
        {
            continue;
        }
        for y in chain_top[chain_root]..=chain_bottom[chain_root] {
            for x in chain_left[chain_root]..=chain_right[chain_root] {
                text_field.set(x, y, true);
            }
        }
    }
}

fn can_reuse_source_mrc_foreground(
    options: &CleanupOptions,
    trusted_foreground_mask: Option<&BinaryImage>,
    picture_mask: &BinaryImage,
    split: &SplitResult,
    half: PageHalf,
    deskew_applied: bool,
    dewarp_applied: bool,
    create_layers: bool,
) -> bool {
    options.trusted_mrc_source_available
        && trusted_foreground_mask.is_some()
        && picture_mask.count_black() > 0
        && create_layers
        && options.source_has_bilevel_layer
        && !options.trusted_selection_incomplete
        && options.manual_zones.picture.is_empty()
        && options.manual_zones.fill.is_empty()
        && options.thickness == 0
        && options.rotation == OrthogonalRotation::None
        && options
            .manual_skew_degrees
            .is_none_or(|degrees| degrees.abs() <= f64::EPSILON)
        && !deskew_applied
        && !dewarp_applied
        && split.classification == LayoutClassification::SingleUncutPage
        && half == PageHalf::Full
}

#[allow(clippy::too_many_arguments)]
fn clean_region(
    source: &GrayImage,
    routing_source: &GrayImage,
    normalized: &GrayImage,
    analysis_normalized: &GrayImage,
    analysis_scale_x: f64,
    analysis_scale_y: f64,
    calibration: PageCalibration,
    color_source: Option<&RgbImage>,
    analysis_picture_mask: Option<&BinaryImage>,
    source_picture_mask: Option<&BinaryImage>,
    halftone_zone_mask: Option<&BinaryImage>,
    spatial_tone_mask: Option<&BinaryImage>,
    chroma_picture_mask: Option<&BinaryImage>,
    tone_picture_mask: Option<&BinaryImage>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    tone_preservation_alpha: Option<&GrayImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    trusted_foreground_mask: Option<&BinaryImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    split: &SplitResult,
    region: Rect,
    half: PageHalf,
    cache: Option<&PageCache>,
    split_cache_key: Option<&StageCacheKey>,
    source_effectively_blank: bool,
    create_mixed_layers: bool,
    create_mixed_composite: bool,
    timings: &mut PageStageTimings,
) -> Result<CleanupResult, String> {
    let working_width = region.width.round().max(1.0) as usize;
    let working_height = region.height.round().max(1.0) as usize;
    let analysis_region = Rect::new(
        region.x * analysis_scale_x,
        region.y * analysis_scale_y,
        region.width * analysis_scale_x,
        region.height * analysis_scale_y,
    );
    let analysis_working = crop_gray(analysis_normalized, analysis_region);
    let analysis_picture_working =
        analysis_picture_mask.map(|mask| crop_binary(mask, analysis_region));
    let tone_picture_working = tone_picture_mask.map(|mask| crop_binary(mask, analysis_region));
    let text_working = text_mask.map(|mask| crop_binary(mask, analysis_region));
    let text_vicinity_working = text_vicinity_mask.map(|mask| crop_binary(mask, analysis_region));
    let text_tone_diagnostics = if matches!(
        options.output_mode,
        OutputMode::Grayscale | OutputMode::Mixed
    ) {
        options
            .resolved_text_tone_diagnostics
            .for_half(half)
            .or_else(|| {
                text_working
                    .as_ref()
                    .zip(text_vicinity_working.as_ref())
                    .map(|(text_mask, text_vicinity_mask)| {
                        let empty_picture_mask;
                        let picture_mask = if let Some(mask) = tone_picture_working.as_ref() {
                            mask
                        } else {
                            empty_picture_mask = BinaryImage::new(
                                analysis_working.width(),
                                analysis_working.height(),
                            );
                            &empty_picture_mask
                        };
                        derive_text_tone_diagnostics(
                            &analysis_working,
                            text_mask,
                            text_vicinity_mask,
                            picture_mask,
                        )
                    })
            })
    } else {
        None
    };
    let local_scale_x = analysis_working.width() as f64 / working_width.max(1) as f64;
    let local_scale_y = analysis_working.height() as f64 / working_height.max(1) as f64;
    let deskew_key = cache
        .zip(split_cache_key)
        .map(|(cache, split_key)| StageCacheKey::deskew(&cache.source, options, split_key, region));
    let deskew_started = Instant::now();
    let deskew = if let Some(angle_degrees) = options
        .manual_skew_degrees
        .or_else(|| options.automatic_skew_for(half))
    {
        DeskewResult {
            angle_degrees,
            confidence: 1.0,
            accepted: true,
        }
    } else {
        cache
            .zip(deskew_key.as_ref())
            .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<DeskewResult>(key))
            .map_or_else(
                || {
                    let result = detect_skew(&analysis_working, calibration.effective_dpi);
                    if let (Some(cache), Some(key)) = (cache, deskew_key.clone()) {
                        if let Ok(mut shared) = cache.shared.lock() {
                            shared.insert(
                                key,
                                Arc::new(result),
                                std::mem::size_of::<DeskewResult>(),
                            );
                        }
                    }
                    result
                },
                |cached| *cached,
            )
    };
    timings.deskew_ms += deskew_started.elapsed().as_secs_f64() * 1_000.0;
    let local_deskew_forward = deskew_transform(working_width, working_height, deskew);
    let local_deskew_inverse = local_deskew_forward
        .inverse()
        .ok_or("Deskew transform is not invertible")?;
    let analysis_deskew_forward =
        deskew_transform(analysis_working.width(), analysis_working.height(), deskew);
    let analysis_deskew_inverse = analysis_deskew_forward
        .inverse()
        .ok_or("Cleanup analysis deskew transform is not invertible")?;
    let automatic_dewarp = if options.dewarp.is_none() && options.experimental.auto_dewarp {
        // Curve detection is designed for the ~200-DPI working scale; handing
        // it the full-resolution crop together with the capped analysis DPI
        // made its internal downscale a no-op and ran thresholding, labeling
        // and snake tracing on the full raster. Detect on the analysis-scale
        // crop and map the curves back into region coordinates.
        let mut detected = detect_curves_at_dpi_with_depth(
            &analysis_working,
            calibration.effective_dpi,
            options.experimental.auto_dewarp_depth,
        );
        detected.model = detected.model.map(|model| {
            transform_dewarp_options(
                &model,
                Affine::scaling(
                    1.0 / local_scale_x.max(f64::EPSILON),
                    1.0 / local_scale_y.max(f64::EPSILON),
                )
                .then(Affine::translation(region.x, region.y)),
            )
        });
        Some(detected)
    } else {
        None
    };
    let deskewed_analysis = if deskew.accepted {
        render_affine_gray(
            &analysis_working,
            analysis_working.width(),
            analysis_working.height(),
            analysis_deskew_inverse,
        )
    } else {
        analysis_working
    };
    let deskewed_picture_mask = analysis_picture_working.map(|mask| {
        if deskew.accepted {
            render_binary_mask(&mask, mask.width(), mask.height(), |point| {
                Some(analysis_deskew_inverse.apply(point))
            })
        } else {
            mask
        }
    });
    let source_rotated_to_deskewed =
        Affine::translation(-region.x, -region.y).then(local_deskew_forward);
    let candidate_dewarp = options.dewarp.clone().or_else(|| {
        automatic_dewarp
            .as_ref()
            .and_then(|result| result.model.clone())
    });
    let transformed_dewarp = candidate_dewarp
        .as_ref()
        .map(|model| transform_dewarp_options(model, source_rotated_to_deskewed));
    let dewarp_model = if options.dewarp.is_some() {
        transformed_dewarp
            .as_ref()
            .map(DewarpModel::from_options)
            .transpose()
            .map_err(|error| error.to_string())?
    } else {
        transformed_dewarp
            .as_ref()
            .and_then(|model| DewarpModel::from_options(model).ok())
    };
    let effective_dewarp = dewarp_model.as_ref().and(candidate_dewarp);
    let dewarped_analysis = dewarp_model.as_ref().map(|model| {
        let width = deskewed_analysis.width();
        let height = deskewed_analysis.height();
        rasterize_inverse_area_with(&deskewed_analysis, width, height, |point| {
            model
                .map_unit_to_source(point.x / width as f64, point.y / height as f64)
                .map(|mapped| Point::new(mapped.x * local_scale_x, mapped.y * local_scale_y))
        })
    });
    let dewarped_picture_mask = dewarp_model.as_ref().and_then(|model| {
        deskewed_picture_mask.as_ref().map(|mask| {
            let width = mask.width();
            let height = mask.height();
            render_binary_mask(mask, width, height, |point| {
                model
                    .map_unit_to_source(point.x / width as f64, point.y / height as f64)
                    .map(|mapped| Point::new(mapped.x * local_scale_x, mapped.y * local_scale_y))
            })
        })
    });
    let content_analysis = dewarped_analysis.as_ref().unwrap_or(&deskewed_analysis);
    let content_picture_mask = dewarped_picture_mask
        .as_ref()
        .or(deskewed_picture_mask.as_ref());
    let content_key = cache.zip(deskew_key.as_ref()).map(|(cache, deskew_key)| {
        StageCacheKey::content(&cache.source, options, deskew_key, half)
    });
    let content_started = Instant::now();
    let cached_content = cache
        .zip(content_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<CachedContentDetection>(key));
    // A source-level blank verdict is deliberately independent of the
    // selected output encoding. Auto mode may already have been resolved by
    // document detection (for example to grayscale) before final rendering.
    // Letting continuous-tone modes run content detection again made the
    // 150-DPI preview white while a source-DPI final render promoted the same
    // paper texture into false content. Manual content/picture/fill zones have
    // already vetoed this verdict in prepare_analysis_page.
    let force_clean_blank = source_effectively_blank;
    let detected = if force_clean_blank {
        CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        }
    } else if let Some(cached) = cached_content {
        cached.as_ref().clone()
    } else {
        let detected = if let Some(manual) =
            options.resolved_content_for(half, normalized.width(), normalized.height())
        {
            let left = manual.x.clamp(0.0, working_width.saturating_sub(1) as f64);
            let top = manual.y.clamp(0.0, working_height.saturating_sub(1) as f64);
            let right = manual.right().clamp(left + 1.0, working_width as f64);
            let bottom = manual.bottom().clamp(top + 1.0, working_height as f64);
            let source_content = Rect::new(left, top, right - left, bottom - top);
            let deskewed_content = transform_rect_bounds(source_content, local_deskew_forward);
            let output_content = if let Some(model) = &dewarp_model {
                map_rect_bounds(deskewed_content, |point| {
                    model.map_source_to_unit_approx(point).map(|unit| {
                        Point::new(
                            unit.x * working_width as f64,
                            unit.y * working_height as f64,
                        )
                    })
                })
                .ok_or("Manual content box cannot be mapped through the dewarp model")?
            } else {
                deskewed_content
            };
            CachedContentDetection {
                detected_content: Some(output_content),
                source_content_box: Some(source_content),
                diagnostics: None,
            }
        } else {
            if let Some(dir) = std::env::var_os("EVB_SCAN_CLEANUP_DUMP_CONTENT_INPUT") {
                let path = std::path::Path::new(&dir)
                    .join(format!("content-input-{source_page_index}.pgm"));
                let _ = crate::io::raster::write_gray_pgm_atomic(&path, content_analysis);
            }
            let detected_result = detect_content_and_margins_calibrated(
                content_analysis,
                content_picture_mask,
                calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                calibration,
            );
            if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_CONTENT").is_some() {
                eprintln!(
                    "{{\"event\":\"content-call\",\"page\":{source_page_index},\"dpi\":{},\"pictureMask\":{},\"detected\":{:?}}}",
                    calibration.effective_dpi,
                    content_picture_mask.is_some(),
                    detected_result.content,
                );
            }
            let detected_content = detected_result.content.map(|rect| {
                Rect::new(
                    rect.x / local_scale_x,
                    rect.y / local_scale_y,
                    rect.width / local_scale_x,
                    rect.height / local_scale_y,
                )
            });
            let source_content_box = detected_content.and_then(|rect| {
                if let Some(model) = &dewarp_model {
                    map_rect_bounds(rect, |point| {
                        model
                            .map_unit_to_source(
                                point.x / working_width as f64,
                                point.y / working_height as f64,
                            )
                            .map(|deskewed| local_deskew_inverse.apply(deskewed))
                    })
                } else {
                    Some(transform_rect_bounds(rect, local_deskew_inverse))
                }
            });
            CachedContentDetection {
                detected_content,
                source_content_box,
                diagnostics: detected_result.diagnostics,
            }
        };
        if let (Some(cache), Some(key)) = (cache, content_key) {
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(
                    key,
                    Arc::new(detected.clone()),
                    std::mem::size_of::<CachedContentDetection>(),
                );
            }
        }
        detected
    };
    timings.content_ms += content_started.elapsed().as_secs_f64() * 1_000.0;
    if options.match_page_size {
        // See the analysis path above: placement owns matched margins, while
        // the renderer still rejects arithmetic that could not be represented.
        content_result_for_dimensions(
            working_width,
            working_height,
            options.dpi,
            detected.detected_content,
            options.margins_mm.map(crate::MarginsMm::values),
            options.margins_pixels,
        )?;
    }
    let content = content_result_for_dimensions(
        working_width,
        working_height,
        options.dpi,
        detected.detected_content,
        if options.match_page_size {
            None
        } else {
            options.margins_mm.map(crate::MarginsMm::values)
        },
        if options.match_page_size {
            Some([0.0; 4])
        } else {
            options.margins_pixels
        },
    )?;
    let source_content_box = detected.source_content_box;
    let content_diagnostics = detected.diagnostics;
    let crop_enabled = options.crop_content && !options.ocr_mode && content.content.is_some();
    let output_rect = if crop_enabled {
        content.output_rect
    } else {
        Rect::new(0.0, 0.0, working_width as f64, working_height as f64)
    };
    let (output_width, output_height) =
        options.validate_derived_raster_dimensions(output_rect.width, output_rect.height)?;
    let render_region = options.resolved_render_crop(output_width, output_height);
    // Local threshold windows and connected-component cleanup need context
    // beyond the visible tile. Sample a bounded apron, process it, then trim
    // back to render_region so panning cannot change interior stroke weight.
    let sampled_region = render_region.map(|crop| {
        if matches!(options.output_mode, OutputMode::Bw | OutputMode::Mixed) {
            const PROCESSING_APRON_PX: f64 = 256.0;
            let left = (crop.x - PROCESSING_APRON_PX).max(0.0);
            let top = (crop.y - PROCESSING_APRON_PX).max(0.0);
            let right = (crop.right() + PROCESSING_APRON_PX).min(output_width as f64);
            let bottom = (crop.bottom() + PROCESSING_APRON_PX).min(output_height as f64);
            Rect::new(left, top, right - left, bottom - top)
        } else {
            crop
        }
    });
    let render_rect = sampled_region.map_or(output_rect, |crop| {
        Rect::new(
            output_rect.x + crop.x,
            output_rect.y + crop.y,
            crop.width,
            crop.height,
        )
    });
    let render_plan = ComposedRenderPlan::new(
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model.clone(),
        working_width,
        working_height,
        render_rect,
    );
    let rendered_width = render_plan.output_width();
    let rendered_height = render_plan.output_height();

    let render_started = Instant::now();
    let rasterization_started = Instant::now();
    // A colour page publishes its RGB raster; the gray twin is never encoded, so
    // the only question it answered — blankness — moves to the analysis level.
    let skips_gray_twin = options.output_mode == OutputMode::Color
        && color_source.is_some()
        && !render_plan.has_dewarp();
    let (mut rendered_gray, rendered_color, forward_transform, inverse_transform, dewarp_mapping) =
        if render_plan.has_dewarp() {
            let gray =
                rasterize_inverse_area_with(normalized, rendered_width, rendered_height, |point| {
                    render_plan.output_to_source(point)
                });
            let color = color_source.map(|source| {
                rasterize_inverse_area_rgb_with(source, rendered_width, rendered_height, |point| {
                    render_plan.output_to_source(point)
                })
            });
            let metadata_plan = render_region.map_or_else(
                || render_plan.clone(),
                |crop| {
                    ComposedRenderPlan::new(
                        region,
                        local_deskew_forward,
                        local_deskew_inverse,
                        dewarp_model,
                        working_width,
                        working_height,
                        Rect::new(
                            output_rect.x + crop.x,
                            output_rect.y + crop.y,
                            crop.width,
                            crop.height,
                        ),
                    )
                },
            );
            let grid = sampled_dewarp_grid(&metadata_plan, region);
            (gray, color, None, None, Some(grid))
        } else {
            let inverse = render_plan
                .affine_inverse()
                .ok_or("Cleanup affine render plan is unavailable")?;
            let forward = inverse
                .inverse()
                .ok_or("Cleanup transform is not invertible")?;
            (
                if skips_gray_twin {
                    GrayImage::new(rendered_width, rendered_height, 255)
                } else {
                    render_affine_gray(normalized, rendered_width, rendered_height, inverse)
                },
                color_source.map(|color| {
                    render_affine_rgb(color, rendered_width, rendered_height, inverse)
                }),
                Some(forward),
                Some(inverse),
                None,
            )
        };
    let rendered_source_gray = if render_plan.has_dewarp() {
        rasterize_inverse_area_with(routing_source, rendered_width, rendered_height, |point| {
            render_plan.output_to_source(point)
        })
    } else {
        render_affine_gray(
            routing_source,
            rendered_width,
            rendered_height,
            render_plan
                .affine_inverse()
                .expect("cleanup affine render plan is available"),
        )
    };
    timings.rasterization_ms += rasterization_started.elapsed().as_secs_f64() * 1_000.0;
    // Coarse tonal evidence is valid for deriving the global tone curve, but
    // only pixel-resolution picture geometry may form a boundary in the
    // rendered raster.
    let mut rendered_tone_alpha = tone_preservation_alpha.map(|alpha| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            alpha.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            alpha.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_gray_field(alpha, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    if let Some(diagnostics) = text_tone_diagnostics {
        apply_text_tone_excluding(
            &mut rendered_gray,
            diagnostics,
            rendered_tone_alpha.as_ref(),
        );
    }
    let (forward_transform, inverse_transform) =
        if let (Some(forward), Some(region)) = (forward_transform, sampled_region) {
            let intrinsic_forward = forward.then(Affine::translation(region.x, region.y));
            (Some(intrinsic_forward), intrinsic_forward.inverse())
        } else {
            (forward_transform, inverse_transform)
        };
    let mask_rasterization_started = Instant::now();
    let mut rendered_picture_mask = source_picture_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_halftone_zone_mask = halftone_zone_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_spatial_tone_mask = spatial_tone_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_chroma_picture_mask = chroma_picture_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    // Keep calibrated tone zones as geometry in render space. The alpha field
    // is useful for semantic protection, but it is not a complete layer
    // boundary: a bimodal photo or map can have low alpha over a valid
    // midtone region. Fresh Mixed composition must still own that region from
    // the cleaned raster rather than whitening it as unclassified paper.
    let rendered_tone_picture_mask = tone_picture_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_text_vicinity_mask = text_vicinity_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_text_mask = text_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan
                .output_to_source(point)
                .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
        })
    });
    let rendered_trusted_foreground_mask = trusted_foreground_mask.map(|mask| {
        let mask_scale_x = if normalized.width() <= 1 {
            0.0
        } else {
            mask.width().saturating_sub(1) as f64 / normalized.width().saturating_sub(1) as f64
        };
        let mask_scale_y = if normalized.height() <= 1 {
            0.0
        } else {
            mask.height().saturating_sub(1) as f64 / normalized.height().saturating_sub(1) as f64
        };
        render_binary_mask_preserve_ink(
            mask,
            rendered_width,
            rendered_height,
            mask_scale_x,
            mask_scale_y,
            |point| {
                render_plan
                    .output_to_source(point)
                    .map(|source| Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
            },
        )
    });
    if options.output_mode == OutputMode::Mixed {
        partition_mixed_picture_mask(
            &mut rendered_picture_mask,
            rendered_spatial_tone_mask.as_ref(),
            rendered_chroma_picture_mask.as_ref(),
            rendered_tone_picture_mask.as_ref(),
            rendered_halftone_zone_mask.as_ref(),
            rendered_text_vicinity_mask.as_ref(),
            options.dpi,
            text_tone_diagnostics.map_or(0, |diagnostics| diagnostics.text_line_count),
        );
    }
    timings.mask_rasterization_ms += mask_rasterization_started.elapsed().as_secs_f64() * 1_000.0;
    let output_processing_started = Instant::now();
    let effectively_blank = source_effectively_blank
        || if skips_gray_twin {
            is_effectively_blank(content_analysis, calibration.effective_dpi)
        } else {
            is_effectively_blank(&rendered_gray, options.dpi)
        };
    let fail_closed_blank = force_clean_blank || content.content.is_none() && effectively_blank;
    // Whole-page abstention guarded against the old destructive whitening.
    // Picture zones now preserve continuous tone exactly while everything
    // else is smoothly normalized toward white, so cleanup is always safe and
    // every page keeps the white-paper contract. The flags and metadata fields
    // remain protocol-compatible markers; fresh output never sets them.
    let trusted_selection_applied = rendered_trusted_foreground_mask.is_some();
    let trusted_mrc_background_preserved = false;
    let mut ink_consistency_diagnostics = None;
    let (
        mut image,
        mut color_image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mut mixed_layers,
    ) = if fail_closed_blank {
        (
            if matches!(options.output_mode, OutputMode::Bw | OutputMode::Mixed) {
                CleanupRaster::Bilevel(BinaryImage::new(rendered_width, rendered_height))
            } else {
                CleanupRaster::Gray(GrayImage::new(rendered_width, rendered_height, 255))
            },
            if options.output_mode == OutputMode::Color && rendered_color.is_some() {
                Some(RgbImage::new(rendered_width, rendered_height, [255; 3]))
            } else {
                None
            },
            None,
            None,
            false,
            None,
        )
    } else {
        match options.output_mode {
            OutputMode::Bw => {
                let routing_sample = crop_gray_to_fit(routing_source, region, 256, 256);
                let routing_diagnostics =
                    resolve_binarization_diagnostics(&routing_sample, options);
                let mode = routing_diagnostics.route;
                let complete_trusted_foreground =
                    rendered_trusted_foreground_mask.as_ref().filter(|_| {
                        options.source_has_bilevel_layer && !options.trusted_selection_incomplete
                    });
                if let Some(trusted_foreground) = complete_trusted_foreground {
                    let trusted_foreground = options.page_ink_consistency.map_or_else(
                        || trusted_foreground.clone(),
                        |context| {
                            let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
                                trusted_foreground,
                                &rendered_source_gray,
                                rendered_picture_mask.as_ref(),
                                context,
                                normalized.width(),
                                normalized.height(),
                                options.dpi,
                            );
                            ink_consistency_diagnostics = Some(diagnostics);
                            stabilized
                        },
                    );
                    (
                        CleanupRaster::Bilevel(trusted_foreground),
                        None,
                        Some(mode),
                        Some(routing_diagnostics),
                        false,
                        None,
                    )
                } else {
                    let global_threshold_source =
                        (mode == crate::BinarizationMode::Otsu).then_some(&rendered_source_gray);
                    let binarization_started = Instant::now();
                    let (fresh_binary, diagnostics, fresh_despeckle_fallback, stage_timings) =
                        binarize_normalized_with_diagnostics(
                            &rendered_gray,
                            &rendered_source_gray,
                            &routing_sample,
                            global_threshold_source,
                            options,
                            calibration,
                            rendered_picture_mask.as_ref(),
                            rendered_text_vicinity_mask.as_ref(),
                        );
                    timings.threshold_preparation_ms += stage_timings.preparation_ms;
                    timings.thresholding_ms += stage_timings.thresholding_ms;
                    timings.binary_postprocess_ms += stage_timings.postprocess_ms;
                    timings.binarization_ms +=
                        binarization_started.elapsed().as_secs_f64() * 1_000.0;
                    let reusable = split.reusable_binary.as_ref().filter(|binary| {
                        mode == crate::BinarizationMode::Otsu
                            && options.thickness == 0
                            && !deskew.accepted
                            && effective_dewarp.is_none()
                            && !crop_enabled
                            && region.x == 0.0
                            && region.y == 0.0
                            && region.width == normalized.width() as f64
                            && region.height == normalized.height() as f64
                            && binary.width() == rendered_gray.width()
                            && binary.height() == rendered_gray.height()
                    });
                    let (binary, despeckle_fallback) = if let Some(binary) = reusable {
                        postprocess_binary_with_diagnostics_and_raw(
                            binary,
                            Some(&rendered_gray),
                            Some(&rendered_source_gray),
                            options,
                            calibration,
                        )
                    } else {
                        (fresh_binary, fresh_despeckle_fallback)
                    };
                    let binary = restore_genuine_horizontal_rules(
                        &binary,
                        &rendered_source_gray,
                        rendered_picture_mask.as_ref(),
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = filter_soft_shallow_bleed_components(
                        &binary,
                        &rendered_source_gray,
                        rendered_picture_mask.as_ref(),
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = enforce_source_ink_support(
                        binary,
                        &rendered_source_gray,
                        rendered_trusted_foreground_mask.as_ref(),
                        options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
                        options.dpi,
                    );
                    (
                        CleanupRaster::Bilevel(binary),
                        None,
                        Some(mode),
                        Some(diagnostics),
                        despeckle_fallback,
                        None,
                    )
                }
            }
            OutputMode::Mixed => {
                let picture_mask = rendered_picture_mask
                    .as_ref()
                    .expect("mixed output prepares a picture mask");
                if picture_mask.count_black() == 0 {
                    let routing_sample = crop_gray_to_fit(routing_source, region, 256, 256);
                    let route = resolve_binarization_diagnostics(&routing_sample, options).route;
                    let global_threshold_source =
                        (route == crate::BinarizationMode::Otsu).then_some(&rendered_source_gray);
                    let binarization_started = Instant::now();
                    let (binary, diagnostics, despeckle_fallback, stage_timings) =
                        binarize_normalized_with_diagnostics(
                            &rendered_gray,
                            &rendered_source_gray,
                            &routing_sample,
                            global_threshold_source,
                            options,
                            calibration,
                            rendered_picture_mask.as_ref(),
                            rendered_text_vicinity_mask.as_ref(),
                        );
                    timings.threshold_preparation_ms += stage_timings.preparation_ms;
                    timings.thresholding_ms += stage_timings.thresholding_ms;
                    timings.binary_postprocess_ms += stage_timings.postprocess_ms;
                    timings.binarization_ms +=
                        binarization_started.elapsed().as_secs_f64() * 1_000.0;
                    let mode = diagnostics.route;
                    let binary = restore_genuine_horizontal_rules(
                        &binary,
                        &rendered_source_gray,
                        None,
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = filter_soft_shallow_bleed_components(
                        &binary,
                        &rendered_source_gray,
                        None,
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = enforce_source_ink_support(
                        binary,
                        &rendered_source_gray,
                        rendered_trusted_foreground_mask.as_ref(),
                        options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
                        options.dpi,
                    );
                    (
                        CleanupRaster::Bilevel(binary),
                        None,
                        Some(mode),
                        Some(diagnostics),
                        despeckle_fallback,
                        None,
                    )
                } else {
                    // Mixed pages are uncommon and their picture-excluding route is
                    // resolved inside the binarizer. Keep a geometry-matched raw
                    // tone field available so a global route preserves the scan's
                    // original glyph boundary. Adaptive routes ignore this field.
                    let global_threshold_source = &rendered_source_gray;
                    let binarization_started = Instant::now();
                    let (binary, diagnostics, despeckle_fallback, stage_timings) =
                        binarize_normalized_with_diagnostics_excluding(
                            &rendered_gray,
                            &rendered_source_gray,
                            Some(global_threshold_source),
                            options,
                            calibration,
                            picture_mask,
                            rendered_text_vicinity_mask.as_ref(),
                        );
                    timings.threshold_preparation_ms += stage_timings.preparation_ms;
                    timings.thresholding_ms += stage_timings.thresholding_ms;
                    timings.binary_postprocess_ms += stage_timings.postprocess_ms;
                    timings.binarization_ms +=
                        binarization_started.elapsed().as_secs_f64() * 1_000.0;
                    let mode = diagnostics.route;
                    let composition_started = Instant::now();
                    // Semantic text recall may not reclaim pixels that the
                    // representation has already assigned to a picture or an
                    // independent-chroma plate. Red seals and map fills can
                    // look text-like; OR-ing the raw text mask here painted
                    // them into the black stencil and then whitened them out
                    // of the continuous-tone background.
                    let mut binary = rendered_text_mask
                        .as_ref()
                        .map_or(binary.clone(), |text_mask| {
                            binary.or(&text_mask.subtract(picture_mask))
                        });
                    if matches!(
                        options.binarization,
                        crate::BinarizationMode::Auto | crate::BinarizationMode::Otsu
                    ) {
                        binary = binary.or(&rescue_isolated_raw_ink(
                            &rendered_source_gray,
                            picture_mask,
                            options.dpi,
                        ));
                    }
                    let (binary, removed_edge_bands) = suppress_scanner_edge_bands(
                        &binary,
                        &rendered_gray,
                        picture_mask,
                        rendered_text_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = restore_genuine_horizontal_rules(
                        &binary,
                        &rendered_source_gray,
                        Some(picture_mask),
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    let binary = filter_soft_shallow_bleed_components(
                        &binary,
                        &rendered_source_gray,
                        Some(picture_mask),
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                    );
                    // Producer MRC selections are excellent glyph evidence,
                    // but they can also contain dark samples from photographs
                    // and reliefs. The Mixed partition is authoritative: a
                    // trusted selection may restore text only outside the
                    // calibrated continuous-tone ownership mask.
                    let trusted_text_foreground = trusted_mixed_foreground(
                        rendered_trusted_foreground_mask.as_ref(),
                        picture_mask,
                    );
                    let binary = enforce_source_ink_support(
                        binary,
                        &rendered_source_gray,
                        trusted_text_foreground.as_ref(),
                        options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
                        options.dpi,
                    );
                    let reuse_source_mrc_foreground = can_reuse_source_mrc_foreground(
                        options,
                        rendered_trusted_foreground_mask.as_ref(),
                        picture_mask,
                        split,
                        half,
                        deskew.accepted && deskew.angle_degrees.abs() > f64::EPSILON,
                        effective_dewarp.is_some(),
                        create_mixed_layers,
                    );
                    let (mixed_gray, mixed_color, layers) = compose_mixed(
                        &rendered_gray,
                        Some(&rendered_source_gray),
                        rendered_color.as_ref(),
                        &binary,
                        picture_mask,
                        rendered_chroma_picture_mask.as_ref(),
                        Some(&removed_edge_bands),
                        rendered_text_mask.as_ref(),
                        rendered_text_vicinity_mask.as_ref(),
                        options.dpi,
                        preserve_confirmed_photo_tones,
                        use_soft_alpha_foreground,
                        create_mixed_layers,
                        create_mixed_composite,
                    );
                    let layers = layers.map(|mut layers| {
                        layers.source_mrc = reuse_source_mrc_foreground;
                        layers
                    });
                    timings.mixed_composition_ms +=
                        composition_started.elapsed().as_secs_f64() * 1_000.0;
                    (
                        CleanupRaster::Gray(mixed_gray),
                        mixed_color,
                        Some(mode),
                        Some(diagnostics),
                        despeckle_fallback,
                        layers,
                    )
                }
            }
            OutputMode::Grayscale => (
                CleanupRaster::Gray(rendered_gray),
                None,
                None,
                None,
                false,
                None,
            ),
            OutputMode::Color => {
                let color_layers = create_mixed_layers
                    .then(|| {
                        rendered_color.as_ref().map(|color| MixedLayers {
                            // A fresh Color page has no separate ink owner.
                            // Publishing an empty stencil beside the fresh
                            // color raster lets the assembler use its compact
                            // layered JPEG handoff without implying source-
                            // layer identity.
                            foreground_mask: BinaryImage::new(rendered_width, rendered_height),
                            foreground_alpha: None,
                            background: rendered_gray.clone(),
                            color_background: Some(color.clone()),
                            source_mrc: false,
                        })
                    })
                    .flatten();
                (
                    CleanupRaster::Gray(rendered_gray),
                    rendered_color,
                    None,
                    None,
                    false,
                    color_layers,
                )
            }
            OutputMode::Auto => unreachable!("automatic output mode is resolved before render"),
        }
    };
    if let (Some(requested), Some(sampled)) = (render_region, sampled_region) {
        let payload_rect = Rect::new(
            requested.x - sampled.x,
            requested.y - sampled.y,
            requested.width,
            requested.height,
        );
        image = image.cropped(payload_rect);
        color_image = color_image.map(|source| crop_rgb(&source, payload_rect));
        rendered_picture_mask = rendered_picture_mask.map(|mask| crop_binary(&mask, payload_rect));
        rendered_tone_alpha = rendered_tone_alpha.map(|alpha| crop_gray(&alpha, payload_rect));
        mixed_layers = mixed_layers.map(|layers| MixedLayers {
            foreground_mask: crop_binary(&layers.foreground_mask, payload_rect),
            foreground_alpha: layers
                .foreground_alpha
                .map(|alpha| crop_gray(&alpha, payload_rect)),
            background: crop_gray(&layers.background, payload_rect),
            color_background: layers
                .color_background
                .map(|source| crop_rgb(&source, payload_rect)),
            source_mrc: layers.source_mrc,
        });
    }
    timings.output_processing_ms += output_processing_started.elapsed().as_secs_f64() * 1_000.0;
    timings.render_ms += render_started.elapsed().as_secs_f64() * 1_000.0;
    let mut warnings = if deskew.accepted || effective_dewarp.is_some() {
        Vec::new()
    } else {
        vec![format!(
            "Deskew confidence {:.3} was below the 2.0 acceptance threshold",
            deskew.confidence
        )]
    };
    if options.crop_content && !crop_enabled && content.content.is_none() {
        warnings.push("Content crop was skipped because no content box was detected".into());
    }
    if let Some(auto) = &automatic_dewarp {
        if auto.model.is_none() && auto.confidence < 0.6 {
            warnings.push(format!(
                "Experimental automatic dewarp confidence {:.3} was below 0.6; no dewarp was applied",
                auto.confidence
            ));
        }
    }
    let source_dpi = options.source_dpi();
    let requested_render_dpi = options.requested_render_dpi();
    let raster_scale_limited = options.dpi + f64::EPSILON < requested_render_dpi;
    if raster_scale_limited {
        warnings.push(format!(
            "Requested render DPI {requested_render_dpi:.3} was limited to {:.3} by native raster safety limits",
            options.dpi
        ));
    }
    Ok(CleanupResult {
        image,
        color_image,
        picture_mask: rendered_picture_mask,
        tone_preservation_alpha: rendered_tone_alpha,
        mixed_layers,
        effectively_blank,
        metadata: CleanupMetadata {
            source_page_index,
            half,
            detected_skew_degrees: deskew.angle_degrees,
            skew_confidence: deskew.confidence,
            skew_applied: deskew.accepted,
            manual_skew: options.manual_skew_degrees.is_some(),
            layout_classification: split.classification,
            layout_confidence: split.confidence,
            cutter_x: split.cutter_x,
            split_geometry: split.pages.clone(),
            split_seam: split.split_seam.clone(),
            source_region: region,
            content_box: source_content_box,
            crop_rect: output_rect,
            content_diagnostics,
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            }
            .into(),
            soft_margins_pixels: [0; 4],
            uniform_canvas: false,
            canvas_policy: MatchedCanvasPolicy::Intrinsic,
            canvas_overflow: false,
            matched_canvas_target_width: None,
            matched_canvas_target_height: None,
            matched_canvas_target_width_points: None,
            matched_canvas_target_height_points: None,
            matched_canvas_content_width: None,
            matched_canvas_content_height: None,
            pdf_image_placement: None,
            output_mode: options.output_mode,
            bilevel_written: false,
            layered_written: false,
            layered_foreground_kind: None,
            layered_background_dpi: None,
            layered_foreground_dpi: None,
            trusted_mrc_background_preserved,
            trusted_selection_applied,
            illumination_normalized: options.normalize_illumination,
            text_tone_diagnostics,
            binarization_mode,
            binarization_diagnostics,
            ink_consistency_diagnostics,
            despeckle_fallback,
            forward_transform,
            inverse_transform,
            dewarp_model: effective_dewarp,
            dewarp_mapping,
            dewarp_confidence: automatic_dewarp.as_ref().map(|result| result.confidence),
            input_width: source.width(),
            input_height: source.height(),
            output_width,
            output_height,
            render_region,
            canvas_width: output_width,
            canvas_height: output_height,
            placement_offset_x: 0,
            placement_offset_y: 0,
            rotation: options.rotation,
            canvas_scope: crate::protocol::manifest_v3::CanvasScope::Page,
            resample_passes: 1,
            source_dpi,
            render_dpi: options.dpi,
            requested_render_dpi,
            raster_scale_limited,
            warnings,
        },
    })
}

fn render_binary_mask(
    source: &BinaryImage,
    width: usize,
    height: usize,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
            return false;
        };
        let source_x = mapped.x.round() as isize;
        let source_y = mapped.y.round() as isize;
        source_x >= 0
            && source_y >= 0
            && source_x < source.width() as isize
            && source_y < source.height() as isize
            && source.get(source_x as usize, source_y as usize)
    })
}

fn render_binary_mask_preserve_ink(
    source: &BinaryImage,
    width: usize,
    height: usize,
    footprint_width: f64,
    footprint_height: f64,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
            return false;
        };
        let Some((left, right)) = binary_coverage_bounds(mapped.x, footprint_width, source.width())
        else {
            return false;
        };
        let Some((top, bottom)) =
            binary_coverage_bounds(mapped.y, footprint_height, source.height())
        else {
            return false;
        };
        (top..bottom).any(|source_y| (left..right).any(|source_x| source.get(source_x, source_y)))
    })
}

fn binary_coverage_bounds(coordinate: f64, footprint: f64, limit: usize) -> Option<(usize, usize)> {
    if !coordinate.is_finite() || !footprint.is_finite() {
        return None;
    }
    let (start, end) = if footprint > 1.0 {
        (
            (coordinate - footprint * 0.5).ceil() as isize,
            (coordinate + footprint * 0.5).ceil() as isize,
        )
    } else {
        let index = coordinate.round() as isize;
        (index, index.saturating_add(1))
    };
    let limit = limit as isize;
    let start = start.clamp(0, limit) as usize;
    let end = end.clamp(0, limit) as usize;
    (start < end).then_some((start, end))
}

fn render_gray_field(
    source: &GrayImage,
    width: usize,
    height: usize,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 0);
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
                    continue;
                };
                if mapped.x < 0.0
                    || mapped.y < 0.0
                    || mapped.x > source.width().saturating_sub(1) as f64
                    || mapped.y > source.height().saturating_sub(1) as f64
                {
                    continue;
                }
                *target = sample_bilinear_white(source, mapped.x, mapped.y);
            }
        });
    output
}

/// Reconstruct plate tone under binary stencil pixels before the plate is
/// area-averaged to its much smaller PDF background raster. A white knockout
/// is correct for ordinary paper, but is not correct when a leaked or
/// intentionally overlaid stencil pixel lies inside a continuous-tone plate:
/// the downscaler spreads that white pixel into the surrounding photograph.
///
/// The picture ownership mask is the trust boundary here. It includes the
/// narrow protected ring used by composition, so a stencil just outside a
/// photo can be reconstructed from the already-blended edge tone without
/// pulling paper toward the photo. Samples are taken from non-stencil pixels
/// in that same ownership mask. The source clones keep one fill from
/// influencing the next sample.
fn fill_picture_stencil_knockouts(
    background: &mut GrayImage,
    mut color_background: Option<&mut RgbImage>,
    stencil: &BinaryImage,
    picture_ownership_mask: &BinaryImage,
    dpi: f64,
) {
    debug_assert_eq!(background.width(), stencil.width());
    debug_assert_eq!(background.height(), stencil.height());
    debug_assert_eq!(background.width(), picture_ownership_mask.width());
    debug_assert_eq!(background.height(), picture_ownership_mask.height());

    let width = background.width();
    let height = background.height();
    if width == 0 || height == 0 {
        return;
    }
    let max_radius = (dpi * 0.5 / 25.4).ceil().clamp(2.0, 16.0) as isize;
    let source_color = color_background.as_deref();
    let mut fills = Vec::new();

    for y in 0..height {
        for x in 0..width {
            if !stencil.get(x, y) || !picture_ownership_mask.get(x, y) {
                continue;
            }
            // Soft-alpha composition may deliberately put the original plate
            // pixel back after the foreground pass (notably for chromatic
            // plate detail). Only a white knockout is a hole that needs
            // reconstruction; never replace an already-preserved source
            // tone with the surrounding background average.
            if background.get(x, y) != 255
                || color_background
                    .as_ref()
                    .is_some_and(|background| background.get(x, y) != [255; 3])
            {
                continue;
            }

            let mut gray_sum = 0u64;
            let mut color_sum = [0u64; 3];
            let mut samples = 0u64;
            for radius in 1..=max_radius {
                for dy in -radius..=radius {
                    for dx in -radius..=radius {
                        if dx.abs().max(dy.abs()) != radius {
                            continue;
                        }
                        let sample_x = x as isize + dx;
                        let sample_y = y as isize + dy;
                        if sample_x < 0
                            || sample_y < 0
                            || sample_x >= width as isize
                            || sample_y >= height as isize
                        {
                            continue;
                        }
                        let sample_x = sample_x as usize;
                        let sample_y = sample_y as usize;
                        if !picture_ownership_mask.get(sample_x, sample_y)
                            || stencil.get(sample_x, sample_y)
                        {
                            continue;
                        }
                        gray_sum += u64::from(background.get(sample_x, sample_y));
                        if let Some(source_color) = source_color.as_ref() {
                            let pixel = source_color.get(sample_x, sample_y);
                            for (channel, value) in pixel.into_iter().enumerate() {
                                color_sum[channel] += u64::from(value);
                            }
                        }
                        samples += 1;
                    }
                }
                if samples > 0 {
                    break;
                }
            }
            if samples == 0 {
                continue;
            }

            fills.push((
                x,
                y,
                ((gray_sum + samples / 2) / samples) as u8,
                source_color.map(|_| color_sum.map(|sum| ((sum + samples / 2) / samples) as u8)),
            ));
        }
    }

    for (x, y, gray, color) in fills {
        background.set(x, y, gray);
        if let (Some(output_color), Some(color)) = (color_background.as_deref_mut(), color) {
            output_color.set(x, y, color);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn compose_mixed(
    gray: &GrayImage,
    raw_gray: Option<&GrayImage>,
    color: Option<&RgbImage>,
    binary: &BinaryImage,
    picture_mask: &BinaryImage,
    chroma_picture_mask: Option<&BinaryImage>,
    removed_edge_bands: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    create_layers: bool,
    create_composite: bool,
) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    // Mixed has two mutually exclusive owners: the binary foreground owns
    // text, while the protected picture mask owns continuous-tone detail.
    // Binarization already excludes this area, but later text-recall and
    // source-ink-support passes can add pixels back. Enforce the ownership
    // boundary at the composition boundary so every Mixed path, including
    // soft-alpha composition, has the same protection against leaked ink.
    let protection_radius = picture_protection_radius(dpi);
    let protected_picture_mask = dilate(picture_mask, protection_radius, protection_radius);
    let owned_binary = binary.subtract(&protected_picture_mask);
    debug_assert_eq!(
        owned_binary.and(&protected_picture_mask).count_black(),
        0,
        "Mixed foreground must not overlap protected picture ownership"
    );
    let binary = &owned_binary;
    if use_soft_alpha_foreground {
        return compose_soft_alpha_mixed(
            gray,
            raw_gray,
            color,
            binary,
            picture_mask,
            chroma_picture_mask,
            removed_edge_bands,
            text_mask,
            text_vicinity_mask,
            dpi,
            preserve_confirmed_photo_tones,
            create_layers,
            create_composite,
        );
    }
    // The final stencil and the calibrated picture mask are both rebuilt from
    // the cleaned raster. Start the background at neutral white so no
    // producer-authored composite or unclassified scanner tone can travel
    // into the output. The narrow picture ring may reclaim genuinely dark
    // boundary detail, but pale pixels outside the calibrated zone remain
    // white.
    let mut mixed_gray = GrayImage::new(gray.width(), gray.height(), 255);
    // A color plane is only produced when the page owns independent chroma.
    // Scanner noise keeps neutral pages from ever measuring exactly r=g=b,
    // so publishing RGB here forces every downstream encoder into a
    // three-channel JPEG at ~3x the bytes for tone the gray plane already
    // carries.
    let mut mixed_color = color
        .filter(|_| chroma_picture_mask.is_some())
        .map(|_| RgbImage::new(gray.width(), gray.height(), [255; 3]));
    let feather_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 48.0) as usize;
    let picture_exterior = picture_mask.invert();
    let (distance_to_picture_exterior, distance_to_stencil) = rayon::join(
        || squared_euclidean_distance(&picture_exterior),
        || squared_euclidean_distance(binary),
    );
    let stencil_adjacency_squared = (feather_radius * feather_radius) as u32;
    let alpha_at = |x: usize, y: usize, source_gray: u8| {
        let index = y * gray.width() + x;
        if preserve_confirmed_photo_tones {
            // Every pixel inside a corroborated owner is source appearance, including
            // the rectangular crop's paper-toned boundary. Any protective transition
            // belongs to the exterior ring below; fading owner pixels toward white
            // recreates the tile-shaped halo this path exists to remove.
            1.0
        } else if distance_to_stencil[index] <= stencil_adjacency_squared {
            let spatial_alpha = (f64::from(distance_to_picture_exterior[index]).sqrt()
                / feather_radius as f64)
                .clamp(0.0, 1.0);
            let dark_detail_alpha = ((245.0 - f64::from(source_gray)) / 96.0).clamp(0.0, 1.0);
            spatial_alpha.max(dark_detail_alpha)
        } else {
            1.0
        }
    };
    if let (Some(source_color), Some(output_color)) = (color, mixed_color.as_mut()) {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .zip(output_color.data_mut().par_chunks_mut(gray.width() * 3))
            .enumerate()
            .for_each(|(y, (gray_row, color_row))| {
                for (x, gray_target) in gray_row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *gray_target = 255;
                        color_row[x * 3..x * 3 + 3].fill(255);
                        continue;
                    }
                    if binary.get(x, y) {
                        let value = if create_composite { 0 } else { 255 };
                        *gray_target = value;
                        color_row[x * 3..x * 3 + 3].fill(value);
                        continue;
                    }
                    if !protected_picture_mask.get(x, y) {
                        continue;
                    }
                    let source_gray = gray.get(x, y);
                    let inside_picture = picture_mask.get(x, y);
                    let alpha = if inside_picture {
                        alpha_at(x, y, source_gray)
                    } else {
                        ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                    };
                    let exact_owned_tone = preserve_confirmed_photo_tones && inside_picture;
                    let paper_ring = !inside_picture && alpha <= f64::EPSILON;
                    *gray_target = if exact_owned_tone {
                        source_gray
                    } else if paper_ring {
                        255
                    } else {
                        reserve_gray_endpoint(
                            (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8,
                        )
                    };
                    let rgb = if exact_owned_tone {
                        source_color.get(x, y)
                    } else if paper_ring {
                        [255; 3]
                    } else {
                        reserve_rgb_endpoints(source_color.get(x, y).map(|channel| {
                            (255.0 * (1.0 - alpha) + f64::from(channel) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8
                        }))
                    };
                    color_row[x * 3..x * 3 + 3].copy_from_slice(&rgb);
                }
            });
    } else {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *target = 255;
                        continue;
                    }
                    if binary.get(x, y) {
                        *target = if create_composite { 0 } else { 255 };
                    } else if protected_picture_mask.get(x, y) {
                        let source_gray = gray.get(x, y);
                        let inside_picture = picture_mask.get(x, y);
                        let alpha = if inside_picture {
                            alpha_at(x, y, source_gray)
                        } else {
                            ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                        };
                        *target = if preserve_confirmed_photo_tones && inside_picture {
                            source_gray
                        } else if !inside_picture && alpha <= f64::EPSILON {
                            255
                        } else {
                            reserve_gray_endpoint(
                                (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                    .round()
                                    .clamp(0.0, 255.0) as u8,
                            )
                        };
                    }
                }
            });
    }
    let layers = create_layers.then(|| {
        let foreground_mask = binary.clone();
        let mut background = mixed_gray.clone();
        let mut color_background = mixed_color.clone();
        if !create_composite {
            fill_picture_stencil_knockouts(
                &mut background,
                color_background.as_mut(),
                binary,
                &protected_picture_mask,
                dpi,
            );
            return MixedLayers {
                foreground_mask,
                foreground_alpha: None,
                background,
                color_background,
                source_mrc: false,
            };
        }
        if let Some(color_background) = color_background.as_mut() {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .zip(color_background.data_mut().par_chunks_mut(gray.width() * 3))
                .enumerate()
                .for_each(|(y, (gray_row, color_row))| {
                    for (x, target) in gray_row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                            color_row[x * 3..x * 3 + 3].fill(255);
                        }
                    }
                });
        } else {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .enumerate()
                .for_each(|(y, row)| {
                    for (x, target) in row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                        }
                    }
                });
        }
        fill_picture_stencil_knockouts(
            &mut background,
            color_background.as_mut(),
            binary,
            &protected_picture_mask,
            dpi,
        );
        MixedLayers {
            foreground_mask,
            foreground_alpha: None,
            background,
            color_background,
            source_mrc: false,
        }
    });
    (mixed_gray, mixed_color, layers)
}

#[allow(clippy::too_many_arguments)]
fn compose_soft_alpha_mixed(
    gray: &GrayImage,
    raw_gray: Option<&GrayImage>,
    color: Option<&RgbImage>,
    binary_fallback: &BinaryImage,
    picture_mask: &BinaryImage,
    chroma_picture_mask: Option<&BinaryImage>,
    removed_edge_bands: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    preserve_confirmed_photo_tones: bool,
    create_layers: bool,
    create_composite: bool,
) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    debug_assert_eq!(gray.width(), picture_mask.width());
    debug_assert_eq!(gray.height(), picture_mask.height());
    debug_assert!(
        raw_gray.is_none_or(|raw| raw.width() == gray.width() && raw.height() == gray.height())
    );
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| mask.width() == gray.width() && mask.height() == gray.height()));

    // The normalized raster already expresses the desired black-on-white
    // coverage. Preserve that coverage as opacity in a narrow physical halo
    // around actual binarized ink. Text-vicinity masks are deliberately much
    // broader than glyphs and must not own every faint paper variation inside
    // their rectangles: doing so creates visible block seams and dense alpha
    // planes. The binarized core itself remains authoritative even outside a
    // text rectangle so isolated rules, punctuation, and calibration-like
    // marks cannot disappear merely because the line detector missed them.
    // Conversely, a matching halo around the detected tonal plate remains
    // plate-owned so picture borders and scanner shadows cannot leak into the
    // foreground.
    const TEXT_ALPHA_FLOOR: u8 = 6;
    const MISSED_TEXT_LUMINANCE_CEILING: u8 = 112;
    let ownership_radius = (dpi * 0.18 / 25.4).round().clamp(1.0, 4.0) as usize;
    let ink_seed = text_mask.map_or_else(
        || binary_fallback.clone(),
        |text_mask| binary_fallback.or(text_mask),
    );
    let ink_ownership = dilate(&ink_seed, ownership_radius, ownership_radius);
    let plate_ownership = dilate(picture_mask, ownership_radius, ownership_radius);
    let raw_paper = raw_gray.map(paper_reference);
    let mut foreground_alpha = GrayImage::new(gray.width(), gray.height(), 0);
    foreground_alpha
        .data_mut()
        .par_chunks_mut(gray.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let owns_binary_core = binary_fallback.get(x, y);
                let trusted_text = text_mask.is_some_and(|mask| mask.get(x, y));
                let chromatic_plate_pixel = chroma_picture_mask.is_some_and(|mask| mask.get(x, y));
                if (plate_ownership.get(x, y)
                    && (chromatic_plate_pixel || (!trusted_text && !owns_binary_core)))
                    || removed_edge_bands.is_some_and(|mask| mask.get(x, y))
                {
                    continue;
                }
                let mut value = gray.get(x, y);
                if owns_binary_core {
                    if let (Some(raw), Some(paper)) = (raw_gray, raw_paper) {
                        value = value.min(normalize_tone_to_paper(raw.get(x, y), paper));
                    }
                }
                let in_text_vicinity = text_vicinity_mask.is_some_and(|mask| mask.get(x, y));
                let vicinity_allows_ink = text_vicinity_mask.is_none() || in_text_vicinity;
                let owns_antialias = ink_ownership.get(x, y) && vicinity_allows_ink;
                let owns_missed_dark_ink =
                    in_text_vicinity && value <= MISSED_TEXT_LUMINANCE_CEILING;
                if !owns_binary_core && !owns_antialias && !owns_missed_dark_ink {
                    continue;
                }
                let alpha = 255u8.saturating_sub(value);
                if alpha >= TEXT_ALPHA_FLOOR {
                    *target = alpha;
                }
            }
        });

    // Use the same plate construction as the bilevel Mixed representation.
    // The foreground encoding must not change which tonal or chromatic pixels
    // survive in the background layer.
    let (_, _, bilevel_layers) = compose_mixed(
        gray,
        raw_gray,
        color,
        binary_fallback,
        picture_mask,
        chroma_picture_mask,
        removed_edge_bands,
        text_mask,
        text_vicinity_mask,
        dpi,
        preserve_confirmed_photo_tones,
        false,
        true,
        false,
    );
    let bilevel_layers = bilevel_layers.expect("requested mixed background layers");
    let mut background = bilevel_layers.background;
    let mut color_background = bilevel_layers.color_background;
    background
        .data_mut()
        .par_chunks_mut(gray.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                if foreground_alpha.get(x, y) > 0 {
                    *target = 255;
                } else if plate_ownership.get(x, y)
                    && chroma_picture_mask.is_some_and(|mask| mask.get(x, y))
                {
                    *target = gray.get(x, y);
                }
            }
        });
    if let (Some(source), Some(background)) = (color, color_background.as_mut()) {
        background
            .data_mut()
            .par_chunks_mut(gray.width() * 3)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    if foreground_alpha.get(x, y) > 0 {
                        target.fill(255);
                    } else if plate_ownership.get(x, y)
                        && chroma_picture_mask.is_some_and(|mask| mask.get(x, y))
                    {
                        target.copy_from_slice(&source.get(x, y));
                    }
                }
            });
    }
    fill_picture_stencil_knockouts(
        &mut background,
        color_background.as_mut(),
        binary_fallback,
        &plate_ownership,
        dpi,
    );

    let mut composite = background.clone();
    composite
        .data_mut()
        .par_chunks_mut(gray.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let alpha = foreground_alpha.get(x, y);
                if alpha > 0 {
                    *target = 255 - alpha;
                }
            }
        });
    let composite_color = color_background.as_ref().map(|background| {
        let mut output = background.clone();
        output
            .data_mut()
            .par_chunks_mut(gray.width() * 3)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    let value = 255 - foreground_alpha.get(x, y);
                    if value < 255 {
                        target.fill(value);
                    }
                }
            });
        output
    });
    let layers = create_layers.then(|| MixedLayers {
        foreground_mask: binary_fallback.clone(),
        foreground_alpha: Some(foreground_alpha),
        background,
        color_background,
        source_mrc: false,
    });
    if create_composite {
        (composite, composite_color, layers)
    } else {
        let layer_background = layers
            .as_ref()
            .map_or_else(|| gray.clone(), |layers| layers.background.clone());
        let layer_color = layers
            .as_ref()
            .and_then(|layers| layers.color_background.clone());
        (layer_background, layer_color, layers)
    }
}

fn suppress_scanner_edge_bands(
    source: &BinaryImage,
    gray: &GrayImage,
    picture_mask: &BinaryImage,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> (BinaryImage, BinaryImage) {
    debug_assert_eq!(source.width(), gray.width());
    debug_assert_eq!(source.height(), gray.height());
    debug_assert_eq!(source.width(), picture_mask.width());
    debug_assert_eq!(source.height(), picture_mask.height());
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == source.width() && mask.height() == source.height() }));
    let minimum_thickness = (dpi * 0.6 / 25.4).round().max(2.0) as usize;
    let maximum_thickness = (dpi * 12.0 / 25.4).round().max(3.0) as usize;
    let edge_distance = (dpi * 10.0 / 25.4).round().max(4.0) as usize;
    let mut row_counts = vec![0usize; source.height()];
    let mut picture_row_counts = vec![0usize; source.height()];
    let mut column_counts = vec![0usize; source.width()];
    let mut picture_column_counts = vec![0usize; source.width()];
    for y in 0..source.height() {
        for x in 0..source.width() {
            row_counts[y] += usize::from(source.get(x, y));
            picture_row_counts[y] += usize::from(picture_mask.get(x, y));
            column_counts[x] += usize::from(source.get(x, y));
            picture_column_counts[x] += usize::from(picture_mask.get(x, y));
        }
    }
    let horizontal_bands = dense_edge_band_runs(
        &row_counts,
        &picture_row_counts,
        source.width(),
        minimum_thickness,
        maximum_thickness,
        edge_distance,
    );
    let vertical_bands = dense_edge_band_runs(
        &column_counts,
        &picture_column_counts,
        source.height(),
        minimum_thickness,
        maximum_thickness,
        edge_distance,
    );
    let mut removed = BinaryImage::new(source.width(), source.height());
    for (top, bottom) in horizontal_bands {
        for y in top..=bottom {
            for x in 0..source.width() {
                removed.set(x, y, true);
            }
        }
    }
    for (left, right) in vertical_bands {
        for y in 0..source.height() {
            for x in left..=right {
                removed.set(x, y, true);
            }
        }
    }
    let mut cleaned = source.subtract(&removed);
    // Thresholding a scan shadow can produce a long crescent or a broken cloud
    // rather than a row/column-dense band. Remove those connected components
    // only when their geometry belongs to the physical scan boundary and the
    // page's picture/text ownership masks do not claim them. This deliberately
    // makes ownership, not darkness, the content decision.
    let components = ComponentMap::from_binary(&cleaned);
    let mut owned_pixels = vec![0usize; components.components().len() + 1];
    let mut picture_owned_pixels = vec![0usize; components.components().len() + 1];
    let mut boundary_pixels = vec![0usize; components.components().len() + 1];
    let mut luminance_sum = vec![0usize; components.components().len() + 1];
    let boundary_depth = (dpi * 32.0 / 25.4).round().max(8.0) as usize;
    for y in 0..cleaned.height() {
        for x in 0..cleaned.width() {
            if !cleaned.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if label == 0 {
                continue;
            }
            luminance_sum[label] += usize::from(gray.get(x, y));
            if x < boundary_depth
                || y < boundary_depth
                || source.width().saturating_sub(x) <= boundary_depth
                || source.height().saturating_sub(y) <= boundary_depth
            {
                boundary_pixels[label] += 1;
            }
            if picture_mask.get(x, y) {
                picture_owned_pixels[label] += 1;
            }
            if picture_mask.get(x, y) || text_vicinity_mask.is_some_and(|mask| mask.get(x, y)) {
                owned_pixels[label] += 1;
            }
        }
    }
    // "Contacts the scanner boundary" must mean the physical edge, not the
    // ordinary page margin. A 30 mm contact band treated headings, ornaments,
    // stamps, and marginal notes as scanner shadows. Broad inset shadows are
    // still handled by `mostly_boundary_shadow` below.
    let boundary_contact = (dpi * 3.0 / 25.4).round().max(2.0) as usize;
    let minimum_boundary_span = (dpi * 3.0 / 25.4).round().max(3.0) as usize;
    let minimum_boundary_area = ((dpi / 25.4).powi(2) * 12.0).round().max(16.0) as usize;
    let remove_component = |component: &scan_primitives::Component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let left_boundary = component.left <= boundary_contact
            && component.right <= boundary_depth
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let right_boundary = source
            .width()
            .saturating_sub(1)
            .saturating_sub(component.right)
            <= boundary_contact
            && source.width().saturating_sub(component.left) <= boundary_depth
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let top_boundary = component.top <= boundary_contact
            && component.bottom <= boundary_depth
            && width >= minimum_boundary_span
            && height >= minimum_thickness;
        let bottom_boundary = source
            .height()
            .saturating_sub(1)
            .saturating_sub(component.bottom)
            <= boundary_contact
            && source.height().saturating_sub(component.top) <= boundary_depth
            && width >= minimum_boundary_span
            && height >= minimum_thickness;
        // Keep the ordinary 3 mm contact rule narrow enough for marginal
        // content, but allow a tall, deep scanner rail to use the existing
        // 10 mm edge-distance contract. The span/area/depth/thickness gates
        // and ownership guard keep this bounded to catastrophic rails.
        let tall_deep_left_boundary = component.left <= edge_distance
            && component.right <= boundary_depth
            && height >= edge_distance
            && component.area >= minimum_boundary_area
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let tall_deep_right_boundary = source
            .width()
            .saturating_sub(1)
            .saturating_sub(component.right)
            <= edge_distance
            && source.width().saturating_sub(component.left) <= boundary_depth
            && height >= edge_distance
            && component.area >= minimum_boundary_area
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let mostly_boundary_shadow = component.area >= minimum_boundary_area
            && boundary_pixels[component.label as usize].saturating_mul(4)
                >= component.area.saturating_mul(3)
            && luminance_sum[component.label as usize] >= component.area.saturating_mul(72);
        let owned = owned_pixels[component.label as usize].saturating_mul(4) >= component.area;
        let picture_owned =
            picture_owned_pixels[component.label as usize].saturating_mul(4) >= component.area;
        // Full-resolution text recall can claim a scanner rail as semantic ink
        // even when the picture mask correctly excludes it. Let only the
        // strongest tall/deep shadow geometry override that text-only claim;
        // picture ownership remains absolute, and dark marginalia does not
        // satisfy the pale-shadow gate.
        let text_owned_tall_deep_shadow = !picture_owned
            && mostly_boundary_shadow
            && (tall_deep_left_boundary || tall_deep_right_boundary);
        if owned && !text_owned_tall_deep_shadow {
            return false;
        }
        left_boundary
            || right_boundary
            || tall_deep_left_boundary
            || tall_deep_right_boundary
            || top_boundary
            || bottom_boundary
            || mostly_boundary_shadow
    };
    let component_artifacts = components.retain(remove_component);
    removed = removed.or(&component_artifacts);
    cleaned = source.subtract(&removed);
    (cleaned, removed)
}

fn dense_edge_band_runs(
    counts: &[usize],
    picture_counts: &[usize],
    span: usize,
    minimum_thickness: usize,
    maximum_thickness: usize,
    edge_distance: usize,
) -> Vec<(usize, usize)> {
    let mut bands = Vec::new();
    let mut start = None;
    for index in 0..=counts.len() {
        let dense =
            index < counts.len() && counts[index].saturating_mul(4) >= span.saturating_mul(3);
        match (start, dense) {
            (None, true) => start = Some(index),
            (Some(first), false) => {
                let last = index - 1;
                let thickness = last - first + 1;
                let near_edge = first <= edge_distance
                    || counts.len().saturating_sub(1).saturating_sub(last) <= edge_distance;
                let picture_owned = picture_counts[first..=last]
                    .iter()
                    .sum::<usize>()
                    .saturating_mul(4)
                    >= span.saturating_mul(thickness);
                if near_edge
                    && !picture_owned
                    && (minimum_thickness..=maximum_thickness).contains(&thickness)
                {
                    let mut expanded_first = first;
                    let mut expanded_last = last;
                    while expanded_first > 0 && counts[expanded_first - 1].saturating_mul(5) >= span
                    {
                        expanded_first -= 1;
                    }
                    while expanded_last + 1 < counts.len()
                        && counts[expanded_last + 1].saturating_mul(5) >= span
                    {
                        expanded_last += 1;
                    }
                    bands.push((expanded_first, expanded_last));
                }
                start = None;
            }
            _ => {}
        }
    }
    bands
}

fn reserve_gray_endpoint(value: u8) -> u8 {
    match value {
        0 => 1,
        255 => 254,
        value => value,
    }
}

fn reserve_rgb_endpoints(value: [u8; 3]) -> [u8; 3] {
    match value {
        [0, 0, 0] => [1, 1, 1],
        [255, 255, 255] => [254, 254, 254],
        value => value,
    }
}

pub(crate) fn downscale_rgb_to_dimensions(
    source: &RgbImage,
    width: usize,
    height: usize,
) -> RgbImage {
    if source.width() == width && source.height() == height {
        return source.clone();
    }
    let mut output = RgbImage::new(width, height, [255; 3]);
    for output_y in 0..height {
        let source_y0 = output_y * source.height() / height;
        let source_y1 = ((output_y + 1) * source.height() / height)
            .max(source_y0 + 1)
            .min(source.height());
        for output_x in 0..width {
            let source_x0 = output_x * source.width() / width;
            let source_x1 = ((output_x + 1) * source.width() / width)
                .max(source_x0 + 1)
                .min(source.width());
            let mut sums = [0u64; 3];
            let mut count = 0u64;
            for source_y in source_y0..source_y1 {
                for source_x in source_x0..source_x1 {
                    let pixel = source.get(source_x, source_y);
                    for channel in 0..3 {
                        sums[channel] += u64::from(pixel[channel]);
                    }
                    count += 1;
                }
            }
            output.set(
                output_x,
                output_y,
                sums.map(|sum| (sum / count.max(1)) as u8),
            );
        }
    }
    output
}

fn rotate_rgb_orthogonal(source: &RgbImage, rotation: OrthogonalRotation) -> RgbImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => source.clone(),
        OrthogonalRotation::Clockwise180 => {
            let mut output = RgbImage::new(width, height, [255; 3]);
            let pixels = source.data().chunks_exact(3);
            for (target, value) in output.data_mut().chunks_exact_mut(3).rev().zip(pixels) {
                target.copy_from_slice(value);
            }
            output
        }
        OrthogonalRotation::Clockwise90 => {
            let mut output = RgbImage::new(height, width, [255; 3]);
            for y in 0..height {
                let target_x = height - 1 - y;
                for (x, value) in source.row(y).chunks_exact(3).enumerate() {
                    output.set(target_x, x, [value[0], value[1], value[2]]);
                }
            }
            output
        }
        OrthogonalRotation::Clockwise270 => {
            let mut output = RgbImage::new(height, width, [255; 3]);
            for y in 0..height {
                for (x, value) in source.row(y).chunks_exact(3).enumerate() {
                    output.set(y, width - 1 - x, [value[0], value[1], value[2]]);
                }
            }
            output
        }
    }
}

fn rotate_binary_orthogonal(source: &BinaryImage, rotation: OrthogonalRotation) -> BinaryImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => source.clone(),
        OrthogonalRotation::Clockwise180 => BinaryImage::from_fn_parallel(width, height, |x, y| {
            source.get(width - 1 - x, height - 1 - y)
        }),
        OrthogonalRotation::Clockwise90 => {
            BinaryImage::from_fn_parallel(height, width, |x, y| source.get(y, height - 1 - x))
        }
        OrthogonalRotation::Clockwise270 => {
            BinaryImage::from_fn_parallel(height, width, |x, y| source.get(width - 1 - y, x))
        }
    }
}

fn rotate_orthogonal(source: &GrayImage, rotation: OrthogonalRotation) -> GrayImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => {
            let mut output = GrayImage::new(width, height, 255);
            for y in 0..height {
                output.row_mut(y).copy_from_slice(source.row(y));
            }
            output
        }
        OrthogonalRotation::Clockwise180 => {
            let mut output = GrayImage::new(width, height, 255);
            for y in 0..height {
                let source_row = source.row(y);
                for (target, value) in output
                    .row_mut(height - 1 - y)
                    .iter_mut()
                    .rev()
                    .zip(source_row)
                {
                    *target = *value;
                }
            }
            output
        }
        OrthogonalRotation::Clockwise90 => {
            let mut output = GrayImage::new(height, width, 255);
            for y in 0..height {
                let target_x = height - 1 - y;
                for (x, value) in source.row(y).iter().enumerate() {
                    output.set(target_x, x, *value);
                }
            }
            output
        }
        OrthogonalRotation::Clockwise270 => {
            let mut output = GrayImage::new(height, width, 255);
            for y in 0..height {
                for (x, value) in source.row(y).iter().enumerate() {
                    output.set(y, width - 1 - x, *value);
                }
            }
            output
        }
    }
}

fn is_effectively_blank(image: &GrayImage, dpi: f64) -> bool {
    let ink = image.data().iter().filter(|&&value| value < 224).count();
    let dpi_floor = (24.0 * (dpi / 300.0).powi(2)).round().max(6.0) as usize;
    let coverage_floor =
        (image.width().saturating_mul(image.height()) as f64 * 0.00002).round() as usize;
    ink <= dpi_floor.max(coverage_floor)
}

fn crop_gray(source: &GrayImage, rect: Rect) -> GrayImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = GrayImage::new(width, height, 255);
    let copy_width = width.min(source.width().saturating_sub(left));
    let copy_height = height.min(source.height().saturating_sub(top));
    for y in 0..copy_height {
        output.row_mut(y)[..copy_width]
            .copy_from_slice(&source.row(top + y)[left..left + copy_width]);
    }
    output
}

fn crop_rgb(source: &RgbImage, rect: Rect) -> RgbImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = RgbImage::new(width, height, [255; 3]);
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
    }
    output
}

fn crop_binary(source: &BinaryImage, rect: Rect) -> BinaryImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = BinaryImage::new(width, height);
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
    }
    output
}

fn crop_gray_to_fit(
    source: &GrayImage,
    rect: Rect,
    max_width: usize,
    max_height: usize,
) -> GrayImage {
    // Mode and binarization routing must see the same aggregate structure as
    // the full raster. Point sampling aliases narrow stems, counters and
    // halftone cells into arbitrary black/white pixels (a 360-DPI Rome page
    // consequently reported a one-pixel stroke). The primitive's area
    // downscaler integrates every source pixel in the crop.
    crop_gray(source, rect).downscale_to_fit(max_width, max_height)
}

fn transform_rect_bounds(rect: Rect, transform: Affine) -> Rect {
    let points = [
        Point::new(rect.x, rect.y),
        Point::new(rect.right(), rect.y),
        Point::new(rect.x, rect.bottom()),
        Point::new(rect.right(), rect.bottom()),
    ]
    .map(|point| transform.apply(point));
    let left = points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let top = points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let right = points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    Rect::new(left, top, right - left, bottom - top)
}

fn transform_dewarp_options(
    options: &crate::DewarpOptions,
    transform: Affine,
) -> crate::DewarpOptions {
    crate::DewarpOptions {
        top_curve: options
            .top_curve
            .iter()
            .map(|&point| transform.apply(point))
            .collect(),
        bottom_curve: options
            .bottom_curve
            .iter()
            .map(|&point| transform.apply(point))
            .collect(),
        depth: options.depth,
    }
}

fn map_rect_bounds<F>(rect: Rect, map: F) -> Option<Rect>
where
    F: Fn(Point) -> Option<Point>,
{
    const EDGE_SAMPLES: usize = 17;
    let mut points = Vec::with_capacity(EDGE_SAMPLES * 4);
    for step in 0..EDGE_SAMPLES {
        let amount = step as f64 / (EDGE_SAMPLES - 1) as f64;
        let x = rect.x + rect.width * amount;
        let y = rect.y + rect.height * amount;
        points.push(map(Point::new(x, rect.y))?);
        points.push(map(Point::new(x, rect.bottom()))?);
        points.push(map(Point::new(rect.x, y))?);
        points.push(map(Point::new(rect.right(), y))?);
    }
    let left = points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let top = points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let right = points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    Some(Rect::new(left, top, right - left, bottom - top))
}

fn deskew_transform(width: usize, height: usize, deskew: DeskewResult) -> Affine {
    if !deskew.accepted {
        return Affine::IDENTITY;
    }
    let cx = width as f64 * 0.5;
    let cy = height as f64 * 0.5;
    Affine::translation(-cx, -cy)
        .then(Affine::rotation_radians(-deskew.angle_degrees.to_radians()))
        .then(Affine::translation(cx, cy))
}

fn render_affine_gray(
    source: &GrayImage,
    width: usize,
    height: usize,
    inverse: Affine,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    if let Some((translate_x, translate_y)) = integer_translation(inverse) {
        output
            .data_mut()
            .par_chunks_mut(width)
            .enumerate()
            .for_each(|(y, row)| {
                let source_y = y as isize + translate_y;
                if source_y < 0 || source_y >= source.height() as isize {
                    return;
                }
                for (x, target) in row.iter_mut().enumerate() {
                    let source_x = x as isize + translate_x;
                    if source_x >= 0 && source_x < source.width() as isize {
                        *target = source.get(source_x as usize, source_y as usize);
                    }
                }
            });
        return output;
    }
    let sample_offsets = adaptive_sample_offsets(inverse);
    let taps = sample_offsets.len();
    let matrix = inverse.matrix;
    let (step_x, step_y) = (matrix[0][0], matrix[1][0]);
    let source_data = source.data();
    let source_stride = source.stride();
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let mut mapped = [(0.0, 0.0); MAX_SAMPLE_OFFSETS];
            for (slot, &(offset_x, offset_y)) in mapped.iter_mut().zip(sample_offsets) {
                let source_y = y as f64 + offset_y;
                *slot = (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                );
            }
            let (interior_start, interior_end) = interior_column_span(
                &mapped[..taps],
                step_x,
                step_y,
                width,
                source.width(),
                source.height(),
            );
            for (x, target) in row.iter_mut().enumerate() {
                let interior = x >= interior_start && x < interior_end;
                let mut sum = 0u32;
                for (sample_x, sample_y) in mapped.iter_mut().take(taps) {
                    sum += if interior {
                        let position_x = *sample_x - 0.5;
                        let position_y = *sample_y - 0.5;
                        let column = position_x as usize;
                        let line = position_y as usize;
                        let fraction_x = (position_x - column as f64) as f32;
                        let fraction_y = (position_y - line as f64) as f32;
                        let base = line * source_stride + column;
                        let top = &source_data[base..base + 2];
                        let bottom = &source_data[base + source_stride..base + source_stride + 2];
                        let top_value = f32::from(top[0])
                            + (f32::from(top[1]) - f32::from(top[0])) * fraction_x;
                        let bottom_value = f32::from(bottom[0])
                            + (f32::from(bottom[1]) - f32::from(bottom[0])) * fraction_x;
                        (top_value + (bottom_value - top_value) * fraction_y + 0.5) as u32
                    } else {
                        u32::from(sample_bilinear_white(source, *sample_x, *sample_y))
                    };
                    *sample_x += step_x;
                    *sample_y += step_y;
                }
                *target = (sum / taps as u32) as u8;
            }
        });
    output
}

fn render_affine_rgb(source: &RgbImage, width: usize, height: usize, inverse: Affine) -> RgbImage {
    let mut output = RgbImage::new(width, height, [255; 3]);
    if let Some((translate_x, translate_y)) = integer_translation(inverse) {
        output
            .data_mut()
            .par_chunks_mut(width * 3)
            .enumerate()
            .for_each(|(y, row)| {
                let source_y = y as isize + translate_y;
                if source_y < 0 || source_y >= source.height() as isize {
                    return;
                }
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    let source_x = x as isize + translate_x;
                    if source_x >= 0 && source_x < source.width() as isize {
                        target.copy_from_slice(&source.get(source_x as usize, source_y as usize));
                    }
                }
            });
        return output;
    }
    let sample_offsets = adaptive_sample_offsets(inverse);
    let taps = sample_offsets.len();
    let matrix = inverse.matrix;
    let (step_x, step_y) = (matrix[0][0], matrix[1][0]);
    let source_data = source.data();
    let source_stride = source.width() * 3;
    output
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let mut mapped = [(0.0, 0.0); MAX_SAMPLE_OFFSETS];
            for (slot, &(offset_x, offset_y)) in mapped.iter_mut().zip(sample_offsets) {
                let source_y = y as f64 + offset_y;
                *slot = (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                );
            }
            let (interior_start, interior_end) = interior_column_span(
                &mapped[..taps],
                step_x,
                step_y,
                width,
                source.width(),
                source.height(),
            );
            for (x, target) in row.chunks_exact_mut(3).enumerate() {
                let interior = x >= interior_start && x < interior_end;
                let mut sum = [0u32; 3];
                for (sample_x, sample_y) in mapped.iter_mut().take(taps) {
                    if interior {
                        let position_x = *sample_x - 0.5;
                        let position_y = *sample_y - 0.5;
                        let column = position_x as usize;
                        let line = position_y as usize;
                        let fraction_x = (position_x - column as f64) as f32;
                        let fraction_y = (position_y - line as f64) as f32;
                        let base = line * source_stride + column * 3;
                        let top = &source_data[base..base + 6];
                        let bottom = &source_data[base + source_stride..base + source_stride + 6];
                        for (channel, total) in sum.iter_mut().enumerate() {
                            let top_value = f32::from(top[channel])
                                + (f32::from(top[channel + 3]) - f32::from(top[channel]))
                                    * fraction_x;
                            let bottom_value = f32::from(bottom[channel])
                                + (f32::from(bottom[channel + 3]) - f32::from(bottom[channel]))
                                    * fraction_x;
                            *total +=
                                (top_value + (bottom_value - top_value) * fraction_y + 0.5) as u32;
                        }
                    } else {
                        let sample = sample_bilinear_rgb_white(source, *sample_x, *sample_y);
                        for (channel, total) in sum.iter_mut().enumerate() {
                            *total += u32::from(sample[channel]);
                        }
                    }
                    *sample_x += step_x;
                    *sample_y += step_y;
                }
                for (value, total) in target.iter_mut().zip(sum) {
                    *value = (total / taps as u32) as u8;
                }
            }
        });
    output
}

fn integer_translation(transform: Affine) -> Option<(isize, isize)> {
    let matrix = transform.matrix;
    let linear_is_identity = (matrix[0][0] - 1.0).abs() <= 1e-12
        && matrix[0][1].abs() <= 1e-12
        && matrix[1][0].abs() <= 1e-12
        && (matrix[1][1] - 1.0).abs() <= 1e-12;
    let tx = matrix[0][2].round();
    let ty = matrix[1][2].round();
    (linear_is_identity && (matrix[0][2] - tx).abs() <= 1e-12 && (matrix[1][2] - ty).abs() <= 1e-12)
        .then_some((tx as isize, ty as isize))
}

const MAX_SAMPLE_OFFSETS: usize = 4;

fn interior_column_span(
    starts: &[(f64, f64)],
    step_x: f64,
    step_y: f64,
    width: usize,
    source_width: usize,
    source_height: usize,
) -> (usize, usize) {
    let axis_span = |start: f64, step: f64, high: f64| -> Option<(f64, f64)> {
        if high < 0.5 {
            return None;
        }
        if step == 0.0 {
            return (start >= 0.5 && start <= high).then_some((f64::NEG_INFINITY, f64::INFINITY));
        }
        let first = (0.5 - start) / step;
        let second = (high - start) / step;
        Some(if step > 0.0 {
            (first, second)
        } else {
            (second, first)
        })
    };
    let mut low = 0.0_f64;
    let mut high = width as f64;
    for &(start_x, start_y) in starts {
        match (
            axis_span(start_x, step_x, source_width as f64 - 1.5),
            axis_span(start_y, step_y, source_height as f64 - 1.5),
        ) {
            (Some(x_span), Some(y_span)) => {
                low = low.max(x_span.0).max(y_span.0);
                high = high.min(x_span.1).min(y_span.1);
            }
            _ => return (0, 0),
        }
    }
    // One column of slack on each side absorbs the rounding of the span itself.
    let first = (low.ceil().max(0.0) as usize).saturating_add(1);
    let last = (high.floor().max(0.0) as usize)
        .min(width)
        .saturating_sub(1);
    if first < last {
        (first, last)
    } else {
        (0, 0)
    }
}

fn adaptive_sample_offsets(inverse: Affine) -> &'static [(f64, f64)] {
    const CENTER: &[(f64, f64)] = &[(0.5, 0.5)];
    const TWO_BY_TWO: &[(f64, f64)] = &[(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)];
    let x_footprint = inverse.matrix[0][0].hypot(inverse.matrix[1][0]);
    let y_footprint = inverse.matrix[0][1].hypot(inverse.matrix[1][1]);
    let mixes_axes = inverse.matrix[0][1].abs() > 1e-12 || inverse.matrix[1][0].abs() > 1e-12;
    if mixes_axes || x_footprint.max(y_footprint) > 1.25 {
        TWO_BY_TWO
    } else {
        CENTER
    }
}

fn sample_bilinear_rgb_white(source: &RgbImage, x: f64, y: f64) -> [u8; 3] {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> [u8; 3] {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            [255; 3]
        } else {
            source.get(sx as usize, sy as usize)
        }
    };
    let samples = [
        sample(x0, y0),
        sample(x0 + 1, y0),
        sample(x0, y0 + 1),
        sample(x0 + 1, y0 + 1),
    ];
    let mut output = [0u8; 3];
    for (channel, target) in output.iter_mut().enumerate() {
        let top = f64::from(samples[0][channel]) * (1.0 - fx) + f64::from(samples[1][channel]) * fx;
        let bottom =
            f64::from(samples[2][channel]) * (1.0 - fx) + f64::from(samples[3][channel]) * fx;
        *target = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
    }
    output
}

fn sample_bilinear_white(source: &GrayImage, x: f64, y: f64) -> u8 {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> f64 {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            255.0
        } else {
            f64::from(source.get(sx as usize, sy as usize))
        }
    };
    let top = sample(x0, y0) * (1.0 - fx) + sample(x0 + 1, y0) * fx;
    let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
    (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
fn render_affine_gray_supersampled_reference(
    source: &GrayImage,
    width: usize,
    height: usize,
    inverse: Affine,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    let offsets = [0.125, 0.375, 0.625, 0.875];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0u32;
            for &oy in &offsets {
                for &ox in &offsets {
                    let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                    sum += u32::from(sample_bilinear_white(source, mapped.x, mapped.y));
                }
            }
            output.set(x, y, (sum / 16) as u8);
        }
    }
    output
}

fn sampled_dewarp_grid(plan: &ComposedRenderPlan, region: Rect) -> DewarpMappingGrid {
    const GRID: usize = DEWARP_GRID_SIZE;
    let mut output_to_source = Vec::with_capacity(GRID * GRID);
    let mut source_to_output = Vec::with_capacity(GRID * GRID);
    for row in 0..GRID {
        for column in 0..GRID {
            let u = column as f64 / (GRID - 1) as f64;
            let v = row as f64 / (GRID - 1) as f64;
            let output = Point::new(
                u * plan.output_width() as f64,
                v * plan.output_height() as f64,
            );
            output_to_source.push(plan.output_to_source(output).unwrap_or(output));
            let source = Point::new(region.x + u * region.width, region.y + v * region.height);
            source_to_output.push(plan.source_to_output(source).unwrap_or(source));
        }
    }
    DewarpMappingGrid {
        columns: GRID,
        rows: GRID,
        output_origin: Point::new(plan.output_rect().x, plan.output_rect().y),
        output_width: plan.output_width(),
        output_height: plan.output_height(),
        output_to_source,
        source_to_output,
    }
}

#[cfg(test)]
include!("render_tests.rs");
