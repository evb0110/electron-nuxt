use crate::domain::geometry::PageHalf;
use scan_primitives::Rect;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DespeckleLevel {
    Off,
    Cautious,
    #[default]
    Normal,
    Aggressive,
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
    Mixed,
    Grayscale,
    Color,
    Auto,
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
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualContentBoxes {
    pub full: Option<NormalizedRect>,
    pub left: Option<NormalizedRect>,
    pub right: Option<NormalizedRect>,
}

impl ManualContentBoxes {
    fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomaticSkewDegrees {
    pub full: Option<f64>,
    pub left: Option<f64>,
    pub right: Option<f64>,
}

impl AutomaticSkewDegrees {
    fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedSplit {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedRect {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "yNormalized")]
    pub y: f64,
    #[serde(rename = "widthNormalized")]
    pub width: f64,
    #[serde(rename = "heightNormalized")]
    pub height: f64,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedZonePoint {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "yNormalized")]
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedZonePolygon {
    pub points: Vec<NormalizedZonePoint>,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

impl NormalizedZonePolygon {
    pub fn resolve(&self, width: usize, height: usize) -> scan_primitives::Polygon {
        scan_primitives::Polygon {
            points: self
                .points
                .iter()
                .map(|point| {
                    scan_primitives::Point::new(point.x * width as f64, point.y * height as f64)
                })
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PictureZoneLayer {
    Eraser1,
    #[default]
    Painter2,
    Eraser3,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PictureZone {
    pub polygon: NormalizedZonePolygon,
    #[serde(default)]
    pub layer: PictureZoneLayer,
}

/// Manual mask overrides use ScanTailor's stable three-pass ordering:
/// ERASER1 (force binary), PAINTER2 (force picture), then ERASER3 and fill
/// zones (force binary). Array order therefore cannot change layer priority.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualZones {
    pub picture: Vec<PictureZone>,
    pub fill: Vec<NormalizedZonePolygon>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementOverrides {
    pub full: Option<PageAlignment>,
    pub left: Option<PageAlignment>,
    pub right: Option<PageAlignment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DewarpOptions {
    /// Directrix points use source-rotated page coordinates: after the page's
    /// orthogonal rotation, before region placement, deskew, dewarp, or crop.
    pub top_curve: Vec<scan_primitives::Point>,
    pub bottom_curve: Vec<scan_primitives::Point>,
    #[serde(default)]
    pub depth: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MarginsMm {
    pub left_mm: f64,
    pub top_mm: f64,
    pub right_mm: f64,
    pub bottom_mm: f64,
}

impl Default for MarginsMm {
    fn default() -> Self {
        Self {
            left_mm: 5.0,
            top_mm: 5.0,
            right_mm: 5.0,
            bottom_mm: 5.0,
        }
    }
}

impl MarginsMm {
    pub fn values(self) -> [f64; 4] {
        [self.left_mm, self.top_mm, self.right_mm, self.bottom_mm]
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentalOptions {
    pub auto_dewarp: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_dewarp_depth: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupOptions {
    pub dpi: f64,
    pub source_dpi: Option<f64>,
    pub requested_render_dpi: Option<f64>,
    /// Optional preview tile in normalized final intrinsic-output space.
    pub render_crop: Option<NormalizedRect>,
    #[serde(skip)]
    pub classify_only: Option<bool>,
    pub binarization: BinarizationMode,
    pub thickness: i8,
    pub normalize_illumination: bool,
    pub despeckle: bool,
    pub despeckle_level: DespeckleLevel,
    pub output_mode: OutputMode,
    pub ocr_mode: bool,
    pub layout: LayoutMode,
    #[serde(rename = "manualSplit")]
    pub manual_split_x: Option<NormalizedSplit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic_split: Option<NormalizedSplit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_skew_degrees: Option<f64>,
    pub manual_content_boxes: ManualContentBoxes,
    #[serde(skip_serializing_if = "AutomaticSkewDegrees::is_empty")]
    pub automatic_skew_degrees: AutomaticSkewDegrees,
    #[serde(skip_serializing_if = "ManualContentBoxes::is_empty")]
    pub automatic_content_boxes: ManualContentBoxes,
    pub manual_zones: ManualZones,
    pub crop_content: bool,
    pub match_page_size: bool,
    pub page_alignment: PageAlignment,
    pub placement_overrides: PlacementOverrides,
    #[serde(rename = "margins")]
    pub margins_mm: Option<MarginsMm>,
    #[serde(skip)]
    pub margins_pixels: Option<[f64; 4]>,
    pub dewarp: Option<DewarpOptions>,
    pub experimental: ExperimentalOptions,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
    pub excluded: bool,
    pub skip_blank_pages: bool,
    pub max_pixels: u64,
    #[serde(rename = "maxDimensionPx")]
    pub max_dimension: u32,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            dpi: 300.0,
            source_dpi: None,
            requested_render_dpi: None,
            render_crop: None,
            classify_only: None,
            binarization: BinarizationMode::Auto,
            thickness: 0,
            normalize_illumination: true,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            output_mode: OutputMode::Bw,
            ocr_mode: false,
            layout: LayoutMode::Auto,
            manual_split_x: None,
            automatic_split: None,
            manual_skew_degrees: None,
            manual_content_boxes: ManualContentBoxes::default(),
            automatic_skew_degrees: AutomaticSkewDegrees::default(),
            automatic_content_boxes: ManualContentBoxes::default(),
            manual_zones: ManualZones::default(),
            crop_content: true,
            match_page_size: true,
            page_alignment: PageAlignment::TopCenter,
            placement_overrides: PlacementOverrides::default(),
            margins_mm: Some(MarginsMm::default()),
            margins_pixels: None,
            dewarp: None,
            experimental: ExperimentalOptions::default(),
            rotation: OrthogonalRotation::None,
            excluded: false,
            skip_blank_pages: false,
            max_pixels: DEFAULT_MAX_PIXELS,
            max_dimension: DEFAULT_MAX_DIMENSION,
        }
    }
}

impl CleanupOptions {
    pub fn effective_despeckle_level(&self) -> DespeckleLevel {
        if self.despeckle {
            self.despeckle_level
        } else {
            DespeckleLevel::Off
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.dpi.is_finite() || self.dpi <= 0.0 {
            return Err("DPI must be positive and finite".into());
        }
        if self
            .source_dpi
            .is_some_and(|dpi| !dpi.is_finite() || dpi <= 0.0)
            || self
                .requested_render_dpi
                .is_some_and(|dpi| !dpi.is_finite() || dpi <= 0.0)
        {
            return Err("Source and requested render DPI must be positive and finite".into());
        }
        if !(MIN_THICKNESS..=MAX_THICKNESS).contains(&self.thickness) {
            return Err(format!(
                "Text thickness must be between {MIN_THICKNESS} and {MAX_THICKNESS}"
            ));
        }
        for (label, margins) in [
            ("millimeter", self.margins_mm.map(MarginsMm::values)),
            ("pixel", self.margins_pixels),
        ] {
            if let Some(margins) = margins {
                if !margins
                    .into_iter()
                    .all(|margin| margin.is_finite() && margin >= 0.0)
                {
                    return Err(format!(
                        "All {label} margins must be finite and nonnegative"
                    ));
                }
            }
        }
        if let Some(dewarp) = &self.dewarp {
            if !dewarp.depth.is_finite()
                || dewarp
                    .top_curve
                    .iter()
                    .chain(&dewarp.bottom_curve)
                    .any(|point| !point.x.is_finite() || !point.y.is_finite())
            {
                return Err("Dewarp curves and depth must contain only finite values".into());
            }
            crate::dewarp::DewarpModel::from_options(dewarp).map_err(|error| error.to_string())?;
        }
        if let Some(split) = self.manual_split_x {
            if !split.x.is_finite()
                || !(0.0..=1.0).contains(&split.x)
                || split.rotation != self.rotation
            {
                return Err(
                    "Manual split must be normalized and authored under the page rotation".into(),
                );
            }
        }
        if let Some(split) = self.automatic_split {
            if !split.x.is_finite()
                || !(0.0..=1.0).contains(&split.x)
                || split.rotation != self.rotation
            {
                return Err(
                    "Automatic split must be normalized and authored under the page rotation"
                        .into(),
                );
            }
        }
        if let Some(angle) = self.manual_skew_degrees {
            if !angle.is_finite() || !(-15.0..=15.0).contains(&angle) {
                return Err(
                    "Manual skew angle must be finite and between -15 and 15 degrees".into(),
                );
            }
        }
        for angle in [
            self.automatic_skew_degrees.full,
            self.automatic_skew_degrees.left,
            self.automatic_skew_degrees.right,
        ]
        .into_iter()
        .flatten()
        {
            if !angle.is_finite() || !(-15.0..=15.0).contains(&angle) {
                return Err(
                    "Automatic skew evidence must be finite and between -15 and 15 degrees".into(),
                );
            }
        }
        if let Some(depth) = self.experimental.auto_dewarp_depth {
            if !depth.is_finite() || !(0.5..=4.0).contains(&depth) {
                return Err("Automatic dewarp depth must be finite and between 0.5 and 4.0".into());
            }
        }
        for rect in [
            self.render_crop,
            self.manual_content_boxes.full,
            self.manual_content_boxes.left,
            self.manual_content_boxes.right,
            self.automatic_content_boxes.full,
            self.automatic_content_boxes.left,
            self.automatic_content_boxes.right,
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
                || rect.x + rect.width > 1.0
                || rect.y + rect.height > 1.0
                || rect.rotation != self.rotation
            {
                return Err("Normalized render/content rectangles must be positive, bounded, and authored under the page rotation".into());
            }
        }
        for polygon in self
            .manual_zones
            .picture
            .iter()
            .map(|zone| &zone.polygon)
            .chain(&self.manual_zones.fill)
        {
            if polygon.points.len() < 3
                || polygon.rotation != self.rotation
                || polygon.points.iter().any(|point| {
                    !point.x.is_finite()
                        || !point.y.is_finite()
                        || !(0.0..=1.0).contains(&point.x)
                        || !(0.0..=1.0).contains(&point.y)
                })
            {
                return Err("Manual zone polygons need at least three normalized points and must be authored under the page rotation".into());
            }
        }
        Ok(())
    }

    pub fn source_dpi(&self) -> f64 {
        self.source_dpi.unwrap_or(self.dpi)
    }

    pub fn requested_render_dpi(&self) -> f64 {
        self.requested_render_dpi.unwrap_or(self.dpi)
    }

    pub fn resolved_render_crop(&self, width: usize, height: usize) -> Option<Rect> {
        let crop = self.render_crop?;
        let left = (crop.x * width as f64).floor() as usize;
        let top = (crop.y * height as f64).floor() as usize;
        let right = ((crop.x + crop.width) * width as f64).ceil() as usize;
        let bottom = ((crop.y + crop.height) * height as f64).ceil() as usize;
        Some(Rect::new(
            left.min(width.saturating_sub(1)) as f64,
            top.min(height.saturating_sub(1)) as f64,
            right
                .clamp(left.saturating_add(1), width)
                .saturating_sub(left) as f64,
            bottom
                .clamp(top.saturating_add(1), height)
                .saturating_sub(top) as f64,
        ))
    }

    pub fn placement_for(&self, half: PageHalf) -> PageAlignment {
        let override_value = match half {
            PageHalf::Full => self.placement_overrides.full,
            PageHalf::Left => self.placement_overrides.left,
            PageHalf::Right => self.placement_overrides.right,
        };
        override_value.unwrap_or(self.page_alignment)
    }

    pub fn resolved_split_x(&self, analysis_width: usize) -> Option<f64> {
        self.manual_split_x
            .or(self.automatic_split)
            .map(|split| split.x * analysis_width as f64)
    }

    pub fn has_split_evidence(&self) -> bool {
        self.manual_split_x.is_some() || self.automatic_split.is_some()
    }

    pub fn resolved_manual_content_for(
        &self,
        half: PageHalf,
        analysis_width: usize,
        analysis_height: usize,
    ) -> Option<Rect> {
        let normalized = match half {
            PageHalf::Full => self.manual_content_boxes.full,
            PageHalf::Left => self.manual_content_boxes.left,
            PageHalf::Right => self.manual_content_boxes.right,
        }?;
        Some(Rect::new(
            normalized.x * analysis_width as f64,
            normalized.y * analysis_height as f64,
            normalized.width * analysis_width as f64,
            normalized.height * analysis_height as f64,
        ))
    }

    pub fn automatic_skew_for(&self, half: PageHalf) -> Option<f64> {
        match half {
            PageHalf::Full => self.automatic_skew_degrees.full,
            PageHalf::Left => self.automatic_skew_degrees.left,
            PageHalf::Right => self.automatic_skew_degrees.right,
        }
    }

    pub fn resolved_content_for(
        &self,
        half: PageHalf,
        analysis_width: usize,
        analysis_height: usize,
    ) -> Option<Rect> {
        self.resolved_manual_content_for(half, analysis_width, analysis_height)
            .or_else(|| {
                let normalized = match half {
                    PageHalf::Full => self.automatic_content_boxes.full,
                    PageHalf::Left => self.automatic_content_boxes.left,
                    PageHalf::Right => self.automatic_content_boxes.right,
                }?;
                Some(Rect::new(
                    normalized.x * analysis_width as f64,
                    normalized.y * analysis_height as f64,
                    normalized.width * analysis_width as f64,
                    normalized.height * analysis_height as f64,
                ))
            })
    }
}

#[cfg(test)]
#[path = "options_tests.rs"]
mod tests;
