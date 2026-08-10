use crate::{split::DocumentPrior, CleanupOptions};
use evb_native_support::{bounded_io::deserialize_bounded_vec, NativeError, NativeErrorCode};
use scan_primitives::Point;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

pub const VERSION: u32 = 3;
pub const MAX_RASTER_WINDOW: usize = 16;
pub const MAX_MANIFEST_PAGES: usize = 20_000;
pub const MAX_MANIFEST_PATH_BYTES: usize = 4_096;

fn deserialize_manifest_pages<'de, D>(deserializer: D) -> Result<Vec<Page>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, Page, MAX_MANIFEST_PAGES>(deserializer)
}

const fn default_raster_window() -> usize {
    1
}

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
    #[serde(default)]
    pub text_evidence: bool,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisPurpose {
    Classification,
    #[default]
    PagePlan,
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

    /// Keeps the document's physical page box while giving a continuous-tone
    /// page the pixel grid it was actually rendered on. Matched page size is a
    /// PDF geometry promise, not permission to inflate every low-resolution
    /// gray/color scan to the finest page's raster dimensions.
    pub fn at_dpi(self, dpi: f64) -> Self {
        Self {
            width_px: ((self.width_points / 72.0 * dpi).round() as usize).max(1),
            height_px: ((self.height_points / 72.0 * dpi).round() as usize).max(1),
            ..self
        }
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
    #[serde(default)]
    pub foreground_alpha_output_path: Option<PathBuf>,
    #[serde(default)]
    pub picture_mask_output_path: Option<PathBuf>,
    #[serde(default)]
    pub tone_preservation_alpha_output_path: Option<PathBuf>,
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
    /// Canonical cleaned base-preview raster for this output half. Detail
    /// rendering replays its source-to-cleaned transfer instead of rebuilding
    /// illumination and text-tone decisions from a viewport crop.
    #[serde(default)]
    pub base_cleaned_raster_path: Option<PathBuf>,
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
    /// White samples in this extracted one-bit PDF soft mask select the
    /// source MRC foreground. It shares input_path's unrotated page grid.
    #[serde(default)]
    pub trusted_foreground_mask_path: Option<PathBuf>,
    /// Native-resolution continuous-tone background extracted from the same
    /// compact MRC page as trusted_foreground_mask_path.
    #[serde(default)]
    pub trusted_mrc_background_path: Option<PathBuf>,
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
    #[serde(default)]
    pub analysis_purpose: AnalysisPurpose,
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
    /// Bounded streamed-raster look-ahead. Direct CLI callers that do not
    /// coordinate producers retain the one-page acknowledgement turnstile.
    #[serde(default = "default_raster_window")]
    pub raster_window: usize,
    #[serde(deserialize_with = "deserialize_manifest_pages")]
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
        if self.pages.len() > MAX_MANIFEST_PAGES {
            return Err(NativeError::new(
                NativeErrorCode::TooLarge,
                format!("Batch manifest exceeds the {MAX_MANIFEST_PAGES}-page admission ceiling"),
            ));
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
        if !(1..=MAX_RASTER_WINDOW).contains(&self.raster_window) {
            return Err(invalid(format!(
                "Raster window must be between 1 and {MAX_RASTER_WINDOW}",
            )));
        }
        if self.operation == Operation::Render
            && self.document_canvas.is_none()
            && self
                .pages
                .iter()
                .any(|page| page.options.match_page_size && !page.options.ocr_mode)
        {
            return Err(invalid(
                "A matched page-size render requires a documentCanvas plan",
            ));
        }
        if self.operation != Operation::Analyze
            && self.analysis_purpose != AnalysisPurpose::PagePlan
        {
            return Err(invalid(
                "analysisPurpose is only valid for analyze manifests",
            ));
        }
        for page in &self.pages {
            page.options.validate().map_err(|error| {
                invalid(format!(
                    "Page {}: {error}",
                    page.source_page_index.saturating_add(1),
                ))
            })?;
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
        for path in self
            .input_paths()
            .into_iter()
            .chain(self.destination_paths())
        {
            if path.as_os_str().to_string_lossy().len() > MAX_MANIFEST_PATH_BYTES {
                return Err(NativeError::new(
                    NativeErrorCode::TooLarge,
                    format!(
                        "Manifest path exceeds the {MAX_MANIFEST_PATH_BYTES}-byte admission ceiling"
                    ),
                ));
            }
        }
        self.validate_destination_paths()?;
        Ok(())
    }

    /// Every path the batch may read. Keeping this list beside the wire
    /// protocol prevents new auxiliary inputs from being missed by the output
    /// alias preflight.
    pub(crate) fn input_paths(&self) -> Vec<&Path> {
        self.pages
            .iter()
            .flat_map(|page| {
                let mut paths = vec![page.input_path.as_path()];
                paths.extend(page.trusted_foreground_mask_path.as_deref());
                paths.extend(page.trusted_mrc_background_path.as_deref());
                if let Some(detail) = &page.detail_render_plan {
                    paths.push(detail.base_metadata_path.as_path());
                    paths.push(detail.base_raster_path.as_path());
                    paths.extend(detail.base_cleaned_raster_path.as_deref());
                }
                paths
            })
            .collect()
    }

    /// Every path the batch may publish, including per-page metadata and all
    /// optional layered outputs.
    pub(crate) fn destination_paths(&self) -> Vec<&Path> {
        self.pages
            .iter()
            .flat_map(|page| {
                let mut paths = vec![page.page_metadata_path.as_path()];
                if self.operation == Operation::Render {
                    for output in &page.outputs {
                        paths.push(output.output_path.as_path());
                        paths.push(output.metadata_path.as_path());
                        paths.extend(output.bilevel_output_path.as_deref());
                        paths.extend(output.background_output_path.as_deref());
                        paths.extend(output.foreground_mask_output_path.as_deref());
                        paths.extend(output.foreground_alpha_output_path.as_deref());
                        paths.extend(output.picture_mask_output_path.as_deref());
                        paths.extend(output.tone_preservation_alpha_output_path.as_deref());
                    }
                }
                paths
            })
            .collect()
    }

    fn validate_destination_paths(&self) -> Result<(), NativeError> {
        let inputs = self
            .input_paths()
            .into_iter()
            .map(normalized_path)
            .collect::<HashSet<_>>();
        let mut destinations = HashSet::new();
        for path in self.destination_paths() {
            let normalized = normalized_path(path);
            if inputs.contains(&normalized) {
                return Err(invalid(format!(
                    "Output destination aliases an input path: {}",
                    path.display()
                )));
            }
            if !destinations.insert(normalized) {
                return Err(invalid(format!(
                    "Output destinations must be unique: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
}

pub(crate) fn normalized_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive for the desktop filesystems we
        // support. Canonical/inode checks in the adapter provide the stronger
        // check for paths which already exist.
        return PathBuf::from(normalized.to_string_lossy().to_lowercase());
    }
    #[cfg(not(windows))]
    normalized
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

    #[test]
    fn document_canvas_can_keep_points_without_upscaling_continuous_tone_pixels() {
        let canvas = DocumentCanvas {
            width_points: 612.0,
            height_points: 792.0,
            width_px: 2_550,
            height_px: 3_300,
        };
        let at_source_dpi = canvas.at_dpi(100.0);
        assert_eq!(at_source_dpi.width_px, 850);
        assert_eq!(at_source_dpi.height_px, 1_100);
        assert_eq!(at_source_dpi.width_points, 612.0);
        assert_eq!(at_source_dpi.height_points, 792.0);
    }

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
    fn option_validation_error_names_the_source_page() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":336,"pageMetadataPath":"page.json",
              "outputs":[],"options":{"automaticContentBoxes":{"right":{
                "xNormalized":0.72,"yNormalized":0.1,"widthNormalized":0.29,
                "heightNormalized":0.8,"rotationDegrees":0
              }}}}]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();
        let error = manifest.validate().unwrap_err().to_string();

        assert!(error.contains("Page 337"));
        assert!(error.contains("automatic right content box"));
    }

    #[test]
    fn host_memory_and_raster_window_are_bounded_additive_fields() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{}}]
        }"#;
        let absent: ManifestV3 = serde_json::from_str(json).unwrap();
        absent.validate().unwrap();
        assert_eq!(absent.host_memory_bytes, None);
        assert_eq!(absent.raster_window, 1);

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

        let windowed: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"rasterWindow\":3,\"pages\""))
                .unwrap();
        windowed.validate().unwrap();
        assert_eq!(windowed.raster_window, 3);

        let oversized: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"rasterWindow\":17,\"pages\""))
                .unwrap();
        assert!(oversized
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Raster window"));
    }

    #[test]
    fn output_destinations_are_unique_and_disjoint_from_every_input() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();

        let mut input_alias = manifest.clone();
        input_alias.pages[0].outputs[0].output_path =
            PathBuf::from("/fixtures/input/temporary/../page-1.png");
        assert!(input_alias
            .validate()
            .unwrap_err()
            .to_string()
            .contains("aliases an input"));

        let mut alpha_alias = manifest;
        alpha_alias.pages[0].outputs[0].foreground_alpha_output_path =
            Some(alpha_alias.pages[0].outputs[0].metadata_path.clone());
        assert!(alpha_alias
            .validate()
            .unwrap_err()
            .to_string()
            .contains("must be unique"));
    }

    #[test]
    fn manifest_paths_have_the_native_protocol_byte_ceiling() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].input_path = PathBuf::from("x".repeat(MAX_MANIFEST_PATH_BYTES + 1));

        let error = manifest.validate().unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("4096-byte admission ceiling"));
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
    fn manifest_validation_rejects_self_intersecting_manual_zone_polygon() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].options.manual_zones.fill = vec![crate::NormalizedZonePolygon {
            points: vec![
                crate::NormalizedZonePoint { x: 0.1, y: 0.1 },
                crate::NormalizedZonePoint { x: 0.9, y: 0.9 },
                crate::NormalizedZonePoint { x: 0.1, y: 0.9 },
                crate::NormalizedZonePoint { x: 0.9, y: 0.1 },
            ],
            rotation: crate::OrthogonalRotation::None,
        }];

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Page 1"));
    }

    #[test]
    fn matched_render_requires_a_document_canvas_at_manifest_decode() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/raster-final-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.document_canvas = None;

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("documentCanvas"));
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
            base_cleaned_raster_path: None,
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
                    "matchPageSize":false,
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
