//! Shared analysis/render planning. Both paths consume these exact region and
//! margin decisions so classification and cleanup cannot drift.

use crate::{
    content::ContentResult,
    engine::render::PageHalf,
    split::{LayoutClassification, SplitResult},
    LayoutMode,
};
use scan_primitives::Rect;

pub(crate) fn content_result_for_dimensions(
    width: usize,
    height: usize,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    let margins = margins_pixels.unwrap_or_else(|| {
        margins_mm
            .unwrap_or([0.0; 4])
            .map(|millimeters| millimeters * dpi / 25.4)
    });
    let base = content.unwrap_or(Rect::new(0.0, 0.0, width as f64, height as f64));
    ContentResult {
        content,
        output_rect: base.expand(margins[0], margins[1], margins[2], margins[3]),
        margins,
        diagnostics: None,
    }
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
    let cutter = cutter.round().clamp(1.0, width.saturating_sub(1) as f64);
    let left = Rect::new(0.0, 0.0, cutter, height as f64);
    let right = Rect::new(cutter, 0.0, width as f64 - cutter, height as f64);
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
