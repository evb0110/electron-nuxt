use crate::LayoutMode;
use scan_primitives::{
    morphology::{open, reconstruct_binary},
    BinaryImage, ComponentMap, GrayImage, Point, Polygon,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutClassification {
    SingleUncutPage,
    PageWithOffcut,
    TwoPageSpread,
}

#[derive(Clone, Debug)]
pub struct SplitResult {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub pages: Vec<Polygon>,
}

pub fn detect_split(
    gray: &GrayImage,
    binary: &BinaryImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
) -> SplitResult {
    if let Some(cutter) = manual_split_x {
        return split_at(
            gray.width(),
            gray.height(),
            cutter.clamp(1.0, gray.width().saturating_sub(1) as f64),
            mode_classification(mode),
            1.0,
        );
    }
    if !matches!(mode, LayoutMode::Auto) {
        return if matches!(mode, LayoutMode::Single) {
            single(gray.width(), gray.height(), 1.0)
        } else {
            split_at(
                gray.width(),
                gray.height(),
                gray.width() as f64 * 0.5,
                mode_classification(mode),
                0.5,
            )
        };
    }
    let whitespace = whitespace_candidate(binary, dpi);
    let line = fold_line_candidate(gray, dpi);
    let candidate = match (whitespace, line) {
        (Some(left), Some(right)) if (left.0 - right.0).abs() <= gray.width() as f64 * 0.04 => {
            Some(((left.0 + right.0) * 0.5, (left.1 + right.1).min(1.0)))
        }
        (Some(value), _) => Some(value),
        (_, Some(value)) => Some(value),
        _ => None,
    };
    let Some((x, confidence)) = candidate else {
        return single(gray.width(), gray.height(), 0.7);
    };
    let position = x / gray.width() as f64;
    if (0.30..=0.70).contains(&position) {
        split_at(
            gray.width(),
            gray.height(),
            x,
            LayoutClassification::TwoPageSpread,
            confidence,
        )
    } else if (0.08..=0.92).contains(&position) {
        split_at(
            gray.width(),
            gray.height(),
            x,
            LayoutClassification::PageWithOffcut,
            confidence * 0.85,
        )
    } else {
        single(gray.width(), gray.height(), 0.65)
    }
}

fn whitespace_candidate(binary: &BinaryImage, dpi: f64) -> Option<(f64, f64)> {
    let shadow_radius = ((dpi / 300.0) * 60.0).round().max(12.0) as usize;
    let seed = open(
        binary,
        shadow_radius,
        ((dpi / 300.0) * 4.0).round().max(1.0) as usize,
    );
    let cleaned = binary.subtract(&reconstruct_binary(&seed, binary));
    let map = ComponentMap::from_binary(&cleaned);
    let min_area = ((dpi / 300.0).powi(2) * 3.0).round().max(2.0) as usize;
    let cleaned = map.retain(|component| component.area >= min_area);
    let mut columns = vec![0usize; cleaned.width()];
    for y in 0..cleaned.height() {
        for (x, count) in columns.iter_mut().enumerate() {
            if cleaned.get(x, y) {
                *count += 1;
            }
        }
    }
    let center = cleaned.width() as f64 * 0.5;
    let search_left = cleaned.width() / 12;
    let search_right = cleaned.width() - search_left;
    let quiet_limit = (cleaned.height() as f64 * 0.012).ceil() as usize;
    let mut best = None;
    let mut start = None;
    for (x, &column) in columns
        .iter()
        .enumerate()
        .take(search_right + 1)
        .skip(search_left)
    {
        let quiet = x < search_right && column <= quiet_limit;
        if quiet && start.is_none() {
            start = Some(x);
        }
        if !quiet {
            if let Some(run_start) = start.take() {
                let width = x - run_start;
                let midpoint = (run_start + x) as f64 * 0.5;
                let balance = 1.0 - ((midpoint - center).abs() / center).min(1.0);
                let score = width as f64 * (0.35 + 0.65 * balance);
                if best.map(|(_, value)| score > value).unwrap_or(true) {
                    best = Some((midpoint, score));
                }
            }
        }
    }
    let (x, score) = best?;
    let confidence = (score / (cleaned.width() as f64 * 0.025)).clamp(0.0, 1.0);
    (confidence >= 0.35).then_some((x, confidence))
}

fn fold_line_candidate(gray: &GrayImage, dpi: f64) -> Option<(f64, f64)> {
    let scale = (100.0 / dpi.max(1.0)).min(1.0);
    let working = gray.downscale_to_fit(
        (gray.width() as f64 * scale).max(1.0) as usize,
        (gray.height() as f64 * scale).max(1.0) as usize,
    );
    if working.width() < 8 || working.height() < 8 {
        return None;
    }
    const ANGLE_STEPS: usize = 29;
    let mut accumulator = vec![0u64; ANGLE_STEPS * working.width()];
    let center_y = working.height() as f64 * 0.5;
    for y in 1..working.height() - 1 {
        for x in 2..working.width() - 2 {
            let horizontal = i16::from(working.get(x + 2, y)) - i16::from(working.get(x - 2, y));
            let vertical = i16::from(working.get(x, y + 1)) - i16::from(working.get(x, y - 1));
            let weight = horizontal.abs().saturating_sub(vertical.abs());
            if weight < 5 {
                continue;
            }
            for angle_index in 0..ANGLE_STEPS {
                let degrees = -7.0 + angle_index as f64 * 0.5;
                let slope = degrees.to_radians().tan();
                let center_x = x as f64 - slope * (y as f64 - center_y);
                let bin = center_x.round() as isize;
                if bin >= 0 && bin < working.width() as isize {
                    accumulator[angle_index * working.width() + bin as usize] += weight as u64;
                }
            }
        }
    }
    let search_left = working.width() / 12;
    let search_right = working.width() * 11 / 12;
    let mut best = (0usize, 0u64);
    let mut total = 0u64;
    let mut candidates = 0usize;
    for angle_index in 0..ANGLE_STEPS {
        for x in search_left..search_right {
            let score = accumulator[angle_index * working.width() + x];
            total += score;
            candidates += 1;
            if score > best.1 {
                best = (x, score);
            }
        }
    }
    let average = total as f64 / candidates.max(1) as f64;
    let coherence = if average > 0.0 {
        best.1 as f64 / average
    } else {
        0.0
    };
    let line_strength = best.1 as f64 / (working.height() as f64 * 48.0);
    let confidence = ((coherence - 2.0) / 8.0)
        .clamp(0.0, 1.0)
        .min(line_strength.clamp(0.0, 1.0));
    (confidence >= 0.35).then_some((
        best.0 as f64 / working.width() as f64 * gray.width() as f64,
        confidence,
    ))
}

fn single(width: usize, height: usize, confidence: f64) -> SplitResult {
    SplitResult {
        classification: LayoutClassification::SingleUncutPage,
        confidence,
        cutter_x: None,
        pages: vec![page_polygon(0.0, width as f64, height)],
    }
}
fn split_at(
    width: usize,
    height: usize,
    x: f64,
    classification: LayoutClassification,
    confidence: f64,
) -> SplitResult {
    SplitResult {
        classification,
        confidence,
        cutter_x: Some(x),
        pages: vec![
            page_polygon(0.0, x, height),
            page_polygon(x, width as f64, height),
        ],
    }
}
fn page_polygon(left: f64, right: f64, height: usize) -> Polygon {
    Polygon {
        points: vec![
            Point::new(left, 0.0),
            Point::new(right, 0.0),
            Point::new(right, height as f64),
            Point::new(left, height as f64),
        ],
    }
}
fn mode_classification(mode: LayoutMode) -> LayoutClassification {
    match mode {
        LayoutMode::PageWithOffcut | LayoutMode::KeepLeft | LayoutMode::KeepRight => {
            LayoutClassification::PageWithOffcut
        }
        LayoutMode::TwoPage => LayoutClassification::TwoPageSpread,
        LayoutMode::Auto | LayoutMode::Single => LayoutClassification::SingleUncutPage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locates_known_two_page_gutter() {
        let mut gray = GrayImage::new(300, 180, 245);
        let mut binary = BinaryImage::new(300, 180);
        for y in (20..160).step_by(14) {
            for x in 20..135 {
                binary.set(x, y, true);
                gray.set(x, y, 20);
            }
            for x in 168..280 {
                binary.set(x, y, true);
                gray.set(x, y, 20);
            }
        }
        let result = detect_split(&gray, &binary, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!(
            (result.cutter_x.unwrap() - 151.5).abs() <= 3.0,
            "x={:?}",
            result.cutter_x
        );
    }
    #[test]
    fn manual_override_is_authoritative() {
        let gray = GrayImage::new(200, 100, 255);
        let binary = BinaryImage::new(200, 100);
        let result = detect_split(&gray, &binary, 300.0, LayoutMode::TwoPage, Some(84.0));
        assert_eq!(result.cutter_x, Some(84.0));
        assert_eq!(result.confidence, 1.0);
    }

    #[test]
    fn weighted_hough_finds_a_faint_three_degree_fold() {
        let mut gray = GrayImage::new(360, 240, 235);
        let binary = BinaryImage::new(360, 240);
        let slope = 3.0_f64.to_radians().tan();
        for y in 0..240 {
            let x = (180.0 + slope * (y as f64 - 120.0)).round() as usize;
            gray.set(x.saturating_sub(1), y, 190);
            gray.set(x, y, 190);
        }
        let result = detect_split(&gray, &binary, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!(
            (result.cutter_x.unwrap() - 180.0).abs() <= 5.0,
            "{result:?}"
        );
    }
}
