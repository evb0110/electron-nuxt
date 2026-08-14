//! Shared analysis/render planning. Both paths consume these exact region and
//! margin decisions so classification and cleanup cannot drift.

use crate::{
    content::{checked_content_with_margins_for_dimensions, ContentResult},
    dewarp::DewarpModel,
    engine::render::PageHalf,
    split::{LayoutClassification, SplitResult},
    LayoutMode,
};
use scan_primitives::{Affine, Point, Rect};

/// The final cleanup mapping in rotated-source coordinates.
///
/// `DewarpOptions` points are serialized in source-rotated page coordinates.
/// The renderer first moves those points into the page region and applies the
/// deskew affine. The resulting cylindrical model therefore lives in deskewed
/// region coordinates. Mapping an output point back to the source reverses the
/// crop placement, cylindrical dewarp, deskew, and region placement in that
/// order, without an intermediate full-resolution raster.
#[derive(Clone, Debug)]
pub(crate) struct ComposedRenderPlan {
    region: Rect,
    deskew_forward: Affine,
    deskew_inverse: Affine,
    dewarp: Option<DewarpModel>,
    canvas_width: usize,
    canvas_height: usize,
    output_rect: Rect,
}

impl ComposedRenderPlan {
    pub(crate) fn new(
        region: Rect,
        deskew_forward: Affine,
        deskew_inverse: Affine,
        dewarp: Option<DewarpModel>,
        canvas_width: usize,
        canvas_height: usize,
        output_rect: Rect,
    ) -> Self {
        Self {
            region,
            deskew_forward,
            deskew_inverse,
            dewarp,
            canvas_width,
            canvas_height,
            output_rect,
        }
    }

    pub(crate) fn has_dewarp(&self) -> bool {
        self.dewarp.is_some()
    }

    pub(crate) fn output_rect(&self) -> Rect {
        self.output_rect
    }

    pub(crate) fn output_width(&self) -> usize {
        self.output_rect.width.ceil().max(1.0) as usize
    }

    pub(crate) fn output_height(&self) -> usize {
        self.output_rect.height.ceil().max(1.0) as usize
    }

    /// Exact affine form of the composed inverse mapping when no cylindrical
    /// stage is present. This preserves the optimized affine rasterizer while
    /// keeping the mapping definition in one plan.
    pub(crate) fn affine_inverse(&self) -> Option<Affine> {
        self.dewarp.is_none().then(|| {
            Affine::translation(self.output_rect.x, self.output_rect.y)
                .then(self.deskew_inverse)
                .then(Affine::translation(self.region.x, self.region.y))
        })
    }

    pub(crate) fn output_to_source(&self, output: Point) -> Option<Point> {
        let canvas = Point::new(output.x + self.output_rect.x, output.y + self.output_rect.y);
        let deskewed = if let Some(model) = &self.dewarp {
            if canvas.x < 0.0
                || canvas.y < 0.0
                || canvas.x > self.canvas_width as f64
                || canvas.y > self.canvas_height as f64
            {
                return None;
            }
            model.map_unit_to_source(
                canvas.x / self.canvas_width.max(1) as f64,
                canvas.y / self.canvas_height.max(1) as f64,
            )?
        } else {
            canvas
        };
        let local = self.deskew_inverse.apply(deskewed);
        Some(Point::new(local.x + self.region.x, local.y + self.region.y))
    }

    pub(crate) fn source_to_output(&self, source: Point) -> Option<Point> {
        let local = Point::new(source.x - self.region.x, source.y - self.region.y);
        let deskewed = self.deskew_forward.apply(local);
        let canvas = if let Some(model) = &self.dewarp {
            let unit = model.map_source_to_unit_approx(deskewed)?;
            Point::new(
                unit.x * self.canvas_width as f64,
                unit.y * self.canvas_height as f64,
            )
        } else {
            deskewed
        };
        Some(Point::new(
            canvas.x - self.output_rect.x,
            canvas.y - self.output_rect.y,
        ))
    }
}

pub(crate) fn content_result_for_dimensions(
    width: usize,
    height: usize,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> Result<ContentResult, String> {
    checked_content_with_margins_for_dimensions(
        width,
        height,
        dpi,
        content,
        margins_mm,
        margins_pixels,
    )
}

pub(crate) fn output_regions(
    width: usize,
    height: usize,
    split: &SplitResult,
    layout: LayoutMode,
) -> Vec<(Rect, PageHalf)> {
    let full = Rect::new(0.0, 0.0, width as f64, height as f64);
    let Some(cutter) = split.cutter_x else {
        return vec![(full, PageHalf::Full)];
    };
    // A cutter needs a pixel on each side; below two columns the clamp bounds
    // invert and there is nothing to split.
    if width < 2 {
        return vec![(full, PageHalf::Full)];
    }
    let cutter = cutter.round().clamp(1.0, width.saturating_sub(1) as f64);
    // The fold the cutter runs through is not page, so both leaves stop at
    // their near edge. The cutter stays put: moving it would hand one leaf
    // material the other leaf had already been assigned.
    let (fold_left, fold_right) = split.diagnostics.fold_band.edges(cutter, width);
    let left_edge = fold_left.round().clamp(1.0, cutter);
    let right_edge = fold_right
        .round()
        .clamp(cutter, width.saturating_sub(1) as f64);
    let left = Rect::new(0.0, 0.0, left_edge, height as f64);
    let right = Rect::new(right_edge, 0.0, width as f64 - right_edge, height as f64);
    match split.classification {
        LayoutClassification::TwoPageSpread => {
            vec![(left, PageHalf::Left), (right, PageHalf::Right)]
        }
        LayoutClassification::PageWithOffcut => {
            if matches!(layout, LayoutMode::KeepLeft)
                || !matches!(layout, LayoutMode::KeepRight) && left.width >= right.width
            {
                vec![(left, PageHalf::Left)]
            } else {
                vec![(right, PageHalf::Right)]
            }
        }
        LayoutClassification::SingleUncutPage => vec![(full, PageHalf::Full)],
    }
}
