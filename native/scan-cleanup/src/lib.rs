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
// supports content scoring and thick scan-bed artifact rejection.

use scan_primitives::Rect;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

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
    KeepLeft,
    KeepRight,
    #[serde(rename = "force-two-page", alias = "two-page")]
    TwoPage,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum OrthogonalRotation {
    #[default]
    None,
    Clockwise90,
    Clockwise180,
    Clockwise270,
}

impl OrthogonalRotation {
    fn from_degrees(degrees: u16) -> Option<Self> {
        match degrees {
            0 => Some(Self::None),
            90 => Some(Self::Clockwise90),
            180 => Some(Self::Clockwise180),
            270 => Some(Self::Clockwise270),
            _ => None,
        }
    }

    pub fn degrees(self) -> u16 {
        match self {
            Self::None => 0,
            Self::Clockwise90 => 90,
            Self::Clockwise180 => 180,
            Self::Clockwise270 => 270,
        }
    }
}

impl Serialize for OrthogonalRotation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u16(self.degrees())
    }
}

impl<'de> Deserialize<'de> for OrthogonalRotation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum RotationValue {
            Number(u16),
            LegacyString(String),
        }

        let value = RotationValue::deserialize(deserializer)?;
        let degrees = match value {
            RotationValue::Number(degrees) => degrees,
            RotationValue::LegacyString(degrees) => degrees
                .parse()
                .map_err(|_| serde::de::Error::custom("rotation must be 0, 90, 180, or 270"))?,
        };
        Self::from_degrees(degrees)
            .ok_or_else(|| serde::de::Error::custom("rotation must be 0, 90, 180, or 270"))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OutputMode {
    #[default]
    Bw,
    Grayscale,
    Color,
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManualContentBoxes {
    pub full: Option<Rect>,
    pub left: Option<Rect>,
    pub right: Option<Rect>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlacementOverrides {
    pub full: Option<PageAlignment>,
    pub left: Option<PageAlignment>,
    pub right: Option<PageAlignment>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classify_only: Option<bool>,
    pub binarization: BinarizationMode,
    pub thickness: i8,
    pub normalize_illumination: bool,
    pub despeckle: bool,
    pub output_mode: OutputMode,
    pub ocr_mode: bool,
    pub layout: LayoutMode,
    pub manual_split_x: Option<f64>,
    pub manual_content_boxes: ManualContentBoxes,
    pub crop_content: bool,
    pub match_page_size: bool,
    pub page_alignment: PageAlignment,
    pub placement_overrides: PlacementOverrides,
    pub margins_mm: Option<[f64; 4]>,
    pub margins_pixels: Option<[f64; 4]>,
    pub dewarp: Option<DewarpOptions>,
    pub experimental_auto_dewarp: bool,
    pub rotation: OrthogonalRotation,
    pub excluded: bool,
    pub skip_blank_pages: bool,
    pub max_pixels: u64,
    pub max_dimension: u32,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            dpi: 300.0,
            classify_only: None,
            binarization: BinarizationMode::Auto,
            thickness: 0,
            normalize_illumination: true,
            despeckle: true,
            output_mode: OutputMode::Bw,
            ocr_mode: false,
            layout: LayoutMode::Auto,
            manual_split_x: None,
            manual_content_boxes: ManualContentBoxes::default(),
            crop_content: true,
            match_page_size: true,
            page_alignment: PageAlignment::TopCenter,
            placement_overrides: PlacementOverrides::default(),
            margins_mm: Some([5.0; 4]),
            margins_pixels: None,
            dewarp: None,
            experimental_auto_dewarp: false,
            rotation: OrthogonalRotation::None,
            excluded: false,
            skip_blank_pages: false,
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
        for rect in [
            self.manual_content_boxes.full,
            self.manual_content_boxes.left,
            self.manual_content_boxes.right,
        ]
        .into_iter()
        .flatten()
        {
            if ![rect.x, rect.y, rect.width, rect.height]
                .into_iter()
                .all(f64::is_finite)
                || rect.x < 0.0
                || rect.y < 0.0
                || rect.width <= 0.0
                || rect.height <= 0.0
            {
                return Err("Manual content rectangles must be finite and positive".into());
            }
        }
        Ok(())
    }

    pub fn placement_for(&self, half: pipeline::PageHalf) -> PageAlignment {
        let override_value = match half {
            pipeline::PageHalf::Full => self.placement_overrides.full,
            pipeline::PageHalf::Left => self.placement_overrides.left,
            pipeline::PageHalf::Right => self.placement_overrides.right,
        };
        override_value.unwrap_or(self.page_alignment)
    }

    pub fn manual_content_for(&self, half: pipeline::PageHalf) -> Option<Rect> {
        match half {
            pipeline::PageHalf::Full => self.manual_content_boxes.full,
            pipeline::PageHalf::Left => self.manual_content_boxes.left,
            pipeline::PageHalf::Right => self.manual_content_boxes.right,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CleanupOptions, OrthogonalRotation, PageAlignment, PlacementOverrides, Rect};
    use crate::pipeline::PageHalf;

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

    #[test]
    fn per_output_placement_overrides_the_document_default() {
        let options = CleanupOptions {
            page_alignment: PageAlignment::TopLeft,
            placement_overrides: PlacementOverrides {
                right: Some(PageAlignment::BottomRight),
                ..PlacementOverrides::default()
            },
            ..CleanupOptions::default()
        };
        assert_eq!(
            options.placement_for(PageHalf::Left),
            PageAlignment::TopLeft
        );
        assert_eq!(
            options.placement_for(PageHalf::Right),
            PageAlignment::BottomRight
        );
        assert_eq!(
            options.placement_for(PageHalf::Right).offset(20, 30),
            (20, 30)
        );
    }

    #[test]
    fn manual_content_rect_round_trips_through_manifest_options() {
        let json = r#"{
            "manualContentBoxes": {
                "left": {"x": 12.5, "y": 18.0, "width": 220.0, "height": 330.0}
            }
        }"#;
        let options: CleanupOptions = serde_json::from_str(json).unwrap();
        let encoded = serde_json::to_value(&options).unwrap();
        assert_eq!(encoded["manualContentBoxes"]["left"]["x"], 12.5);
        assert_eq!(
            options.manual_content_for(PageHalf::Left),
            Some(Rect::new(12.5, 18.0, 220.0, 330.0))
        );
    }

    #[test]
    fn rotation_uses_the_numeric_contract_and_accepts_legacy_strings() {
        assert_eq!(
            serde_json::from_str::<OrthogonalRotation>("90").unwrap(),
            OrthogonalRotation::Clockwise90,
        );
        assert_eq!(
            serde_json::from_str::<OrthogonalRotation>(r#""270""#).unwrap(),
            OrthogonalRotation::Clockwise270,
        );
        assert_eq!(
            serde_json::to_string(&OrthogonalRotation::Clockwise180).unwrap(),
            "180",
        );
        assert!(serde_json::from_str::<OrthogonalRotation>("45").is_err());
    }
}
