pub use crate::domain::geometry::{AppliedMargins, PageHalf};
use crate::engine::prepare::{build_analysis_level, AnalysisLevel};
use crate::engine::render_plan::{
    content_result_for_dimensions, output_regions, ComposedRenderPlan,
};
use crate::engine::text_axis::{detect_text_axis, TextAxisHint};
use crate::mode_select::{OutputModeRecommendation, PreparedModeEvidence};
use crate::{
    auto_dewarp::detect_curves_at_dpi_with_depth,
    background::{
        normalize_illumination, normalize_illumination_for_layout, normalize_illumination_rgb,
        normalize_illumination_rgb_with_picture_mask, normalize_illumination_with_picture_mask,
        normalize_region_with_reusable_model, normalize_rgb_region_with_reusable_model,
        reusable_illumination_model,
    },
    bw::{
        binarize_normalized_with_diagnostics, binarize_normalized_with_diagnostics_excluding,
        binary_to_gray, postprocess_binary_with_diagnostics, BinarizationDiagnostics,
    },
    cache::{PageCache, StageCacheKey},
    calibration::{CalibrationConfig, PageCalibration},
    content::detect_content_and_margins_calibrated,
    deskew::{detect_skew, DeskewResult},
    dewarp::{
        rasterize_inverse_area_rgb_with, rasterize_inverse_area_with, DewarpModel, DEWARP_GRID_SIZE,
    },
    picture::{apply_manual_zones, detect_picture_mask, extend_picture_mask_for_content},
    png::RgbImage,
    protocol::{
        manifest_v3::{ContentDiagnostics, DetailRenderPlan},
        progress::PageStageTimings,
    },
    split::{
        detect_split_at_analysis_level_with_threshold, DocumentPrior, LayoutClassification,
        ReconciliationMetadata, SplitResult,
    },
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance, threshold::otsu_threshold, Affine, BinaryImage,
    GrayImage, Point, Polygon, Rect,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{sync::Arc, time::Instant};

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
    pub output_mode: OutputMode,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bilevel_written: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub layered_written: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_background_dpi: Option<f64>,
    #[serde(default)]
    pub illumination_normalized: bool,
    pub binarization_mode: Option<crate::BinarizationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binarization_diagnostics: Option<BinarizationDiagnostics>,
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

pub struct CleanupResult {
    pub image: GrayImage,
    pub color_image: Option<RgbImage>,
    pub metadata: CleanupMetadata,
    pub(crate) mixed_layers: Option<MixedLayers>,
    effectively_blank: bool,
}

pub(crate) struct MixedLayers {
    pub foreground_mask: GrayImage,
    pub background: GrayImage,
    pub color_background: Option<RgbImage>,
}

pub struct PageCleanupResult {
    pub outputs: Vec<CleanupResult>,
    pub classification: LayoutClassification,
    pub layout_confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub reconciliation: ReconciliationMetadata,
    pub blank_outputs_skipped: usize,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

pub(crate) fn clean_detail_page_with_color(
    source_crop: &GrayImage,
    color_source_crop: Option<&RgbImage>,
    base_source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
    plan: &DetailRenderPlan,
    base_metadata: &CleanupMetadata,
) -> Result<PageCleanupResult, String> {
    options.validate()?;
    if options.output_mode == OutputMode::Mixed {
        return Err("Mixed-mode detail rendering requires the full-page picture mask".into());
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
    let normalized_gray;
    let normalized_color;
    let processing_source = if options.normalize_illumination {
        let (rotated_base, _) = rotate_orthogonal(base_source, options.rotation);
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
    let mapped_gray =
        rasterize_inverse_area_with(processing_source, sampled_width, sampled_height, map_output);
    let mapped_color = processing_color.map(|source| {
        rasterize_inverse_area_rgb_with(source, sampled_width, sampled_height, map_output)
    });

    // Geometry is replayed from the trusted base metadata above. Reuse the
    // ordinary cleanup pipeline for tonal normalization, mixed routing,
    // binarization, thickness, and despeckle so detail tiles cannot grow a
    // second processing implementation.
    let mut tile_options = options.clone();
    tile_options.render_crop = None;
    tile_options.rotation = OrthogonalRotation::None;
    tile_options.layout = crate::LayoutMode::Single;
    tile_options.manual_split_x = None;
    tile_options.manual_skew_degrees = Some(0.0);
    tile_options.manual_content_boxes = Default::default();
    tile_options.manual_zones = Default::default();
    tile_options.normalize_illumination = false;
    tile_options.crop_content = false;
    tile_options.match_page_size = false;
    tile_options.margins_mm = None;
    tile_options.margins_pixels = None;
    tile_options.dewarp = None;
    tile_options.experimental = Default::default();
    tile_options.skip_blank_pages = false;
    let mut processed = clean_page_with_color(
        &mapped_gray,
        mapped_color.as_ref(),
        &tile_options,
        source_page_index,
    )?;
    let mut output = processed
        .outputs
        .pop()
        .ok_or("Detail processing produced no output")?;
    let payload_rect = Rect::new(
        render_region.x - sampled_region.x,
        render_region.y - sampled_region.y,
        render_region.width,
        render_region.height,
    );
    output.image = crop_gray(&output.image, payload_rect);
    output.color_image = output
        .color_image
        .map(|image| crop_rgb(&image, payload_rect));
    output.mixed_layers = output.mixed_layers.map(|layers| MixedLayers {
        foreground_mask: crop_gray(&layers.foreground_mask, payload_rect),
        background: crop_gray(&layers.background, payload_rect),
        color_background: layers
            .color_background
            .map(|image| crop_rgb(&image, payload_rect)),
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
    metadata.illumination_normalized = output.metadata.illumination_normalized;
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
        blank_outputs_skipped: 0,
        excluded: false,
        rotation: base_metadata.rotation,
        output_mode_recommendation: None,
    })
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
    match rotation {
        OrthogonalRotation::None => point,
        OrthogonalRotation::Clockwise90 => Point::new(point.y, source_height as f64 - point.x),
        OrthogonalRotation::Clockwise180 => Point::new(
            source_width as f64 - point.x,
            source_height as f64 - point.y,
        ),
        OrthogonalRotation::Clockwise270 => Point::new(source_width as f64 - point.y, point.x),
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
    pub rotated_width: usize,
    pub rotated_height: usize,
    pub candidate_cutter_ratio: Option<f64>,
    pub whitespace_score: f64,
    pub text_axis: Option<TextAxisHint>,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

struct PreparedPage {
    rotated_source: GrayImage,
    normalized: Arc<GrayImage>,
    analysis_normalized: Option<Arc<GrayImage>>,
    analysis_scale_x: f64,
    analysis_scale_y: f64,
    calibration: PageCalibration,
    rotated_color: Option<RgbImage>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    split: SplitResult,
    split_cache_key: Option<StageCacheKey>,
    output_mode_recommendation: Option<OutputModeRecommendation>,
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
    split_cache_key: Option<StageCacheKey>,
    output_mode_recommendation: Option<OutputModeRecommendation>,
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
    content_picture_mask: Option<Arc<BinaryImage>>,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    resolved_output_mode: OutputMode,
    analysis_threshold: u8,
    text_axis: Option<TextAxisHint>,
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
        true,
        document_prior,
        CalibrationConfig::default(),
        cache,
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
    cache: &PageCache,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_color_and_document_prior_impl(
        source,
        color_source,
        options,
        document_prior,
        recommend_output_mode,
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
        true,
        recommend_output_mode,
        document_prior,
        CalibrationConfig::default(),
        cache,
        timings,
    );
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
        let content_picture_mask = prepared
            .content_picture_mask
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let (detected_content, content_diagnostics) = if let Some(manual) =
            options.resolved_manual_content_for(half, prepared.full_width, prepared.full_height)
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
        let content = content_result_for_dimensions(
            region.width.ceil().max(1.0) as usize,
            region.height.ceil().max(1.0) as usize,
            options.dpi,
            detected_content,
            options.margins_mm.map(crate::MarginsMm::values),
            options.margins_pixels,
        );
        let crop_enabled = options.crop_content && content.content.is_some();
        let local_crop = if crop_enabled {
            content.output_rect
        } else {
            Rect::new(0.0, 0.0, region.width, region.height)
        };
        AnalysisOutputMetadata {
            half,
            source_region: region,
            content_box: content.content,
            content_diagnostics,
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
        }
    })
    .collect();
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
    recommend_output_mode: bool,
}

impl PageRenderPolicy {
    const COMPLETE: Self = Self {
        create_mixed_layers: true,
        recommend_output_mode: true,
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
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
}

pub(crate) fn clean_page_with_color_and_document_prior_cached(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
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
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        Some(cache),
        PageRenderPolicy {
            create_mixed_layers,
            recommend_output_mode,
        },
        timings,
    )
}

fn clean_page_with_color_and_calibration_config(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
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
            blank_outputs_skipped: 0,
            excluded: true,
            rotation: options.rotation,
            output_mode_recommendation: None,
        });
    }
    let prepared = prepare_page(
        source,
        color_source,
        options,
        calibration_config,
        document_prior,
        cache,
        render_policy.recommend_output_mode,
        timings,
    );
    let mut resolved_options;
    let options = if prepared.resolved_output_mode == options.output_mode {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = prepared.resolved_output_mode;
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
        split,
        split_cache_key,
        output_mode_recommendation,
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
            &rotated_source,
            &normalized,
            analysis_normalized.as_deref().unwrap_or(&normalized),
            analysis_scale_x,
            analysis_scale_y,
            calibration,
            rotated_color.as_ref(),
            content_picture_mask.as_deref(),
            picture_mask.as_deref(),
            options,
            source_page_index,
            &split,
            region,
            half,
            cache,
            split_cache_key.as_ref(),
            render_policy.create_mixed_layers,
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
        blank_outputs_skipped,
        excluded: false,
        rotation: options.rotation,
        output_mode_recommendation,
    })
}

fn prepare_page(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    calibration_config: CalibrationConfig,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    recommend_output_mode: bool,
    timings: &mut PageStageTimings,
) -> PreparedPage {
    let PreparedAnalysis {
        normalized: analysis_normalized,
        split,
        scale_x,
        scale_y,
        calibration,
        content_picture_mask: analysis_content_picture_mask,
        picture_mask: analysis_picture_mask,
        full_width,
        full_height,
        split_cache_key,
        output_mode_recommendation,
        resolved_output_mode,
        ..
    } = prepare_analysis_page(
        source,
        color_source,
        options,
        true,
        recommend_output_mode,
        document_prior,
        calibration_config,
        cache,
        timings,
    );
    let mut resolved_options;
    let options = if resolved_output_mode == options.output_mode {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = resolved_output_mode;
        &resolved_options
    };
    let (rotated_source, _) = rotate_orthogonal(source, options.rotation);
    let analysis_is_full = analysis_normalized.width() == full_width
        && analysis_normalized.height() == full_height
        && scale_x == 1.0
        && scale_y == 1.0;
    let mut picture_mask = if options.output_mode == OutputMode::Mixed {
        if analysis_is_full {
            analysis_picture_mask.clone()
        } else {
            let mut mask = detect_picture_mask(&rotated_source, options.dpi, calibration);
            apply_manual_zones(&mut mask, options);
            Some(Arc::new(mask))
        }
    } else {
        None
    };
    let rotated_color = color_source
        .map(|image| rotate_rgb_orthogonal(image, options.rotation))
        .map(|image| {
            if options.normalize_illumination {
                if let Some(mask) = picture_mask.as_deref() {
                    normalize_illumination_rgb_with_picture_mask(
                        &rotated_source,
                        &image,
                        options.dpi,
                        Some(mask),
                    )
                } else {
                    normalize_illumination_rgb(&rotated_source, &image, options.dpi)
                }
            } else {
                image
            }
        });
    let (normalized, analysis_normalized) = if analysis_is_full {
        (analysis_normalized, None)
    } else {
        let normalized = if options.normalize_illumination {
            if let Some(mask) = picture_mask.as_deref() {
                normalize_illumination_with_picture_mask(&rotated_source, options.dpi, Some(mask))
            } else {
                normalize_illumination(&rotated_source, options.dpi)
            }
        } else {
            rotated_source.clone()
        };
        (Arc::new(normalized), Some(analysis_normalized))
    };
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
        split,
        split_cache_key,
        output_mode_recommendation,
        resolved_output_mode,
    }
}

fn prepare_analysis_page(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    prepare_quality_raster: bool,
    recommend_output_mode: bool,
    document_prior: Option<DocumentPrior>,
    calibration_config: CalibrationConfig,
    cache: Option<&PageCache>,
    timings: &mut PageStageTimings,
) -> PreparedAnalysis {
    let analysis_key = cache.map(|cache| {
        StageCacheKey::analysis(
            &cache.source,
            options,
            prepare_quality_raster,
            recommend_output_mode,
            calibration_config,
        )
    });
    let cached_analysis = cache
        .zip(analysis_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<AnalysisArtifact>(key));
    let analysis = cached_analysis.unwrap_or_else(|| {
        let analysis_started = Instant::now();
        let AnalysisLevel {
            image,
            effective_dpi,
            scale_x: source_scale_x,
            scale_y: source_scale_y,
        } = build_analysis_level(source, options.dpi, 150.0);
        let (rotated, _) = rotate_orthogonal(&image, options.rotation);
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
        debug_assert!((scale_x - source_scale_x.min(source_scale_y)).abs() < 0.01);
        timings.analysis_level_ms += analysis_started.elapsed().as_secs_f64() * 1_000.0;

        let normalization_started = Instant::now();
        let layout_normalized = if options.normalize_illumination {
            normalize_illumination_for_layout(&rotated)
        } else {
            rotated.clone()
        };
        let calibration =
            PageCalibration::estimate(&layout_normalized, effective_dpi, calibration_config);
        let picture_mask = {
            let mut mask = detect_picture_mask(&rotated, effective_dpi, calibration);
            apply_manual_zones(&mut mask, options);
            Some(Arc::new(mask))
        };
        let content_picture_mask = picture_mask
            .as_deref()
            .map(|mask| Arc::new(extend_picture_mask_for_content(&rotated, mask, calibration)));
        let output_mode_recommendation = recommend_output_mode.then(|| {
            let text_line_count = detect_content_and_margins_calibrated(
                &layout_normalized,
                picture_mask.as_deref(),
                effective_dpi,
                None,
                Some([0.0; 4]),
                calibration,
            )
            .diagnostics
            .map(|diagnostics| diagnostics.text_mask.line_count)
            .unwrap_or(0);
            crate::mode_select::recommend_output_mode(PreparedModeEvidence {
                analysis: &rotated,
                analysis_rgb: analysis_rgb.as_ref(),
                picture_mask: picture_mask
                    .as_deref()
                    .expect("analysis always prepares a picture mask"),
                text_line_count,
            })
        });
        let resolved_output_mode = if options.output_mode == OutputMode::Auto {
            output_mode_recommendation
                .map(|recommendation| recommendation.mode)
                .unwrap_or(options.output_mode)
        } else {
            options.output_mode
        };
        let normalized = if options.normalize_illumination {
            if prepare_quality_raster {
                if resolved_output_mode == OutputMode::Mixed {
                    let mask = picture_mask
                        .as_deref()
                        .expect("mixed mode prepares a picture mask");
                    normalize_illumination_with_picture_mask(&rotated, effective_dpi, Some(mask))
                } else {
                    normalize_illumination(&rotated, effective_dpi)
                }
            } else {
                layout_normalized.clone()
            }
        } else {
            rotated
        };
        let analysis_threshold = otsu_threshold(&layout_normalized);
        let text_axis = detect_text_axis(&layout_normalized, analysis_threshold);
        let artifact = Arc::new(AnalysisArtifact {
            normalized: Arc::new(normalized),
            layout_normalized: Arc::new(layout_normalized),
            scale_x,
            scale_y,
            full_width,
            full_height,
            calibration,
            effective_dpi,
            picture_mask,
            content_picture_mask,
            output_mode_recommendation,
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
            recommend_output_mode,
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
        let mut split = if options.ocr_mode {
            detect_split_at_analysis_level_with_threshold(
                &analysis.layout_normalized,
                analysis.effective_dpi,
                crate::LayoutMode::Single,
                None,
                analysis_threshold,
                None,
            )
        } else {
            detect_split_at_analysis_level_with_threshold(
                &analysis.layout_normalized,
                analysis.effective_dpi,
                options.layout,
                options.resolved_manual_split_x(analysis.normalized.width()),
                analysis_threshold,
                applicable_prior,
            )
        };
        if matches!(options.layout, crate::LayoutMode::Auto) && options.manual_split_x.is_none() {
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
        if (analysis.scale_x < 1.0 || analysis.scale_y < 1.0)
            && matches!(options.layout, crate::LayoutMode::Auto)
            && options.manual_split_x.is_none()
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
        split_cache_key: split_key,
        output_mode_recommendation: analysis.output_mode_recommendation,
        resolved_output_mode: analysis.resolved_output_mode,
    }
}

fn analysis_artifact_bytes(artifact: &AnalysisArtifact) -> usize {
    let gray = artifact.normalized.data().len() + artifact.layout_normalized.data().len();
    let picture_mask = artifact
        .picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let content_picture_mask = artifact
        .content_picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    gray.saturating_add(picture_mask)
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
    options: &CleanupOptions,
    source_page_index: usize,
    split: &SplitResult,
    region: Rect,
    half: PageHalf,
    cache: Option<&PageCache>,
    split_cache_key: Option<&StageCacheKey>,
    create_mixed_layers: bool,
    timings: &mut PageStageTimings,
) -> Result<CleanupResult, String> {
    let working = crop_gray(normalized, region);
    let analysis_region = Rect::new(
        region.x * analysis_scale_x,
        region.y * analysis_scale_y,
        region.width * analysis_scale_x,
        region.height * analysis_scale_y,
    );
    let analysis_working = crop_gray(analysis_normalized, analysis_region);
    let analysis_picture_working =
        analysis_picture_mask.map(|mask| crop_binary(mask, analysis_region));
    let local_scale_x = analysis_working.width() as f64 / working.width().max(1) as f64;
    let local_scale_y = analysis_working.height() as f64 / working.height().max(1) as f64;
    let deskew_key = cache
        .zip(split_cache_key)
        .map(|(cache, split_key)| StageCacheKey::deskew(&cache.source, options, split_key, region));
    let deskew_started = Instant::now();
    let deskew = if let Some(angle_degrees) = options.manual_skew_degrees {
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
    let local_deskew_forward = deskew_transform(working.width(), working.height(), deskew);
    let local_deskew_inverse = local_deskew_forward
        .inverse()
        .ok_or("Deskew transform is not invertible")?;
    let analysis_deskew_forward =
        deskew_transform(analysis_working.width(), analysis_working.height(), deskew);
    let analysis_deskew_inverse = analysis_deskew_forward
        .inverse()
        .ok_or("Cleanup analysis deskew transform is not invertible")?;
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
    let automatic_dewarp = if options.dewarp.is_none() && options.experimental.auto_dewarp {
        let mut detected = detect_curves_at_dpi_with_depth(
            &working,
            calibration.effective_dpi,
            options.experimental.auto_dewarp_depth,
        );
        detected.model = detected
            .model
            .map(|model| transform_dewarp_options(&model, Affine::translation(region.x, region.y)));
        Some(detected)
    } else {
        None
    };
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
    let detected = if let Some(cached) = cached_content {
        cached.as_ref().clone()
    } else {
        let detected = if let Some(manual) =
            options.resolved_manual_content_for(half, normalized.width(), normalized.height())
        {
            let left = manual
                .x
                .clamp(0.0, working.width().saturating_sub(1) as f64);
            let top = manual
                .y
                .clamp(0.0, working.height().saturating_sub(1) as f64);
            let right = manual.right().clamp(left + 1.0, working.width() as f64);
            let bottom = manual.bottom().clamp(top + 1.0, working.height() as f64);
            let source_content = Rect::new(left, top, right - left, bottom - top);
            let deskewed_content = transform_rect_bounds(source_content, local_deskew_forward);
            let output_content = if let Some(model) = &dewarp_model {
                map_rect_bounds(deskewed_content, |point| {
                    model.map_source_to_unit_approx(point).map(|unit| {
                        Point::new(
                            unit.x * working.width() as f64,
                            unit.y * working.height() as f64,
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
            let detected_result = detect_content_and_margins_calibrated(
                content_analysis,
                content_picture_mask,
                calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                calibration,
            );
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
                                point.x / working.width() as f64,
                                point.y / working.height() as f64,
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
    let content = content_result_for_dimensions(
        working.width(),
        working.height(),
        options.dpi,
        detected.detected_content,
        options.margins_mm.map(crate::MarginsMm::values),
        options.margins_pixels,
    );
    let source_content_box = detected.source_content_box;
    let content_diagnostics = detected.diagnostics;
    let crop_enabled = options.crop_content && !options.ocr_mode && content.content.is_some();
    let output_rect = if crop_enabled {
        content.output_rect
    } else {
        Rect::new(0.0, 0.0, working.width() as f64, working.height() as f64)
    };
    let output_width = output_rect.width.ceil().max(1.0) as usize;
    let output_height = output_rect.height.ceil().max(1.0) as usize;
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
        working.width(),
        working.height(),
        render_rect,
    );
    let rendered_width = render_plan.output_width();
    let rendered_height = render_plan.output_height();

    let render_started = Instant::now();
    let (rendered_gray, rendered_color, forward_transform, inverse_transform, dewarp_mapping) =
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
                        working.width(),
                        working.height(),
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
                render_affine_gray(normalized, rendered_width, rendered_height, inverse),
                color_source.map(|color| {
                    render_affine_rgb(color, rendered_width, rendered_height, inverse)
                }),
                Some(forward),
                Some(inverse),
                None,
            )
        };
    let (forward_transform, inverse_transform) =
        if let (Some(forward), Some(region)) = (forward_transform, sampled_region) {
            let intrinsic_forward = forward.then(Affine::translation(region.x, region.y));
            (Some(intrinsic_forward), intrinsic_forward.inverse())
        } else {
            (forward_transform, inverse_transform)
        };
    let rendered_picture_mask = source_picture_mask.map(|mask| {
        render_binary_mask(mask, rendered_width, rendered_height, |point| {
            render_plan.output_to_source(point)
        })
    });
    let effectively_blank = is_effectively_blank(&rendered_gray, options.dpi);
    let fail_closed_blank = content.content.is_none() && effectively_blank;
    let (
        mut image,
        mut color_image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mut mixed_layers,
    ) = if fail_closed_blank {
        (
            GrayImage::new(rendered_width, rendered_height, 255),
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
                let (fresh_binary, diagnostics, fresh_despeckle_fallback) =
                    binarize_normalized_with_diagnostics(
                        &rendered_gray,
                        &routing_sample,
                        options,
                        calibration,
                    );
                let mode = diagnostics.route;
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
                    postprocess_binary_with_diagnostics(
                        binary,
                        Some(&rendered_gray),
                        options,
                        calibration,
                    )
                } else {
                    (fresh_binary, fresh_despeckle_fallback)
                };
                (
                    binary_to_gray(&binary),
                    None,
                    Some(mode),
                    Some(diagnostics),
                    despeckle_fallback,
                    None,
                )
            }
            OutputMode::Mixed => {
                let picture_mask = rendered_picture_mask
                    .as_ref()
                    .expect("mixed output prepares a picture mask");
                if picture_mask.count_black() == 0 {
                    let routing_sample = crop_gray_to_fit(routing_source, region, 256, 256);
                    let (binary, diagnostics, despeckle_fallback) =
                        binarize_normalized_with_diagnostics(
                            &rendered_gray,
                            &routing_sample,
                            options,
                            calibration,
                        );
                    let mode = diagnostics.route;
                    (
                        binary_to_gray(&binary),
                        None,
                        Some(mode),
                        Some(diagnostics),
                        despeckle_fallback,
                        None,
                    )
                } else {
                    let (binary, diagnostics, despeckle_fallback) =
                        binarize_normalized_with_diagnostics_excluding(
                            &rendered_gray,
                            options,
                            calibration,
                            picture_mask,
                        );
                    let mode = diagnostics.route;
                    let (mixed_gray, mixed_color, layers) = compose_mixed(
                        &rendered_gray,
                        rendered_color.as_ref(),
                        &binary,
                        picture_mask,
                        options.dpi,
                        create_mixed_layers,
                    );
                    (
                        mixed_gray,
                        mixed_color,
                        Some(mode),
                        Some(diagnostics),
                        despeckle_fallback,
                        layers,
                    )
                }
            }
            OutputMode::Grayscale => (rendered_gray, None, None, None, false, None),
            OutputMode::Color => (rendered_gray, rendered_color, None, None, false, None),
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
        image = crop_gray(&image, payload_rect);
        color_image = color_image.map(|source| crop_rgb(&source, payload_rect));
        mixed_layers = mixed_layers.map(|layers| MixedLayers {
            foreground_mask: crop_gray(&layers.foreground_mask, payload_rect),
            background: crop_gray(&layers.background, payload_rect),
            color_background: layers
                .color_background
                .map(|source| crop_rgb(&source, payload_rect)),
        });
    }
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
            output_mode: options.output_mode,
            bilevel_written: false,
            layered_written: false,
            layered_background_dpi: None,
            illumination_normalized: options.normalize_illumination,
            binarization_mode,
            binarization_diagnostics,
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
    map: impl Fn(Point) -> Option<Point>,
) -> BinaryImage {
    let mut output = BinaryImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
                continue;
            };
            let source_x = mapped.x.round() as isize;
            let source_y = mapped.y.round() as isize;
            if source_x >= 0
                && source_y >= 0
                && source_x < source.width() as isize
                && source_y < source.height() as isize
                && source.get(source_x as usize, source_y as usize)
            {
                output.set(x, y, true);
            }
        }
    }
    output
}

fn compose_mixed(
    gray: &GrayImage,
    color: Option<&RgbImage>,
    binary: &BinaryImage,
    picture_mask: &BinaryImage,
    dpi: f64,
    create_layers: bool,
) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    // The final stencil owns only its black pixels. Everything excluded from it,
    // including the picture-mask dilation halo, must retain source tone here so
    // no source content can disappear from both layers.
    let mut mixed_gray = gray.clone();
    let mut mixed_color = color.cloned();
    let feather_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 48.0) as usize;
    let distance_to_picture_exterior = squared_euclidean_distance(&picture_mask.invert());
    let distance_to_stencil = squared_euclidean_distance(binary);
    let stencil_adjacency_squared = (feather_radius * feather_radius) as u32;
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let index = y * gray.width() + x;
            if picture_mask.get(x, y) {
                let source_gray = gray.get(x, y);
                let alpha = if distance_to_stencil[index] <= stencil_adjacency_squared {
                    let spatial_alpha = (f64::from(distance_to_picture_exterior[index]).sqrt()
                        / feather_radius as f64)
                        .clamp(0.0, 1.0);
                    let dark_detail_alpha =
                        ((245.0 - f64::from(source_gray)) / 96.0).clamp(0.0, 1.0);
                    spatial_alpha.max(dark_detail_alpha)
                } else {
                    1.0
                };
                let value = reserve_gray_endpoint(
                    (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                        .round()
                        .clamp(0.0, 255.0) as u8,
                );
                mixed_gray.set(x, y, value);
                if let (Some(source), Some(output)) = (color, mixed_color.as_mut()) {
                    output.set(
                        x,
                        y,
                        reserve_rgb_endpoints(source.get(x, y).map(|channel| {
                            (255.0 * (1.0 - alpha) + f64::from(channel) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8
                        })),
                    );
                }
            }
        }
    }
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if binary.get(x, y) {
                mixed_gray.set(x, y, 0);
                if let Some(output) = mixed_color.as_mut() {
                    output.set(x, y, [0; 3]);
                }
            }
        }
    }
    let layers = create_layers.then(|| {
        let foreground_mask = binary_to_gray(binary);
        let mut background = mixed_gray.clone();
        let mut color_background = mixed_color.clone();
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                if binary.get(x, y) {
                    background.set(x, y, 255);
                    if let Some(output) = color_background.as_mut() {
                        output.set(x, y, [255; 3]);
                    }
                }
            }
        }
        MixedLayers {
            foreground_mask,
            background,
            color_background,
        }
    });
    (mixed_gray, mixed_color, layers)
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
    let (output_width, output_height) = match rotation {
        OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => (width, height),
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => (height, width),
    };
    let mut output = RgbImage::new(output_width, output_height, [255; 3]);
    for y in 0..height {
        for x in 0..width {
            let (target_x, target_y) = match rotation {
                OrthogonalRotation::None => (x, y),
                OrthogonalRotation::Clockwise90 => (height - 1 - y, x),
                OrthogonalRotation::Clockwise180 => (width - 1 - x, height - 1 - y),
                OrthogonalRotation::Clockwise270 => (y, width - 1 - x),
            };
            output.set(target_x, target_y, source.get(x, y));
        }
    }
    output
}

fn rotate_orthogonal(source: &GrayImage, rotation: OrthogonalRotation) -> (GrayImage, Affine) {
    let (width, height) = (source.width(), source.height());
    let (output_width, output_height, forward) = match rotation {
        OrthogonalRotation::None => (width, height, Affine::IDENTITY),
        OrthogonalRotation::Clockwise90 => (
            height,
            width,
            Affine {
                matrix: [[0.0, -1.0, height as f64], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            },
        ),
        OrthogonalRotation::Clockwise180 => (
            width,
            height,
            Affine {
                matrix: [
                    [-1.0, 0.0, width as f64],
                    [0.0, -1.0, height as f64],
                    [0.0, 0.0, 1.0],
                ],
            },
        ),
        OrthogonalRotation::Clockwise270 => (
            height,
            width,
            Affine {
                matrix: [[0.0, 1.0, 0.0], [-1.0, 0.0, width as f64], [0.0, 0.0, 1.0]],
            },
        ),
    };
    let mut output = GrayImage::new(output_width, output_height, 255);
    for y in 0..height {
        for x in 0..width {
            let (target_x, target_y) = match rotation {
                OrthogonalRotation::None => (x, y),
                OrthogonalRotation::Clockwise90 => (height - 1 - y, x),
                OrthogonalRotation::Clockwise180 => (width - 1 - x, height - 1 - y),
                OrthogonalRotation::Clockwise270 => (y, width - 1 - x),
            };
            output.set(target_x, target_y, source.get(x, y));
        }
    }
    (output, forward)
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
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
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
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width =
        (rect.width.round().max(1.0) as usize).min(source.width().saturating_sub(left).max(1));
    let height =
        (rect.height.round().max(1.0) as usize).min(source.height().saturating_sub(top).max(1));
    let scale = (width as f64 / max_width.max(1) as f64)
        .max(height as f64 / max_height.max(1) as f64)
        .max(1.0);
    let output_width = (width as f64 / scale).round().max(1.0) as usize;
    let output_height = (height as f64 / scale).round().max(1.0) as usize;
    let mut output = GrayImage::new(output_width, output_height, 255);
    for y in 0..output_height {
        let source_y = top + ((y * height + height / 2) / output_height).min(height - 1);
        for x in 0..output_width {
            let source_x = left + ((x * width + width / 2) / output_width).min(width - 1);
            output.set(x, y, source.get(source_x, source_y));
        }
    }
    output
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
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let sum = sample_offsets
                    .iter()
                    .map(|&(ox, oy)| {
                        let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                        u32::from(sample_bilinear_white(source, mapped.x, mapped.y))
                    })
                    .sum::<u32>();
                *target = (sum / sample_offsets.len() as u32) as u8;
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
    output
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.chunks_exact_mut(3).enumerate() {
                let mut sum = [0u32; 3];
                for &(ox, oy) in sample_offsets {
                    let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                    let sample = sample_bilinear_rgb_white(source, mapped.x, mapped.y);
                    for channel in 0..3 {
                        sum[channel] += u32::from(sample[channel]);
                    }
                }
                for channel in 0..3 {
                    target[channel] = (sum[channel] / sample_offsets.len() as u32) as u8;
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
