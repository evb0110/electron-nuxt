use crate::DewarpOptions;
use scan_primitives::{
    threshold::{otsu_threshold, threshold_global},
    GrayImage, Point,
};

#[derive(Clone, Debug)]
pub struct AutoDewarpResult {
    pub model: Option<DewarpOptions>,
    pub confidence: f64,
}

pub fn detect_curves(source: &GrayImage) -> AutoDewarpResult {
    if source.width() < 80 || source.height() < 80 {
        return AutoDewarpResult {
            model: None,
            confidence: 0.0,
        };
    }
    let binary = threshold_global(source, otsu_threshold(source));
    let samples = 17usize;
    let bin_width = source.width() as f64 / samples as f64;
    let mut top = Vec::new();
    let mut bottom = Vec::new();
    let mut valid = 0usize;
    for bin in 0..samples {
        let x0 = (bin as f64 * bin_width).floor() as usize;
        let x1 = (((bin + 1) as f64 * bin_width).ceil() as usize).min(source.width());
        let required = ((x1 - x0) as f64 * 0.04).ceil() as usize;
        let mut first = None;
        let mut last = None;
        for y in 0..source.height() {
            let ink = (x0..x1).filter(|&x| binary.get(x, y)).count();
            if ink >= required.max(1) {
                first.get_or_insert(y);
                last = Some(y);
            }
        }
        let center_x = (x0 + x1) as f64 * 0.5;
        if let (Some(first), Some(last)) = (first, last) {
            let margin = ((last - first) as f64 * 0.08).max(4.0);
            top.push(Point::new(center_x, first as f64 - margin));
            bottom.push(Point::new(center_x, last as f64 + margin));
            valid += 1;
        }
    }
    if valid < samples * 3 / 4 {
        return AutoDewarpResult {
            model: None,
            confidence: valid as f64 / samples as f64,
        };
    }
    smooth_curve(&mut top);
    smooth_curve(&mut bottom);
    top.insert(0, Point::new(0.0, top[0].y));
    top.push(Point::new(source.width() as f64, top.last().unwrap().y));
    bottom.insert(0, Point::new(0.0, bottom[0].y));
    bottom.push(Point::new(source.width() as f64, bottom.last().unwrap().y));
    let separation_ok = top
        .iter()
        .zip(&bottom)
        .all(|(upper, lower)| lower.y - upper.y >= source.height() as f64 * 0.25);
    let confidence = (valid as f64 / samples as f64) * if separation_ok { 0.72 } else { 0.25 };
    AutoDewarpResult {
        model: (confidence >= 0.6).then_some(DewarpOptions {
            top_curve: top,
            bottom_curve: bottom,
            depth: 0.0,
        }),
        confidence,
    }
}

fn smooth_curve(points: &mut [Point]) {
    if points.len() < 5 {
        return;
    }
    let original = points.to_vec();
    for index in 2..points.len() - 2 {
        points[index].y = (original[index - 2].y
            + 2.0 * original[index - 1].y
            + 3.0 * original[index].y
            + 2.0 * original[index + 1].y
            + original[index + 2].y)
            / 9.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_deterministic_model_for_curved_text_envelope() {
        let mut image = GrayImage::new(220, 160, 245);
        for x in 10..210 {
            let curve =
                (8.0 * ((x as f64 / 220.0 - 0.5) * std::f64::consts::PI).cos()).round() as isize;
            for line in 0..6 {
                let y = (35 + line * 16) as isize + curve;
                for dy in 0..3 {
                    image.set(x, (y + dy) as usize, 20);
                }
            }
        }
        let first = detect_curves(&image);
        let second = detect_curves(&image);
        assert!(first.model.is_some(), "confidence={}", first.confidence);
        assert_eq!(first.confidence, second.confidence);
        assert_eq!(
            first.model.unwrap().top_curve,
            second.model.unwrap().top_curve
        );
    }
}
