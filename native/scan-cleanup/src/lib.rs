pub mod auto_dewarp;
pub mod background;
pub mod bw;
pub mod cli;
pub mod content;
pub mod deskew;
pub mod dewarp;
pub mod pipeline;
pub mod png;
pub mod split;

// The exact squared Euclidean distance transform in `scan-primitives::distance`
// is intentionally shipped as shared groundwork for future rule/text separation.
// The current cleanup stages use connected-component geometry instead.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_MAX_PIXELS: u64 = 160_000_000;
pub const DEFAULT_MAX_DIMENSION: u32 = 40_000;
pub const MIN_THICKNESS: i8 = -5;
pub const MAX_THICKNESS: i8 = 5;
pub const THICKNESS_GRAY_STEP: i16 = 4;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum BinarizationMode {
    Otsu,
    Sauvola,
    Wolf,
    #[default]
    Auto,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutMode {
    #[default]
    Auto,
    #[serde(rename = "force-single", alias = "single")]
    Single,
    PageWithOffcut,
    #[serde(rename = "force-two-page", alias = "two-page")]
    TwoPage,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OutputMode {
    #[default]
    Bw,
    Grayscale,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PageAlignment {
    TopLeft,
    #[default]
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl PageAlignment {
    pub fn offset(self, available_width: usize, available_height: usize) -> (usize, usize) {
        let x = match self {
            Self::TopLeft | Self::CenterLeft | Self::BottomLeft => 0,
            Self::TopCenter | Self::Center | Self::BottomCenter => available_width / 2,
            Self::TopRight | Self::CenterRight | Self::BottomRight => available_width,
        };
        let y = match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight => 0,
            Self::CenterLeft | Self::Center | Self::CenterRight => available_height / 2,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => available_height,
        };
        (x, y)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpOptions {
    pub top_curve: Vec<scan_primitives::Point>,
    pub bottom_curve: Vec<scan_primitives::Point>,
    #[serde(default)]
    pub depth: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CleanupOptions {
    pub dpi: f64,
    pub binarization: BinarizationMode,
    pub thickness: i8,
    pub normalize_illumination: bool,
    pub despeckle: bool,
    pub output_mode: OutputMode,
    pub ocr_mode: bool,
    pub layout: LayoutMode,
    pub manual_split_x: Option<f64>,
    pub crop_content: bool,
    pub match_page_size: bool,
    pub page_alignment: PageAlignment,
    pub margins_mm: Option<[f64; 4]>,
    pub margins_pixels: Option<[f64; 4]>,
    pub dewarp: Option<DewarpOptions>,
    pub experimental_auto_dewarp: bool,
    pub max_pixels: u64,
    pub max_dimension: u32,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            thickness: 0,
            normalize_illumination: true,
            despeckle: true,
            output_mode: OutputMode::Bw,
            ocr_mode: false,
            layout: LayoutMode::Auto,
            manual_split_x: None,
            crop_content: true,
            match_page_size: true,
            page_alignment: PageAlignment::TopCenter,
            margins_mm: Some([5.0; 4]),
            margins_pixels: None,
            dewarp: None,
            experimental_auto_dewarp: false,
            max_pixels: DEFAULT_MAX_PIXELS,
            max_dimension: DEFAULT_MAX_DIMENSION,
        }
    }
}

impl CleanupOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_THICKNESS..=MAX_THICKNESS).contains(&self.thickness) {
            return Err(format!(
                "Text thickness must be between {MIN_THICKNESS} and {MAX_THICKNESS}"
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PageAlignment;

    #[test]
    fn page_alignment_covers_all_nine_anchor_positions() {
        let width = 20;
        let height = 30;
        assert_eq!(PageAlignment::TopLeft.offset(width, height), (0, 0));
        assert_eq!(PageAlignment::TopCenter.offset(width, height), (10, 0));
        assert_eq!(PageAlignment::TopRight.offset(width, height), (20, 0));
        assert_eq!(PageAlignment::CenterLeft.offset(width, height), (0, 15));
        assert_eq!(PageAlignment::Center.offset(width, height), (10, 15));
        assert_eq!(PageAlignment::CenterRight.offset(width, height), (20, 15));
        assert_eq!(PageAlignment::BottomLeft.offset(width, height), (0, 30));
        assert_eq!(PageAlignment::BottomCenter.offset(width, height), (10, 30));
        assert_eq!(PageAlignment::BottomRight.offset(width, height), (20, 30));
    }
}
