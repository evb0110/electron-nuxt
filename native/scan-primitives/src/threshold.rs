use crate::morphology::dilate_gray;
use crate::{BinaryImage, GrayImage};
use rayon::prelude::*;

const INTEGRAL_ROW_BLOCK_SIZE: usize = 64;
const DOCUMENTED_MAX_INTEGRAL_PIXELS: u64 = 1 << 32;
const _: () =
    assert!(DOCUMENTED_MAX_INTEGRAL_PIXELS <= u64::MAX / (u8::MAX as u64 * u8::MAX as u64));

/// Otsu threshold using dark `< threshold`; tied best-score plateaus use their midpoint.
pub fn otsu_threshold(image: &GrayImage) -> u8 {
    let mut histogram = [0u64; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    otsu_from_histogram(&histogram)
}

/// Otsu threshold with excluded pixels omitted from the histogram.
pub fn otsu_threshold_excluding(image: &GrayImage, excluded: &BinaryImage) -> u8 {
    assert_eq!(
        (image.width(), image.height()),
        (excluded.width(), excluded.height())
    );
    let mut histogram = [0u64; 256];
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !excluded.get(x, y) {
                histogram[image.get(x, y) as usize] += 1;
            }
        }
    }
    otsu_from_histogram(&histogram)
}

fn otsu_from_histogram(histogram: &[u64; 256]) -> u8 {
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

pub const DEFAULT_MOKJI_MAX_EDGE_WIDTH: usize = 5;
pub const DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE: u8 = 26;

/// Mokji's edge-co-occurrence threshold for dark foreground images.
///
/// The dilation uses a square of side `(max_edge_width + 1) * 2 - 1`.
/// Under the dark-foreground morphology convention this yields the darkest
/// neighbour. Eligible pairs differ by at least `min_edge_magnitude`, and the
/// result is the frequency-weighted mean of their midpoints.
pub fn mokji_threshold(image: &GrayImage, max_edge_width: usize, min_edge_magnitude: u8) -> u8 {
    assert!(max_edge_width >= 1, "Mokji max edge width must be positive");
    assert!(
        min_edge_magnitude >= 1,
        "Mokji minimum edge magnitude must be positive"
    );
    if image.width() <= max_edge_width.saturating_mul(2)
        || image.height() <= max_edge_width.saturating_mul(2)
    {
        return 128;
    }
    let darkest = dilate_gray(image, max_edge_width, max_edge_width);
    let mut midpoint_twice_sum = 0u64;
    let mut pair_count = 0u64;
    for y in max_edge_width..image.height() - max_edge_width {
        for x in max_edge_width..image.width() - max_edge_width {
            let low = darkest.get(x, y);
            let high = image.get(x, y);
            if high.saturating_sub(low) >= min_edge_magnitude {
                midpoint_twice_sum += u64::from(low) + u64::from(high);
                pair_count += 1;
            }
        }
    }
    if pair_count == 0 {
        128
    } else {
        ((midpoint_twice_sum as f64 * 0.5 / pair_count as f64).round() as u16).min(255) as u8
    }
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
    Sauvola {
        k: f64,
    },
    Wolf {
        k: f64,
        deviation_floor: f64,
        minimum_percentile: f64,
        hard_ink: u8,
        hard_paper: u8,
    },
}

/// Reusable summed-area tables for local grayscale statistics.
///
/// Both tables use `u64`. For the documented bound of 2^32 pixels, even the
/// sum-of-squares table is bounded by `2^32 * 255^2`, well below `u64::MAX`.
/// One instance can be queried with any radius, allowing multiscale local
/// thresholding to reuse the same input pass.
#[derive(Debug)]
pub struct IntegralImages {
    width: usize,
    height: usize,
    stride: usize,
    sums: Vec<u64>,
    squared_sums: Vec<u64>,
}

/// Summed-area statistics that omit pixels selected by a binary mask.
#[derive(Debug)]
pub struct MaskedIntegralImages {
    width: usize,
    height: usize,
    stride: usize,
    sums: Vec<u64>,
    squared_sums: Vec<u64>,
    counts: Vec<u64>,
}

impl MaskedIntegralImages {
    pub fn new(image: &GrayImage, excluded: &BinaryImage) -> Self {
        assert_eq!(
            (image.width(), image.height()),
            (excluded.width(), excluded.height())
        );
        let width = image.width();
        let height = image.height();
        let stride = width
            .checked_add(1)
            .expect("masked integral stride overflow");
        let len = stride
            .checked_mul(
                height
                    .checked_add(1)
                    .expect("masked integral height overflow"),
            )
            .expect("masked integral dimensions overflow");
        let mut sums = vec![0u64; len];
        let mut squared_sums = vec![0u64; len];
        let mut counts = vec![0u64; len];
        if width == 0 || height == 0 {
            return Self {
                width,
                height,
                stride,
                sums,
                squared_sums,
                counts,
            };
        }
        let block_len = stride
            .checked_mul(INTEGRAL_ROW_BLOCK_SIZE)
            .expect("masked integral row block overflow");
        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .zip(counts[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(
                |(block_index, ((sum_block, squared_sum_block), count_block))| {
                    let first_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
                    for local_y in 0..sum_block.len() / stride {
                        let source = image.row(first_y + local_y);
                        let mut row_sum = 0u64;
                        let mut row_squared_sum = 0u64;
                        let mut row_count = 0u64;
                        let row_start = local_y * stride;
                        let previous_row_start = local_y.saturating_sub(1) * stride;
                        for (x, &value) in source.iter().enumerate() {
                            if !excluded.get(x, first_y + local_y) {
                                let value = u64::from(value);
                                row_sum += value;
                                row_squared_sum += value * value;
                                row_count += 1;
                            }
                            let above = if local_y == 0 {
                                0
                            } else {
                                sum_block[previous_row_start + x + 1]
                            };
                            let squared_above = if local_y == 0 {
                                0
                            } else {
                                squared_sum_block[previous_row_start + x + 1]
                            };
                            let count_above = if local_y == 0 {
                                0
                            } else {
                                count_block[previous_row_start + x + 1]
                            };
                            sum_block[row_start + x + 1] = row_sum + above;
                            squared_sum_block[row_start + x + 1] = row_squared_sum + squared_above;
                            count_block[row_start + x + 1] = row_count + count_above;
                        }
                    }
                },
            );

        let block_count = height.div_ceil(INTEGRAL_ROW_BLOCK_SIZE);
        let offsets_len = block_count
            .checked_mul(stride)
            .expect("masked integral block offsets overflow");
        let mut sum_offsets = vec![0u64; offsets_len];
        let mut squared_sum_offsets = vec![0u64; offsets_len];
        let mut count_offsets = vec![0u64; offsets_len];
        for block_index in 1..block_count {
            let previous_end = block_index * INTEGRAL_ROW_BLOCK_SIZE * stride;
            let offset = block_index * stride;
            let prior_offset = (block_index - 1) * stride;
            for x in 1..stride {
                sum_offsets[offset + x] = sum_offsets[prior_offset + x] + sums[previous_end + x];
                squared_sum_offsets[offset + x] =
                    squared_sum_offsets[prior_offset + x] + squared_sums[previous_end + x];
                count_offsets[offset + x] =
                    count_offsets[prior_offset + x] + counts[previous_end + x];
            }
        }

        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .zip(counts[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(
                |(block_index, ((sum_block, squared_sum_block), count_block))| {
                    if block_index == 0 {
                        return;
                    }
                    let offset = &sum_offsets[block_index * stride..(block_index + 1) * stride];
                    let squared_offset =
                        &squared_sum_offsets[block_index * stride..(block_index + 1) * stride];
                    let count_offset =
                        &count_offsets[block_index * stride..(block_index + 1) * stride];
                    for ((sum_row, squared_sum_row), count_row) in sum_block
                        .chunks_mut(stride)
                        .zip(squared_sum_block.chunks_mut(stride))
                        .zip(count_block.chunks_mut(stride))
                    {
                        for x in 1..stride {
                            sum_row[x] += offset[x];
                            squared_sum_row[x] += squared_offset[x];
                            count_row[x] += count_offset[x];
                        }
                    }
                },
            );
        Self {
            width,
            height,
            stride,
            sums,
            squared_sums,
            counts,
        }
    }

    fn mean_and_deviation(&self, x: usize, y: usize, radius: usize) -> Option<(f64, f64)> {
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(self.width - 1) + 1;
        let y1 = y.saturating_add(radius).min(self.height - 1) + 1;
        let count = self.rectangle_sum(&self.counts, x0, y0, x1, y1);
        if count == 0 {
            return None;
        }
        let sum = self.rectangle_sum(&self.sums, x0, y0, x1, y1);
        let squared_sum = self.rectangle_sum(&self.squared_sums, x0, y0, x1, y1);
        let count = count as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        Some((mean, deviation))
    }

    fn rectangle_sum(&self, integral: &[u64], x0: usize, y0: usize, x1: usize, y1: usize) -> u64 {
        integral[y1 * self.stride + x1] + integral[y0 * self.stride + x0]
            - integral[y0 * self.stride + x1]
            - integral[y1 * self.stride + x0]
    }
}

impl IntegralImages {
    pub fn new(image: &GrayImage) -> Self {
        let width = image.width();
        let height = image.height();
        let pixel_count = width
            .checked_mul(height)
            .expect("image dimensions overflow usize");
        debug_assert!(
            pixel_count as u128 <= u128::from(DOCUMENTED_MAX_INTEGRAL_PIXELS),
            "integral images support at most 2^32 pixels"
        );

        let stride = width.checked_add(1).expect("integral stride overflow");
        let rows = height.checked_add(1).expect("integral height overflow");
        let len = stride
            .checked_mul(rows)
            .expect("integral image dimensions overflow usize");
        let mut sums = vec![0u64; len];
        let mut squared_sums = vec![0u64; len];

        if width == 0 || height == 0 {
            return Self {
                width,
                height,
                stride,
                sums,
                squared_sums,
            };
        }

        let block_len = stride
            .checked_mul(INTEGRAL_ROW_BLOCK_SIZE)
            .expect("integral row block overflow");
        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(|(block_index, (sum_block, squared_sum_block))| {
                let first_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
                for local_y in 0..sum_block.len() / stride {
                    let source = image.row(first_y + local_y);
                    let mut row_sum = 0u64;
                    let mut row_squared_sum = 0u64;
                    let row_start = local_y * stride;
                    let previous_row_start = local_y.saturating_sub(1) * stride;
                    for (x, &value) in source.iter().enumerate() {
                        let value = u64::from(value);
                        row_sum += value;
                        row_squared_sum += value * value;
                        let above = if local_y == 0 {
                            0
                        } else {
                            sum_block[previous_row_start + x + 1]
                        };
                        let squared_above = if local_y == 0 {
                            0
                        } else {
                            squared_sum_block[previous_row_start + x + 1]
                        };
                        sum_block[row_start + x + 1] = row_sum + above;
                        squared_sum_block[row_start + x + 1] = row_squared_sum + squared_above;
                    }
                }
            });

        let block_count = height.div_ceil(INTEGRAL_ROW_BLOCK_SIZE);
        let offsets_len = block_count
            .checked_mul(stride)
            .expect("integral block offsets overflow");
        let mut sum_offsets = vec![0u64; offsets_len];
        let mut squared_sum_offsets = vec![0u64; offsets_len];
        for block_index in 1..block_count {
            let previous_end_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
            let previous_end = previous_end_y * stride;
            let offset = block_index * stride;
            let prior_offset = (block_index - 1) * stride;
            for x in 1..stride {
                sum_offsets[offset + x] = sum_offsets[prior_offset + x] + sums[previous_end + x];
                squared_sum_offsets[offset + x] =
                    squared_sum_offsets[prior_offset + x] + squared_sums[previous_end + x];
            }
        }

        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(|(block_index, (sum_block, squared_sum_block))| {
                if block_index == 0 {
                    return;
                }
                let offset = &sum_offsets[block_index * stride..(block_index + 1) * stride];
                let squared_offset =
                    &squared_sum_offsets[block_index * stride..(block_index + 1) * stride];
                for (sum_row, squared_sum_row) in sum_block
                    .chunks_mut(stride)
                    .zip(squared_sum_block.chunks_mut(stride))
                {
                    for x in 1..stride {
                        sum_row[x] += offset[x];
                        squared_sum_row[x] += squared_offset[x];
                    }
                }
            });

        Self {
            width,
            height,
            stride,
            sums,
            squared_sums,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Returns the population mean and standard deviation for the clamped
    /// square window centered on `(x, y)`.
    pub fn mean_and_deviation(&self, x: usize, y: usize, radius: usize) -> (f64, f64) {
        assert!(x < self.width && y < self.height);
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(self.width - 1) + 1;
        let y1 = y.saturating_add(radius).min(self.height - 1) + 1;
        let sum = self.rectangle_sum(&self.sums, x0, y0, x1, y1);
        let squared_sum = self.rectangle_sum(&self.squared_sums, x0, y0, x1, y1);
        let count = ((x1 - x0) * (y1 - y0)) as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        (mean, deviation)
    }

    fn rectangle_sum(&self, integral: &[u64], x0: usize, y0: usize, x1: usize, y1: usize) -> u64 {
        integral[y1 * self.stride + x1] + integral[y0 * self.stride + x0]
            - integral[y0 * self.stride + x1]
            - integral[y1 * self.stride + x0]
    }
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
    let integrals = IntegralImages::new(image);
    threshold_local_biased_with_integrals(image, &integrals, radius, method, bias)
}

/// Applies local thresholding using caller-provided integral images.
///
/// Reuse `integrals` across calls with different radii to avoid rebuilding the
/// summed-area tables for multiscale thresholding.
pub fn threshold_local_with_integrals(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
) -> BinaryImage {
    threshold_local_biased_with_integrals(image, integrals, radius, method, 0)
}

/// Applies biased local thresholding with integral images built from `image`.
///
/// Panics when the image and integral dimensions differ. Callers are
/// responsible for ensuring equal-sized inputs also contain the same pixels.
pub fn threshold_local_biased_with_integrals(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    threshold_local_biased_with_integrals_impl(image, integrals, radius, method, bias, true)
}

/// Applies one scale of a multiscale local threshold.
///
/// For Wolf, the deviation floor protects the per-window normalization
/// denominator but is not substituted for each local deviation. This faithful
/// low-variance behavior prevents flat paper windows from degenerating to a
/// mean threshold. The legacy single-window entry points retain their exact
/// historical numerator-floor behavior.
pub fn threshold_local_biased_with_integrals_for_consensus(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    threshold_local_biased_with_integrals_impl(image, integrals, radius, method, bias, false)
}

/// Produces a three-scale local-threshold consensus in one traversal for an
/// unmasked image.
///
/// This is the unmasked counterpart of
/// [`threshold_local_multiscale_biased_excluding_with_integrals_for_consensus`].
/// It preserves the exact per-radius consensus decisions of three calls to
/// [`threshold_local_biased_with_integrals_for_consensus`] while avoiding the
/// three temporary full-page masks and the separate combination pass.
pub fn threshold_local_multiscale_biased_with_integrals_for_consensus(
    image: &GrayImage,
    integrals: &IntegralImages,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    assert_eq!((integrals.width(), integrals.height()), (width, height));
    if width == 0 || height == 0 {
        return BinaryImage::new(width, height);
    }
    let global_min = match method {
        LocalThreshold::Wolf {
            minimum_percentile, ..
        } => grayscale_percentile(image, minimum_percentile),
        LocalThreshold::Sauvola { .. } => 0,
    };
    let max_deviations = match method {
        LocalThreshold::Wolf { .. } => (0..height)
            .into_par_iter()
            .map(|y| {
                let mut maxima = [1.0f64; 3];
                for x in 0..width {
                    for (index, radius) in radii.into_iter().enumerate() {
                        maxima[index] =
                            maxima[index].max(integrals.mean_and_deviation(x, y, radius).1);
                    }
                }
                maxima
            })
            .reduce(
                || [1.0; 3],
                |left, right| std::array::from_fn(|index| left[index].max(right[index])),
            ),
        LocalThreshold::Sauvola { .. } => [1.0; 3],
    };
    let low_variance: [bool; 3] = std::array::from_fn(|index| {
        matches!(
            method,
            LocalThreshold::Wolf {
                deviation_floor,
                ..
            } if max_deviations[index] <= deviation_floor
        )
    });
    let mut output = BinaryImage::new(width, height);
    let words_per_line = output.words_per_line();
    output
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for x in 0..width {
                let value = image.get(x, y);
                let mut black = [false; 3];
                for (index, radius) in radii.into_iter().enumerate() {
                    let (mean, deviation) = integrals.mean_and_deviation(x, y, radius);
                    let threshold = match method {
                        LocalThreshold::Sauvola { k } => {
                            mean * (1.0 + k * (deviation / 128.0 - 1.0))
                        }
                        LocalThreshold::Wolf {
                            k, deviation_floor, ..
                        } => {
                            let normalized = deviation / max_deviations[index].max(deviation_floor);
                            mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                        }
                    };
                    black[index] = match method {
                        LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                        LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                        LocalThreshold::Wolf { .. } if low_variance[index] => false,
                        _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                    };
                }
                if (black[1] && black[2]) || (black[0] && supports_small_scale(x, y)) {
                    output_row[x / 32] |= 1 << (31 - x % 32);
                }
            }
        });
    output
}

pub fn threshold_local_biased_excluding(
    image: &GrayImage,
    excluded: &BinaryImage,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    let integrals = MaskedIntegralImages::new(image, excluded);
    threshold_local_biased_excluding_impl(image, excluded, &integrals, radius, method, bias, true)
}

pub fn threshold_local_biased_excluding_with_integrals_for_consensus(
    image: &GrayImage,
    excluded: &BinaryImage,
    integrals: &MaskedIntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    threshold_local_biased_excluding_impl(image, excluded, integrals, radius, method, bias, false)
}

/// Produces a three-scale local-threshold consensus in one traversal.
///
/// The three independent entry points each scanned the excluded histogram,
/// searched the maximum deviation, and allocated/fed a packed output before a
/// fourth traversal combined them. Sharing those invariant passes and emitting
/// the consensus directly preserves every per-radius threshold decision while
/// avoiding the three temporary full-page masks.
pub fn threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
    image: &GrayImage,
    excluded: &BinaryImage,
    integrals: &MaskedIntegralImages,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    assert_eq!((excluded.width(), excluded.height()), (width, height));
    assert_eq!((integrals.width, integrals.height), (width, height));
    if width == 0 || height == 0 {
        return BinaryImage::new(width, height);
    }
    let global_min = match method {
        LocalThreshold::Wolf {
            minimum_percentile, ..
        } => grayscale_percentile_excluding(image, excluded, minimum_percentile),
        LocalThreshold::Sauvola { .. } => 0,
    };
    let max_deviations = match method {
        LocalThreshold::Wolf { .. } => (0..height)
            .into_par_iter()
            .map(|y| {
                let mut maxima = [1.0f64; 3];
                for x in 0..width {
                    for (index, radius) in radii.into_iter().enumerate() {
                        maxima[index] = maxima[index].max(
                            integrals
                                .mean_and_deviation(x, y, radius)
                                .map_or(0.0, |statistics| statistics.1),
                        );
                    }
                }
                maxima
            })
            .reduce(
                || [1.0; 3],
                |left, right| std::array::from_fn(|index| left[index].max(right[index])),
            ),
        LocalThreshold::Sauvola { .. } => [1.0; 3],
    };
    let low_variance: [bool; 3] = std::array::from_fn(|index| {
        matches!(
            method,
            LocalThreshold::Wolf {
                deviation_floor,
                ..
            } if max_deviations[index] <= deviation_floor
        )
    });
    let mut output = BinaryImage::new(width, height);
    let words_per_line = output.words_per_line();
    output
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for x in 0..width {
                if excluded.get(x, y) {
                    continue;
                }
                let value = image.get(x, y);
                let mut black = [false; 3];
                for (index, radius) in radii.into_iter().enumerate() {
                    let Some((mean, deviation)) = integrals.mean_and_deviation(x, y, radius) else {
                        continue;
                    };
                    let threshold = match method {
                        LocalThreshold::Sauvola { k } => {
                            mean * (1.0 + k * (deviation / 128.0 - 1.0))
                        }
                        LocalThreshold::Wolf {
                            k, deviation_floor, ..
                        } => {
                            let normalized = deviation / max_deviations[index].max(deviation_floor);
                            mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                        }
                    };
                    black[index] = match method {
                        LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                        LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                        LocalThreshold::Wolf { .. } if low_variance[index] => false,
                        _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                    };
                }
                if (black[1] && black[2]) || (black[0] && supports_small_scale(x, y)) {
                    output_row[x / 32] |= 1 << (31 - x % 32);
                }
            }
        });
    output
}

fn threshold_local_biased_excluding_impl(
    image: &GrayImage,
    excluded: &BinaryImage,
    integrals: &MaskedIntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
    floor_local_wolf_deviation: bool,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    assert_eq!((excluded.width(), excluded.height()), (width, height));
    assert_eq!((integrals.width, integrals.height), (width, height));
    if width == 0 || height == 0 {
        return BinaryImage::new(width, height);
    }
    let global_min = match method {
        LocalThreshold::Wolf {
            minimum_percentile, ..
        } => grayscale_percentile_excluding(image, excluded, minimum_percentile),
        LocalThreshold::Sauvola { .. } => 0,
    };
    let max_deviation = match method {
        LocalThreshold::Wolf { .. } => (0..height)
            .into_par_iter()
            .map(|y| {
                (0..width).fold(1.0f64, |maximum, x| {
                    maximum.max(
                        integrals
                            .mean_and_deviation(x, y, radius)
                            .map_or(0.0, |statistics| statistics.1),
                    )
                })
            })
            .reduce(|| 1.0, f64::max),
        LocalThreshold::Sauvola { .. } => 1.0,
    };
    let low_variance_wolf = matches!(
        method,
        LocalThreshold::Wolf {
            deviation_floor,
            ..
        } if !floor_local_wolf_deviation && max_deviation <= deviation_floor
    );
    let mut output = BinaryImage::new(width, height);
    let words_per_line = output.words_per_line();
    output
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for x in 0..width {
                if excluded.get(x, y) {
                    continue;
                }
                let Some((mean, deviation)) = integrals.mean_and_deviation(x, y, radius) else {
                    continue;
                };
                let threshold = match method {
                    LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                    LocalThreshold::Wolf {
                        k, deviation_floor, ..
                    } => {
                        let local_deviation = if floor_local_wolf_deviation {
                            deviation.max(deviation_floor)
                        } else {
                            deviation
                        };
                        let normalized = local_deviation / max_deviation.max(deviation_floor);
                        mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                    }
                };
                let value = image.get(x, y);
                let black = match method {
                    LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                    LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                    LocalThreshold::Wolf { .. } if low_variance_wolf => false,
                    _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                };
                if black {
                    output_row[x / 32] |= 1 << (31 - x % 32);
                }
            }
        });
    output
}

fn threshold_local_biased_with_integrals_impl(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
    floor_local_wolf_deviation: bool,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    assert_eq!((integrals.width(), integrals.height()), (width, height));
    if width == 0 || height == 0 {
        return BinaryImage::new(width, height);
    }
    let global_min = match method {
        LocalThreshold::Wolf {
            minimum_percentile, ..
        } => grayscale_percentile(image, minimum_percentile),
        LocalThreshold::Sauvola { .. } => 0,
    };
    let max_deviation = match method {
        LocalThreshold::Wolf { .. } => (0..height)
            .into_par_iter()
            .map(|y| {
                (0..width).fold(1.0f64, |maximum, x| {
                    maximum.max(integrals.mean_and_deviation(x, y, radius).1)
                })
            })
            .reduce(|| 1.0, f64::max),
        LocalThreshold::Sauvola { .. } => 1.0,
    };
    let low_variance_wolf = matches!(
        method,
        LocalThreshold::Wolf {
            deviation_floor,
            ..
        } if !floor_local_wolf_deviation && max_deviation <= deviation_floor
    );
    let mut output = BinaryImage::new(width, height);
    let words_per_line = output.words_per_line();
    output
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for x in 0..width {
                let (mean, deviation) = integrals.mean_and_deviation(x, y, radius);
                let threshold = match method {
                    LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                    LocalThreshold::Wolf {
                        k, deviation_floor, ..
                    } => {
                        let local_deviation = if floor_local_wolf_deviation {
                            deviation.max(deviation_floor)
                        } else {
                            deviation
                        };
                        let normalized = local_deviation / max_deviation.max(deviation_floor);
                        mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                    }
                };
                let value = image.get(x, y);
                let black = match method {
                    LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                    LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                    LocalThreshold::Wolf { .. } if low_variance_wolf => false,
                    _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                };
                if black {
                    output_row[x / 32] |= 1 << (31 - x % 32);
                }
            }
        });
    output
}

fn grayscale_percentile(image: &GrayImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let count = image.width().saturating_mul(image.height());
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

fn grayscale_percentile_excluding(image: &GrayImage, excluded: &BinaryImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    let mut count = 0usize;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !excluded.get(x, y) {
                histogram[image.get(x, y) as usize] += 1;
                count += 1;
            }
        }
    }
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, time::Instant};

    fn reference_threshold_local_biased(
        image: &GrayImage,
        radius: usize,
        method: LocalThreshold,
        bias: i16,
    ) -> BinaryImage {
        let global_min = match method {
            LocalThreshold::Wolf {
                minimum_percentile, ..
            } => reference_grayscale_percentile(image, minimum_percentile),
            LocalThreshold::Sauvola { .. } => 0,
        };
        let mut max_deviation = 1.0f64;
        reference_for_each_local_stat(image, radius, |_x, _y, _mean, deviation| {
            max_deviation = max_deviation.max(deviation);
        });
        let mut output = BinaryImage::new(image.width(), image.height());
        reference_for_each_local_stat(image, radius, |x, y, mean, deviation| {
            let threshold = match method {
                LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                LocalThreshold::Wolf {
                    k, deviation_floor, ..
                } => {
                    let normalized =
                        deviation.max(deviation_floor) / max_deviation.max(deviation_floor);
                    mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                }
            };
            let value = image.get(x, y);
            let black = match method {
                LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
            };
            output.set(x, y, black);
        });
        output
    }

    fn reference_threshold_local_for_consensus(
        image: &GrayImage,
        radius: usize,
        method: LocalThreshold,
        bias: i16,
    ) -> BinaryImage {
        if image.width() == 0 || image.height() == 0 {
            return BinaryImage::new(image.width(), image.height());
        }
        let global_min = match method {
            LocalThreshold::Wolf {
                minimum_percentile, ..
            } => reference_grayscale_percentile(image, minimum_percentile),
            LocalThreshold::Sauvola { .. } => 0,
        };
        let mut max_deviation = 1.0f64;
        reference_for_each_local_stat(image, radius, |_x, _y, _mean, deviation| {
            max_deviation = max_deviation.max(deviation);
        });
        let low_variance_wolf = matches!(
            method,
            LocalThreshold::Wolf {
                deviation_floor,
                ..
            } if max_deviation <= deviation_floor
        );
        let mut output = BinaryImage::new(image.width(), image.height());
        reference_for_each_local_stat(image, radius, |x, y, mean, deviation| {
            let threshold = match method {
                LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                LocalThreshold::Wolf {
                    k, deviation_floor, ..
                } => {
                    let normalized = deviation / max_deviation.max(deviation_floor);
                    mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                }
            };
            let value = image.get(x, y);
            let black = match method {
                LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                LocalThreshold::Wolf { .. } if low_variance_wolf => false,
                _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
            };
            output.set(x, y, black);
        });
        output
    }

    fn reference_multiscale_consensus(
        image: &GrayImage,
        radii: [usize; 3],
        method: LocalThreshold,
        bias: i16,
        supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
    ) -> BinaryImage {
        let scales = radii
            .map(|radius| reference_threshold_local_for_consensus(image, radius, method, bias));
        BinaryImage::from_fn_parallel(image.width(), image.height(), |x, y| {
            (scales[1].get(x, y) && scales[2].get(x, y))
                || (scales[0].get(x, y) && supports_small_scale(x, y))
        })
    }

    fn reference_grayscale_percentile(image: &GrayImage, fraction: f64) -> u8 {
        let mut values = Vec::with_capacity(image.width() * image.height());
        for y in 0..image.height() {
            values.extend_from_slice(image.row(y));
        }
        if values.is_empty() {
            return 255;
        }
        values.sort_unstable();
        let target = ((values.len() - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
        values[target]
    }

    fn reference_horizontal_window_stats(
        image: &GrayImage,
        y: usize,
        radius: usize,
    ) -> (Vec<u32>, Vec<u32>) {
        let mut sums = vec![0u32; image.width()];
        let mut squares = vec![0u32; image.width()];
        let mut sum = 0u32;
        let mut square = 0u32;
        for x in 0..image.width() {
            if x == 0 {
                for sx in 0..=radius.min(image.width().saturating_sub(1)) {
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

    fn reference_for_each_local_stat(
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
                let (sums, squares) = reference_horizontal_window_stats(image, next_row, radius);
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

    fn random_image(width: usize, height: usize, padding: usize, state: &mut u64) -> GrayImage {
        let stride = width + padding;
        let mut data = vec![0u8; stride * height];
        for value in &mut data {
            *state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *value = (*state >> 32) as u8;
        }
        GrayImage::from_vec(width, height, stride, data).unwrap()
    }

    fn naive_mean_and_deviation(
        image: &GrayImage,
        x: usize,
        y: usize,
        radius: usize,
    ) -> (f64, f64) {
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(image.width() - 1);
        let y1 = y.saturating_add(radius).min(image.height() - 1);
        let mut sum = 0u64;
        let mut squared_sum = 0u64;
        for sy in y0..=y1 {
            for sx in x0..=x1 {
                let value = u64::from(image.get(sx, sy));
                sum += value;
                squared_sum += value * value;
            }
        }
        let count = ((x1 - x0 + 1) * (y1 - y0 + 1)) as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        (mean, deviation)
    }

    #[test]
    fn otsu_uses_midpoint_of_empty_tied_plateau() {
        let image = GrayImage::from_vec(4, 1, 4, vec![10, 10, 200, 200]).unwrap();
        assert_eq!(otsu_threshold(&image), 105);
        assert_eq!(threshold_global(&image, 10).count_black(), 0);
    }

    #[test]
    fn mokji_uses_edge_midpoints_and_falls_back_without_edges() {
        let flat = GrayImage::new(31, 21, 190);
        assert_eq!(
            mokji_threshold(
                &flat,
                DEFAULT_MOKJI_MAX_EDGE_WIDTH,
                DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE
            ),
            128
        );

        let mut edge = GrayImage::new(31, 21, 30);
        for y in 0..edge.height() {
            for x in 15..edge.width() {
                edge.set(x, y, 230);
            }
        }
        assert_eq!(mokji_threshold(&edge, 5, 26), 130);
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
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            }
        )
        .get(4, 4));
    }

    #[test]
    fn wolf_uses_a_robust_minimum_and_hard_ink_paper_bounds() {
        let mut image = GrayImage::new(20, 20, 220);
        image.set(0, 0, 0);
        image.set(1, 1, 40);
        image.set(2, 2, 252);
        assert_eq!(grayscale_percentile(&image, 0.01), 220);
        let binary = threshold_local(
            &image,
            3,
            LocalThreshold::Wolf {
                k: 0.3,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            },
        );
        assert!(binary.get(1, 1));
        assert!(!binary.get(2, 2));
    }

    #[test]
    fn grayscale_percentile_ignores_stride_padding() {
        let image = GrayImage::from_vec(
            3,
            2,
            6,
            vec![10, 20, 30, 255, 255, 255, 40, 50, 60, 255, 255, 255],
        )
        .unwrap();
        assert_eq!(
            grayscale_percentile(&image, 0.5),
            reference_grayscale_percentile(&image, 0.5)
        );
        assert_eq!(grayscale_percentile(&image, 0.5), 40);
    }

    #[test]
    fn fused_unmasked_multiscale_consensus_is_bit_exact_to_independent_scales() {
        let mut state = 0x3c4a_1e92_776d_4f08;
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let radii = [2, 7, 19];
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        for (width, height, padding) in
            [(1, 1, 0), (1, 7, 3), (7, 1, 2), (29, 17, 5), (137, 131, 3)]
        {
            let image = random_image(width, height, padding, &mut state);
            let integrals = IntegralImages::new(&image);
            let expected =
                reference_multiscale_consensus(&image, radii, method, -4, supports_small_scale);
            let actual = threshold_local_multiscale_biased_with_integrals_for_consensus(
                &image,
                &integrals,
                radii,
                method,
                -4,
                supports_small_scale,
            );
            assert_eq!(
                actual.words(),
                expected.words(),
                "{width}x{height} with {padding} padding"
            );
        }
    }

    #[test]
    fn fused_unmasked_multiscale_consensus_preserves_zero_dimensions() {
        let method = LocalThreshold::Sauvola { k: 0.34 };
        for (width, height) in [(0, 0), (0, 3), (3, 0)] {
            let mut state = 0x70d6_5f21_49bc_8a12;
            let image = random_image(width, height, 4, &mut state);
            let integrals = IntegralImages::new(&image);
            let actual = threshold_local_multiscale_biased_with_integrals_for_consensus(
                &image,
                &integrals,
                [0, 1, usize::MAX],
                method,
                0,
                |_, _| true,
            );
            assert_eq!((actual.width(), actual.height()), (width, height));
            assert_eq!(actual.count_black(), 0);
        }
    }

    #[test]
    fn consensus_wolf_abstains_on_low_variance_paper_but_keeps_hard_ink() {
        let mut image = GrayImage::new(31, 23, 220);
        for y in 0..image.height() {
            for x in 0..image.width() {
                image.set(x, y, 219 + ((x * 5 + y * 3) % 3) as u8);
            }
        }
        let integrals = IntegralImages::new(&image);
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let flat_consensus_scale =
            threshold_local_biased_with_integrals_for_consensus(&image, &integrals, 4, method, 0);
        assert_eq!(flat_consensus_scale.count_black(), 0);

        image.set(15, 11, 40);
        let hard_ink_integrals = IntegralImages::new(&image);
        let with_hard_ink = threshold_local_biased_with_integrals_for_consensus(
            &image,
            &hard_ink_integrals,
            4,
            method,
            0,
        );
        assert!(with_hard_ink.get(15, 11));
    }

    #[test]
    fn integral_images_reuse_exact_statistics_across_radii() {
        let mut state = 0x93d7_65a2_18cf_b401;
        let image = random_image(19, 11, 4, &mut state);
        let integrals = IntegralImages::new(&image);
        for radius in [0, 1, 4, 20, usize::MAX] {
            for y in 0..image.height() {
                for x in 0..image.width() {
                    let actual = integrals.mean_and_deviation(x, y, radius);
                    let expected = naive_mean_and_deviation(&image, x, y, radius);
                    assert_eq!(actual.0.to_bits(), expected.0.to_bits());
                    assert_eq!(actual.1.to_bits(), expected.1.to_bits());
                }
            }
        }
    }

    #[test]
    fn parallel_masked_integrals_and_fused_scales_are_bit_exact() {
        let mut state = 0x7b21_f05e_942d_1ac3;
        let image = random_image(137, 131, 3, &mut state);
        let mut excluded = BinaryImage::new(image.width(), image.height());
        for y in 0..image.height() {
            for x in 0..image.width() {
                excluded.set(x, y, (x * 11 + y * 17) % 37 < 7);
            }
        }
        let integrals = MaskedIntegralImages::new(&image, &excluded);
        let radii = [2, 7, 19];
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let expected = radii.map(|radius| {
            threshold_local_biased_excluding_with_integrals_for_consensus(
                &image, &excluded, &integrals, radius, method, -4,
            )
        });
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        let expected_consensus =
            BinaryImage::from_fn_parallel(image.width(), image.height(), |x, y| {
                (expected[1].get(x, y) && expected[2].get(x, y))
                    || (expected[0].get(x, y) && supports_small_scale(x, y))
            });
        let actual = threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
            &image,
            &excluded,
            &integrals,
            radii,
            method,
            -4,
            supports_small_scale,
        );
        assert_eq!(actual, expected_consensus);

        for radius in [0, 4, 80] {
            for (x, y) in [(0usize, 0usize), (53, 63), (91, 64), (136, 130)] {
                let x0 = x.saturating_sub(radius);
                let y0 = y.saturating_sub(radius);
                let x1 = x.saturating_add(radius).min(image.width() - 1);
                let y1 = y.saturating_add(radius).min(image.height() - 1);
                let mut sum = 0u64;
                let mut squared_sum = 0u64;
                let mut count = 0u64;
                for sample_y in y0..=y1 {
                    for sample_x in x0..=x1 {
                        if !excluded.get(sample_x, sample_y) {
                            let value = u64::from(image.get(sample_x, sample_y));
                            sum += value;
                            squared_sum += value * value;
                            count += 1;
                        }
                    }
                }
                let expected = if count == 0 {
                    None
                } else {
                    let mean = sum as f64 / count as f64;
                    Some((
                        mean,
                        (squared_sum as f64 / count as f64 - mean * mean)
                            .max(0.0)
                            .sqrt(),
                    ))
                };
                let actual = integrals.mean_and_deviation(x, y, radius);
                assert_eq!(
                    actual.map(|value| (value.0.to_bits(), value.1.to_bits())),
                    expected.map(|value| (value.0.to_bits(), value.1.to_bits())),
                );
            }
        }
    }

    #[test]
    fn local_thresholds_are_byte_identical_to_sliding_window_reference() {
        let mut state = 0x4f1b_a923_d7e6_508c;
        let cases = [(1, 1, 0), (2, 7, 3), (17, 13, 0), (33, 19, 5), (64, 41, 1)];
        let methods = [
            LocalThreshold::Sauvola { k: 0.34 },
            LocalThreshold::Sauvola { k: 0.17 },
            LocalThreshold::Wolf {
                k: 0.2,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            },
            LocalThreshold::Wolf {
                k: 0.57,
                deviation_floor: 5.5,
                minimum_percentile: 0.13,
                hard_ink: 31,
                hard_paper: 239,
            },
        ];
        for (width, height, padding) in cases {
            let image = random_image(width, height, padding, &mut state);
            for radius in [0, 1, 3, 16, usize::MAX] {
                for method in methods {
                    for bias in [-23, 0, 19] {
                        let expected =
                            reference_threshold_local_biased(&image, radius, method, bias);
                        let actual = threshold_local_biased(&image, radius, method, bias);
                        assert_eq!(
                            actual.words(),
                            expected.words(),
                            "{width}x{height}, radius {radius}, method {method:?}, bias {bias}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn caller_provided_integrals_match_convenience_api() {
        let mut state = 0xc01d_5eed_5ca1_ab1e;
        let image = random_image(47, 29, 2, &mut state);
        let integrals = IntegralImages::new(&image);
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        for radius in [2, 7, 18] {
            assert_eq!(
                threshold_local_with_integrals(&image, &integrals, radius, method),
                threshold_local(&image, radius, method)
            );
        }
    }

    #[test]
    #[ignore = "manual release-mode timing for the P2 report"]
    fn benchmark_wolf_integral_images_against_sliding_window() {
        let width = 2_550;
        let height = 3_300;
        let mut data = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let paper = 205 + ((x * 13 + y * 7 + x * y % 31) % 45) as u8;
                let text = (x % 83 < 4 && y % 29 < 21) || (y % 97 < 3 && x % 211 < 130);
                data.push(if text {
                    paper.saturating_sub(170)
                } else {
                    paper
                });
            }
        }
        let image = GrayImage::from_vec(width, height, width, data).unwrap();
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };

        let before_started = Instant::now();
        let before = std::hint::black_box(reference_threshold_local_biased(&image, 32, method, 0));
        let before_elapsed = before_started.elapsed();
        let after_started = Instant::now();
        let after = std::hint::black_box(threshold_local(&image, 32, method));
        let after_elapsed = after_started.elapsed();

        assert_eq!(after, before);
        eprintln!(
            "P2 wolf 2550x3300 radius=32: before={before_elapsed:?} after={after_elapsed:?} speedup={:.2}x",
            before_elapsed.as_secs_f64() / after_elapsed.as_secs_f64()
        );
    }
}
