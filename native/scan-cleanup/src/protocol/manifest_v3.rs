use crate::{split::DocumentPrior, CleanupOptions};
use evb_native_support::{NativeError, NativeErrorCode};
use scan_primitives::Point;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const VERSION: u32 = 3;

/// Optional diagnostic geometry for a non-straight page seam. The existing
/// cutter and page polygons remain the rendering contract; consumers that do
/// not know about this additive field continue to cut at `cutterXPx`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitSeamPolyline {
    pub points: Vec<Point>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSideConfidence {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiagnosticRect {
    pub x_px: usize,
    pub y_px: usize,
    pub width_px: usize,
    pub height_px: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTextMaskSummary {
    pub analysis_width_px: usize,
    pub analysis_height_px: usize,
    pub ink_pixels: usize,
    pub line_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ContentDiagnosticRect>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentTrimSide {
    Left,
    Top,
    Right,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlockEvidence {
    pub bounds: ContentDiagnosticRect,
    pub picture_mask_overlap_pixels: usize,
    pub heading_evidence: bool,
    pub grayscale_evidence: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAcceptedTrim {
    pub side: ContentTrimSide,
    pub iteration: usize,
    pub score: f64,
    pub threshold: f64,
    pub content_distance_sum: f64,
    pub garbage_distance_sum: f64,
    pub removed_blocks: Vec<ContentBlockEvidence>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiagnostics {
    pub side_confidence: ContentSideConfidence,
    pub text_mask: ContentTextMaskSummary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_trims: Vec<ContentAcceptedTrim>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protected_blocks: Vec<ContentBlockEvidence>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Analyze,
    Render,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum RenderMode {
    Preview,
    Final,
}

pub use crate::domain::geometry::CanvasScope;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The one rectangle and pixel grid every matched output of this document is
/// normalized onto. The owning process measures it from the source page
/// geometry so a preview and the final run place their pages identically.
pub struct DocumentCanvas {
    pub width_points: f64,
    pub height_points: f64,
    pub width_px: usize,
    pub height_px: usize,
}

impl DocumentCanvas {
    /// Pixels per inch of the canvas grid, which is the one output resolution
    /// every page of the document is resampled to.
    pub fn dpi(&self) -> f64 {
        self.width_px as f64 / self.width_points * 72.0
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageOutput {
    pub output_path: PathBuf,
    pub metadata_path: PathBuf,
    #[serde(default)]
    pub bilevel_output_path: Option<PathBuf>,
    #[serde(default)]
    pub background_output_path: Option<PathBuf>,
    #[serde(default)]
    pub foreground_mask_output_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetailPixelRect {
    pub x_px: f64,
    pub y_px: f64,
    pub width_px: f64,
    pub height_px: f64,
}

impl DetailPixelRect {
    pub fn as_rect(&self) -> scan_primitives::Rect {
        scan_primitives::Rect::new(self.x_px, self.y_px, self.width_px, self.height_px)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetailRenderPlan {
    pub base_metadata_path: PathBuf,
    pub base_raster_path: PathBuf,
    pub source_crop: DetailPixelRect,
    pub full_source_width_px: usize,
    pub full_source_height_px: usize,
    pub scale: f64,
    pub render_region: DetailPixelRect,
    pub sampled_region: DetailPixelRect,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub input_path: PathBuf,
    pub source_page_index: usize,
    pub page_metadata_path: PathBuf,
    /// Any serialized dewarp directrices inside `options` are authored in
    /// source-rotated page coordinates (before deskew, dewarp, and crop).
    pub options: CleanupOptions,
    #[serde(default)]
    pub document_prior: Option<DocumentPrior>,
    #[serde(default)]
    pub detail_render_plan: Option<DetailRenderPlan>,
    pub outputs: Vec<PageOutput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestV3 {
    pub version: u32,
    pub operation: Operation,
    pub render_mode: RenderMode,
    pub canvas_scope: CanvasScope,
    #[serde(default)]
    pub document_canvas: Option<DocumentCanvas>,
    /// Physical memory of the host that authored this manifest. The sidecar has
    /// no portable way to read it, so the owning process reports it here and the
    /// worker pool and stage cache are sized from it. Absent for direct CLI
    /// invocations, which then size themselves conservatively.
    #[serde(default)]
    pub host_memory_bytes: Option<u64>,
    pub pages: Vec<Page>,
}

impl ManifestV3 {
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.version != VERSION {
            return Err(invalid(format!(
                "Unsupported scan-cleanup manifest version {}; expected {VERSION}",
                self.version
            )));
        }
        if self.pages.is_empty() {
            return Err(invalid("Batch manifest contains no pages"));
        }
        if self.document_canvas.is_some_and(|canvas| {
            !canvas.width_points.is_finite()
                || canvas.width_points <= 0.0
                || !canvas.height_points.is_finite()
                || canvas.height_points <= 0.0
                || canvas.width_px == 0
                || canvas.height_px == 0
        }) {
            return Err(invalid(
                "Document canvas dimensions must be positive finite points and pixels",
            ));
        }
        if self.host_memory_bytes == Some(0) {
            return Err(invalid("Host memory must be a positive byte count"));
        }
        for page in &self.pages {
            page.options.validate().map_err(invalid)?;
            if page.options.render_crop.is_some()
                && (self.operation != Operation::Render || self.render_mode != RenderMode::Preview)
            {
                return Err(invalid(
                    "Render crop is supported only by preview render manifests",
                ));
            }
            if page.options.render_crop.is_some() && page.options.match_page_size {
                return Err(invalid(
                    "Render crop cannot be combined with matched page-size output",
                ));
            }
            if let Some(detail) = &page.detail_render_plan {
                if self.operation != Operation::Render || self.render_mode != RenderMode::Preview {
                    return Err(invalid(
                        "Detail source rendering is supported only by preview render manifests",
                    ));
                }
                if page.options.render_crop.is_some() || page.options.match_page_size {
                    return Err(invalid(
                        "Detail source rendering cannot combine with render crop or matched page size",
                    ));
                }
                if !detail.scale.is_finite()
                    || detail.scale <= 0.0
                    || detail.full_source_width_px == 0
                    || detail.full_source_height_px == 0
                    || !valid_detail_rect(&detail.source_crop)
                    || !valid_detail_rect(&detail.render_region)
                    || !valid_detail_rect(&detail.sampled_region)
                {
                    return Err(invalid("Detail render plan dimensions are invalid"));
                }
                let source = detail.source_crop.as_rect();
                if source.right() > detail.full_source_width_px as f64
                    || source.bottom() > detail.full_source_height_px as f64
                {
                    return Err(invalid("Detail source crop exceeds the full source raster"));
                }
                let render = detail.render_region.as_rect();
                let sampled = detail.sampled_region.as_rect();
                if render.x < sampled.x
                    || render.y < sampled.y
                    || render.right() > sampled.right()
                    || render.bottom() > sampled.bottom()
                {
                    return Err(invalid(
                        "Detail render region must be contained by the sampled region",
                    ));
                }
            }
            if let Some(prior) = page.document_prior {
                prior.validate().map_err(invalid)?;
            }
            if self.operation == Operation::Render && page.outputs.is_empty() {
                return Err(invalid(
                    "Render page requires at least one output destination",
                ));
            }
        }
        Ok(())
    }
}

fn valid_detail_rect(rect: &DetailPixelRect) -> bool {
    rect.x_px.is_finite()
        && rect.y_px.is_finite()
        && rect.width_px.is_finite()
        && rect.height_px.is_finite()
        && rect.x_px >= 0.0
        && rect.y_px >= 0.0
        && rect.width_px > 0.0
        && rect.height_px > 0.0
}

fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SplitGeometryResult {
        cutter_x_px: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        split_seam: Option<SplitSeamPolyline>,
    }

    #[test]
    fn shared_golden_manifests_deserialize_and_validate() {
        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol");
        for name in [
            "preview-raster-v3.json",
            "detect-all-v3.json",
            "raster-final-v3.json",
            "lossless-final-v3.json",
            "populated-raster-v3.json",
        ] {
            let bytes = std::fs::read(fixture_dir.join(name)).unwrap();
            let manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
            manifest.validate().unwrap();
        }
    }

    #[test]
    fn every_manifest_level_rejects_unknown_fields() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{"unknownOption":true}}]
        }"#;
        assert!(serde_json::from_str::<ManifestV3>(json).is_err());
        let root_unknown = json.replace("\"pages\"", "\"unknownRoot\":true,\"pages\"");
        assert!(serde_json::from_str::<ManifestV3>(&root_unknown).is_err());
        let page_unknown = json.replace("\"outputs\":[]", "\"unknownPage\":true,\"outputs\":[]");
        assert!(serde_json::from_str::<ManifestV3>(&page_unknown).is_err());
    }

    #[test]
    fn additive_option_defaults_are_derived_when_new_fields_are_absent() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[
              {"inputPath":"enabled.png","sourcePageIndex":0,"pageMetadataPath":"enabled.json",
               "outputs":[],"options":{"despeckle":true}},
              {"inputPath":"disabled.png","sourcePageIndex":1,"pageMetadataPath":"disabled.json",
               "outputs":[],"options":{"despeckle":false}}
            ]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();

        assert_eq!(
            manifest.pages[0].options.effective_despeckle_level(),
            crate::DespeckleLevel::Normal
        );
        assert_eq!(
            manifest.pages[1].options.effective_despeckle_level(),
            crate::DespeckleLevel::Off
        );
        for page in &manifest.pages {
            assert_eq!(page.options.render_crop, None);
            assert!(page.options.manual_zones.picture.is_empty());
            assert!(page.options.manual_zones.fill.is_empty());
            assert_eq!(page.options.manual_skew_degrees, None);
            assert_eq!(page.options.experimental.auto_dewarp_depth, None);
        }
    }

    #[test]
    fn host_memory_is_optional_and_must_be_positive_when_present() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{}}]
        }"#;
        let absent: ManifestV3 = serde_json::from_str(json).unwrap();
        absent.validate().unwrap();
        assert_eq!(absent.host_memory_bytes, None);

        let reported: ManifestV3 = serde_json::from_str(
            &json.replace("\"pages\"", "\"hostMemoryBytes\":34359738368,\"pages\""),
        )
        .unwrap();
        reported.validate().unwrap();
        assert_eq!(reported.host_memory_bytes, Some(34_359_738_368));

        let zeroed: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"hostMemoryBytes\":0,\"pages\""))
                .unwrap();
        assert!(zeroed
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Host memory"));
    }

    #[test]
    fn render_crop_is_additive_and_preview_only() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.validate().unwrap();
        assert_eq!(
            manifest.pages[0].options.render_crop,
            Some(crate::NormalizedRect {
                x: 0.25,
                y: 0.2,
                width: 0.5,
                height: 0.4,
                rotation: crate::OrthogonalRotation::None,
            })
        );

        manifest.render_mode = RenderMode::Final;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("preview render"));

        manifest.render_mode = RenderMode::Preview;
        manifest.pages[0].options.match_page_size = true;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("matched page-size"));
    }

    #[test]
    fn detail_render_plan_is_preview_only_and_bounded() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].options.render_crop = None;
        manifest.pages[0].detail_render_plan = Some(DetailRenderPlan {
            base_metadata_path: PathBuf::from("base.json"),
            base_raster_path: PathBuf::from("base.png"),
            source_crop: DetailPixelRect {
                x_px: 10.0,
                y_px: 20.0,
                width_px: 100.0,
                height_px: 120.0,
            },
            full_source_width_px: 400,
            full_source_height_px: 600,
            scale: 4.0,
            render_region: DetailPixelRect {
                x_px: 80.0,
                y_px: 100.0,
                width_px: 120.0,
                height_px: 160.0,
            },
            sampled_region: DetailPixelRect {
                x_px: 64.0,
                y_px: 84.0,
                width_px: 152.0,
                height_px: 192.0,
            },
        });
        manifest.validate().unwrap();

        manifest.pages[0]
            .detail_render_plan
            .as_mut()
            .unwrap()
            .source_crop
            .width_px = 1_000.0;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("full source raster"));
        manifest.pages[0]
            .detail_render_plan
            .as_mut()
            .unwrap()
            .source_crop
            .width_px = 100.0;
        manifest.render_mode = RenderMode::Final;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("preview render"));
    }

    #[test]
    fn advanced_controls_parse_additively_and_validate() {
        let json = r#"{
            "version":3,"operation":"render","renderMode":"preview","canvasScope":"page",
            "pages":[{
                "inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
                "outputs":[{"outputPath":"out.png","metadataPath":"out.json"}],
                "options":{
                    "manualSkewDegrees":-2.5,
                    "experimental":{"autoDewarp":true,"autoDewarpDepth":1.75}
                }
            }]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.pages[0].options.manual_skew_degrees, Some(-2.5));
        assert_eq!(
            manifest.pages[0].options.experimental.auto_dewarp_depth,
            Some(1.75)
        );
    }

    #[test]
    fn optional_split_seam_is_omitted_when_absent_and_additive_when_present() {
        let straight = serde_json::to_value(SplitGeometryResult {
            cutter_x_px: Some(120.0),
            split_seam: None,
        })
        .unwrap();
        assert_eq!(straight, serde_json::json!({"cutterXPx": 120.0}));

        let curved = serde_json::to_value(SplitGeometryResult {
            cutter_x_px: Some(120.0),
            split_seam: Some(SplitSeamPolyline {
                points: vec![Point::new(119.0, 0.5), Point::new(121.0, 9.5)],
            }),
        })
        .unwrap();
        assert_eq!(curved["splitSeam"]["points"].as_array().unwrap().len(), 2);
    }
}
