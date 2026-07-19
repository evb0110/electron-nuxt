use crate::{BinaryImage, GrayImage};

/// Otsu threshold using dark `< threshold`; tied best-score plateaus use their midpoint.
pub fn otsu_threshold(image: &GrayImage) -> u8 {
    let mut histogram = [0u64; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let total: u64 = histogram.iter().sum();
    if total == 0 {
        return 0;
    }
    let weighted_total: u64 = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| value as u64 * count)
        .sum();
    let mut background_count = 0u64;
    let mut background_sum = 0u64;
    let mut best_score = -1.0f64;
    let mut first_best = 0u8;
    let mut last_best = 0u8;
    for threshold in 1..=255u16 {
        let value = threshold as usize - 1;
        background_count += histogram[value];
        background_sum += value as u64 * histogram[value];
        let foreground_count = total - background_count;
        if background_count == 0 || foreground_count == 0 {
            continue;
        }
        let mean_difference = background_sum as f64 / background_count as f64
            - (weighted_total - background_sum) as f64 / foreground_count as f64;
        let score =
            background_count as f64 * foreground_count as f64 * mean_difference * mean_difference;
        let tolerance = best_score.abs().max(1.0) * 1e-12;
        if score > best_score + tolerance {
            best_score = score;
            first_best = threshold as u8;
            last_best = threshold as u8;
        } else if (score - best_score).abs() <= tolerance {
            last_best = threshold as u8;
        }
    }
    ((u16::from(first_best) + u16::from(last_best)) / 2) as u8
}

pub fn threshold_global(image: &GrayImage, threshold: u8) -> BinaryImage {
    threshold_global_biased(image, threshold, 0)
}

pub fn threshold_global_biased(image: &GrayImage, threshold: u8, bias: i16) -> BinaryImage {
    let threshold = (i16::from(threshold) + bias).clamp(0, 255) as u8;
    let mut output = BinaryImage::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            output.set(x, y, image.get(x, y) < threshold);
        }
    }
    output
}

#[derive(Clone, Copy, Debug)]
pub enum LocalThreshold {
    Sauvola { k: f64 },
    Wolf { k: f64, deviation_floor: f64 },
}

pub fn threshold_local(image: &GrayImage, radius: usize, method: LocalThreshold) -> BinaryImage {
    threshold_local_biased(image, radius, method, 0)
}

pub fn threshold_local_biased(
    image: &GrayImage,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    let pitch = width + 1;
    let mut sum = vec![0u64; (width + 1) * (height + 1)];
    let mut square = vec![0u64; sum.len()];
    let mut global_min = u8::MAX;
    for y in 0..height {
        for x in 0..width {
            let value = u64::from(image.get(x, y));
            global_min = global_min.min(value as u8);
            let index = (y + 1) * pitch + x + 1;
            sum[index] = value + sum[index - 1] + sum[index - pitch] - sum[index - pitch - 1];
            square[index] = value * value + square[index - 1] + square[index - pitch]
                - square[index - pitch - 1];
        }
    }
    let mut max_deviation = 1.0f64;
    for y in 0..height {
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let y0 = y.saturating_sub(radius);
            let x1 = (x + radius + 1).min(width);
            let y1 = (y + radius + 1).min(height);
            let count = ((x1 - x0) * (y1 - y0)) as f64;
            let area_sum = rectangle_sum(&sum, pitch, x0, y0, x1, y1) as f64;
            let area_square = rectangle_sum(&square, pitch, x0, y0, x1, y1) as f64;
            let mean = area_sum / count;
            let deviation = (area_square / count - mean * mean).max(0.0).sqrt();
            max_deviation = max_deviation.max(deviation);
        }
    }
    let mut output = BinaryImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let y0 = y.saturating_sub(radius);
            let x1 = (x + radius + 1).min(width);
            let y1 = (y + radius + 1).min(height);
            let count = ((x1 - x0) * (y1 - y0)) as f64;
            let area_sum = rectangle_sum(&sum, pitch, x0, y0, x1, y1) as f64;
            let area_square = rectangle_sum(&square, pitch, x0, y0, x1, y1) as f64;
            let mean = area_sum / count;
            let deviation = (area_square / count - mean * mean).max(0.0).sqrt();
            let threshold = match method {
                LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                LocalThreshold::Wolf { k, deviation_floor } => {
                    let normalized =
                        deviation.max(deviation_floor) / max_deviation.max(deviation_floor);
                    mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                }
            };
            output.set(
                x,
                y,
                f64::from(image.get(x, y)) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
            );
        }
    }
    output
}

fn rectangle_sum(
    integral: &[u64],
    pitch: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
) -> u64 {
    integral[y1 * pitch + x1] + integral[y0 * pitch + x0]
        - integral[y0 * pitch + x1]
        - integral[y1 * pitch + x0]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn otsu_uses_midpoint_of_empty_tied_plateau() {
        let image = GrayImage::from_vec(4, 1, 4, vec![10, 10, 200, 200]).unwrap();
        assert_eq!(otsu_threshold(&image), 105);
        assert_eq!(threshold_global(&image, 10).count_black(), 0);
    }
    #[test]
    fn local_methods_find_dark_center() {
        let mut image = GrayImage::new(9, 9, 220);
        image.set(4, 4, 20);
        assert!(threshold_local(&image, 2, LocalThreshold::Sauvola { k: 0.34 }).get(4, 4));
        assert!(threshold_local(
            &image,
            2,
            LocalThreshold::Wolf {
                k: 0.5,
                deviation_floor: 2.0
            }
        )
        .get(4, 4));
    }
}
