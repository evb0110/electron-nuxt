use crate::{BinaryImage, GrayImage};
use std::collections::VecDeque;

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
    let global_min = image.data().iter().copied().min().unwrap_or(u8::MAX);
    let mut max_deviation = 1.0f64;
    for_each_local_stat(image, radius, |_x, _y, _mean, deviation| {
        max_deviation = max_deviation.max(deviation);
    });
    let mut output = BinaryImage::new(width, height);
    for_each_local_stat(image, radius, |x, y, mean, deviation| {
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
    });
    output
}

fn horizontal_window_stats(image: &GrayImage, y: usize, radius: usize) -> (Vec<u32>, Vec<u32>) {
    let mut sums = vec![0u32; image.width()];
    let mut squares = vec![0u32; image.width()];
    let mut sum = 0u32;
    let mut square = 0u32;
    for x in 0..image.width() {
        if x == 0 {
            for sx in 0..=(radius.min(image.width().saturating_sub(1))) {
                let value = u32::from(image.get(sx, y));
                sum += value;
                square += value * value;
            }
        } else {
            let entering = x
                .saturating_add(radius)
                .min(image.width().saturating_sub(1));
            if entering
                > (x - 1)
                    .saturating_add(radius)
                    .min(image.width().saturating_sub(1))
            {
                let value = u32::from(image.get(entering, y));
                sum += value;
                square += value * value;
            }
            if x > radius {
                let leaving = x - radius - 1;
                let value = u32::from(image.get(leaving, y));
                sum -= value;
                square -= value * value;
            }
        }
        sums[x] = sum;
        squares[x] = square;
    }
    (sums, squares)
}

fn for_each_local_stat(
    image: &GrayImage,
    radius: usize,
    mut visit: impl FnMut(usize, usize, f64, f64),
) {
    if image.width() == 0 || image.height() == 0 {
        return;
    }
    let mut rows = VecDeque::<(usize, Vec<u32>, Vec<u32>)>::new();
    let mut vertical_sum = vec![0u64; image.width()];
    let mut vertical_square = vec![0u64; image.width()];
    let mut next_row = 0usize;
    for y in 0..image.height() {
        let first_row = y.saturating_sub(radius);
        let last_row = y.saturating_add(radius).min(image.height() - 1);
        while rows.front().is_some_and(|row| row.0 < first_row) {
            let (_, sums, squares) = rows.pop_front().unwrap();
            for x in 0..image.width() {
                vertical_sum[x] -= u64::from(sums[x]);
                vertical_square[x] -= u64::from(squares[x]);
            }
        }
        while next_row <= last_row {
            let (sums, squares) = horizontal_window_stats(image, next_row, radius);
            for x in 0..image.width() {
                vertical_sum[x] += u64::from(sums[x]);
                vertical_square[x] += u64::from(squares[x]);
            }
            rows.push_back((next_row, sums, squares));
            next_row += 1;
        }
        let vertical_count = last_row - first_row + 1;
        for x in 0..image.width() {
            let horizontal_count =
                x.saturating_add(radius).min(image.width() - 1) - x.saturating_sub(radius) + 1;
            let count = (horizontal_count * vertical_count) as f64;
            let mean = vertical_sum[x] as f64 / count;
            let deviation = (vertical_square[x] as f64 / count - mean * mean)
                .max(0.0)
                .sqrt();
            visit(x, y, mean, deviation);
        }
    }
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
