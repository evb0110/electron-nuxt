use crate::{split::DocumentPrior, CleanupOptions};
use evb_native_support::{NativeError, NativeErrorCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const VERSION: u32 = 2;

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiagnostics {
    pub side_confidence: ContentSideConfidence,
    pub text_mask: ContentTextMaskSummary,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageOutput {
    pub output_path: PathBuf,
    pub metadata_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub input_path: PathBuf,
    pub source_page_index: usize,
    pub page_metadata_path: PathBuf,
    pub options: CleanupOptions,
    #[serde(default)]
    pub document_prior: Option<DocumentPrior>,
    pub outputs: Vec<PageOutput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestV2 {
    pub version: u32,
    pub operation: Operation,
    pub render_mode: RenderMode,
    pub canvas_scope: CanvasScope,
    pub pages: Vec<Page>,
}

impl ManifestV2 {
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

    #[test]
    fn shared_golden_manifests_deserialize_and_validate() {
        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol");
        for name in [
            "preview-raster-v2.json",
            "detect-all-v2.json",
            "raster-final-v2.json",
            "lossless-final-v2.json",
        ] {
            let bytes = std::fs::read(fixture_dir.join(name)).unwrap();
            let manifest: ManifestV2 = serde_json::from_slice(&bytes).unwrap();
            manifest.validate().unwrap();
        }
    }

    #[test]
    fn every_manifest_level_rejects_unknown_fields() {
        let json = r#"{
            "version":2,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{"unknownOption":true}}]
        }"#;
        assert!(serde_json::from_str::<ManifestV2>(json).is_err());
        let root_unknown = json.replace("\"pages\"", "\"unknownRoot\":true,\"pages\"");
        assert!(serde_json::from_str::<ManifestV2>(&root_unknown).is_err());
        let page_unknown = json.replace("\"outputs\":[]", "\"unknownPage\":true,\"outputs\":[]");
        assert!(serde_json::from_str::<ManifestV2>(&page_unknown).is_err());
    }
}
