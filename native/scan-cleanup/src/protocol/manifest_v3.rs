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
pub struct DocumentCanvas {
    pub width_points: f64,
    pub height_points: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageOutput {
    pub output_path: PathBuf,
    pub metadata_path: PathBuf,
    #[serde(default)]
    pub bilevel_output_path: Option<PathBuf>,
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
        }) {
            return Err(invalid(
                "Document canvas dimensions must be positive finite points",
            ));
        }
        for page in &self.pages {
            page.options.validate().map_err(invalid)?;
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
            assert!(page.options.manual_zones.picture.is_empty());
            assert!(page.options.manual_zones.fill.is_empty());
            assert_eq!(page.options.manual_skew_degrees, None);
            assert_eq!(page.options.experimental.auto_dewarp_depth, None);
        }
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
