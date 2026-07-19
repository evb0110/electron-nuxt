use crate::bw::despeckle_connected;
use scan_primitives::{
    morphology::{open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    ComponentMap, GrayImage, Rect,
};

#[derive(Clone, Copy, Debug)]
pub struct ContentResult {
    pub content: Option<Rect>,
    pub output_rect: Rect,
    pub margins: [f64; 4],
}

pub fn detect_content_and_margins(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    let scale = (150.0 / dpi.max(1.0)).min(1.0);
    let working = source.downscale_to_fit(
        (source.width() as f64 * scale).max(1.0) as usize,
        (source.height() as f64 * scale).max(1.0) as usize,
    );
    let binary = threshold_local(
        &working,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
        },
    );
    let horizontal_seed = open(&binary, 40, 2);
    let vertical_seed = open(&binary, 2, 40);
    let border_candidates = reconstruct_binary(&horizontal_seed, &binary)
        .or(&reconstruct_binary(&vertical_seed, &binary));
    let border_map = ComponentMap::from_binary(&border_candidates);
    let borders = border_map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        attached && (width * 2 >= working.width() || height * 2 >= working.height())
    });
    let cleaned = despeckle_connected(&binary.subtract(&borders), 150.0);
    let map = ComponentMap::from_binary(&cleaned);
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    for component in map.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let solid_rule =
            (width > height * 25 && height <= 3) || (height > width * 25 && width <= 3);
        let border_attached = component.left == 0
            || component.top == 0
            || component.right + 1 == working.width()
            || component.bottom + 1 == working.height();
        if solid_rule
            || (border_attached && component.area > working.width().max(working.height()) / 3)
        {
            continue;
        }
        bounds = Some(match bounds {
            None => (
                component.left,
                component.top,
                component.right,
                component.bottom,
            ),
            Some((left, top, right, bottom)) => (
                left.min(component.left),
                top.min(component.top),
                right.max(component.right),
                bottom.max(component.bottom),
            ),
        });
    }
    let content = bounds.map(|(left, top, right, bottom)| {
        Rect::new(
            left as f64 / scale,
            top as f64 / scale,
            (right - left + 1) as f64 / scale,
            (bottom - top + 1) as f64 / scale,
        )
    });
    let margins = margins_pixels.unwrap_or_else(|| {
        margins_mm
            .unwrap_or([0.0; 4])
            .map(|millimeters| millimeters * dpi / 25.4)
    });
    let base = content.unwrap_or(Rect::new(
        0.0,
        0.0,
        source.width() as f64,
        source.height() as f64,
    ));
    let output_rect = base.expand(margins[0], margins[1], margins[2], margins[3]);
    ContentResult {
        content,
        output_rect,
        margins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }
    #[test]
    fn recovers_synthetic_content_box_and_ignores_border_shadow() {
        let mut image = GrayImage::new(240, 180, 238);
        for x in 0..240 {
            image.set(x, 3, 30);
            image.set(x, 4, 30);
        }
        for y in (40..140).step_by(14) {
            for word in 0..7 {
                let left = 42 + word * 23;
                for x in left..(left + 18).min(198) {
                    image.set(x, y, 20);
                    image.set(x, y + 1, 20);
                    image.set(x, y + 2, 20);
                }
            }
        }
        image.set(48, 33, 10);
        image.set(49, 33, 10);
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let expected = Rect::new(42.0, 33.0, 156.0, 96.0);
        assert!(
            iou(result.content.unwrap(), expected) > 0.82,
            "actual={:?}",
            result.content
        );
    }
}
