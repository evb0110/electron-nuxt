use rayon::prelude::*;
use std::ops::Range;

/// Owned 8-bit grayscale image with an explicit byte stride.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrayImage {
    width: usize,
    height: usize,
    stride: usize,
    data: Vec<u8>,
}

/// Borrowed 8-bit grayscale image with an explicit byte stride.
#[derive(Clone, Copy, Debug)]
pub struct GrayView<'a> {
    width: usize,
    height: usize,
    stride: usize,
    data: &'a [u8],
}

impl GrayImage {
    /// Creates a tightly packed image filled with `value`.
    pub fn new(width: usize, height: usize, value: u8) -> Self {
        Self::with_stride(width, height, width, value)
    }

    /// Creates an image with caller-selected stride.
    pub fn with_stride(width: usize, height: usize, stride: usize, value: u8) -> Self {
        assert!(stride >= width);
        Self {
            width,
            height,
            stride,
            data: vec![value; stride.saturating_mul(height)],
        }
    }

    /// Constructs an image after validating the buffer dimensions.
    pub fn from_vec(width: usize, height: usize, stride: usize, data: Vec<u8>) -> Option<Self> {
        (stride >= width && data.len() == stride.checked_mul(height)?).then_some(Self {
            width,
            height,
            stride,
            data,
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }
    pub fn stride(&self) -> usize {
        self.stride
    }
    pub fn data(&self) -> &[u8] {
        &self.data
    }
    pub fn into_data(self) -> Vec<u8> {
        self.data
    }
    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }
    pub fn view(&self) -> GrayView<'_> {
        GrayView {
            width: self.width,
            height: self.height,
            stride: self.stride,
            data: &self.data,
        }
    }

    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.stride + x]
    }
    pub fn set(&mut self, x: usize, y: usize, value: u8) {
        self.data[y * self.stride + x] = value;
    }

    pub fn row(&self, y: usize) -> &[u8] {
        &self.data[self.row_range(y)]
    }

    pub fn row_mut(&mut self, y: usize) -> &mut [u8] {
        let range = self.row_range(y);
        &mut self.data[range]
    }

    fn row_range(&self, y: usize) -> Range<usize> {
        let start = y * self.stride;
        start..start + self.width
    }

    /// Downscales with area averaging so neither dimension exceeds its bound.
    pub fn downscale_to_fit(&self, max_width: usize, max_height: usize) -> Self {
        if self.width <= max_width && self.height <= max_height {
            return self.clone();
        }
        let scale = (self.width as f64 / max_width.max(1) as f64)
            .max(self.height as f64 / max_height.max(1) as f64);
        let scaled_dimension = |length: usize| ((length as f64 / scale).round() as usize).max(1);
        let out_width = scaled_dimension(self.width);
        let out_height = scaled_dimension(self.height);
        self.downscale_to_dimensions(out_width, out_height)
    }

    /// Downscales with area averaging to the exact requested dimensions.
    pub fn downscale_to_dimensions(&self, out_width: usize, out_height: usize) -> Self {
        assert!(out_width > 0);
        assert!(out_height > 0);
        if self.width == out_width && self.height == out_height {
            return self.clone();
        }
        let sample_bounds = |index: usize, source_len: usize, output_len: usize| {
            let start = index * source_len / output_len;
            let end = ((index + 1) * source_len / output_len)
                .max(start + 1)
                .min(source_len);
            (start, end)
        };
        let x_bounds = (0..out_width)
            .map(|x| sample_bounds(x, self.width, out_width))
            .collect::<Vec<_>>();
        let mut output = Self::new(out_width, out_height, 255);
        output
            .data_mut()
            .par_chunks_mut(out_width)
            .enumerate()
            .for_each(|(oy, output_row)| {
                let (y0, y1) = sample_bounds(oy, self.height, out_height);
                for (target, &(x0, x1)) in output_row.iter_mut().zip(&x_bounds) {
                    let mut sum = 0u64;
                    for y in y0..y1 {
                        sum += self.row(y)[x0..x1]
                            .iter()
                            .map(|&value| u64::from(value))
                            .sum::<u64>();
                    }
                    let count = (x1 - x0) as u64 * (y1 - y0) as u64;
                    *target = (sum / count) as u8;
                }
            });
        output
    }

    /// Resamples to the exact requested dimensions in either direction: area
    /// averaging where the image shrinks, bilinear interpolation where it
    /// grows, so a page scaled up to a document-wide canvas keeps continuous
    /// tone instead of gaining nearest-neighbour blocks.
    pub fn resample_to_dimensions(&self, out_width: usize, out_height: usize) -> Self {
        assert!(out_width > 0);
        assert!(out_height > 0);
        if self.width == out_width && self.height == out_height {
            return self.clone();
        }
        if out_width <= self.width && out_height <= self.height {
            return self.downscale_to_dimensions(out_width, out_height);
        }
        // Each axis is resampled by the rule that fits its own direction, so a
        // page that grows in one axis and shrinks in the other is neither
        // aliased nor blocked.
        let intermediate = if out_width < self.width {
            self.downscale_to_dimensions(out_width, self.height)
        } else if out_height < self.height {
            self.downscale_to_dimensions(self.width, out_height)
        } else {
            self.clone()
        };
        let x_map = axis_samples(intermediate.width, out_width);
        let y_map = axis_samples(intermediate.height, out_height);
        let mut output = Self::new(out_width, out_height, 255);
        output
            .data_mut()
            .par_chunks_mut(out_width)
            .enumerate()
            .for_each(|(oy, row)| {
                let (y0, y1, wy) = y_map[oy];
                let top = intermediate.row(y0);
                let bottom = intermediate.row(y1);
                for (target, &(x0, x1, wx)) in row.iter_mut().zip(&x_map) {
                    let top_value = f64::from(top[x0]) * (1.0 - wx) + f64::from(top[x1]) * wx;
                    let bottom_value =
                        f64::from(bottom[x0]) * (1.0 - wx) + f64::from(bottom[x1]) * wx;
                    *target = (top_value * (1.0 - wy) + bottom_value * wy)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            });
        output
    }
}

/// Bilinear source neighbours and weight for every output index of one axis.
pub(crate) fn axis_samples(source_len: usize, out_len: usize) -> Vec<(usize, usize, f64)> {
    (0..out_len)
        .map(|index| {
            if source_len == 1 || out_len == 1 {
                return (0, 0, 0.0);
            }
            let position = (index as f64 + 0.5) * source_len as f64 / out_len as f64 - 0.5;
            let clamped = position.clamp(0.0, (source_len - 1) as f64);
            let low = clamped.floor() as usize;
            let high = (low + 1).min(source_len - 1);
            (low, high, clamped - low as f64)
        })
        .collect()
}

impl<'a> GrayView<'a> {
    pub fn width(self) -> usize {
        self.width
    }
    pub fn height(self) -> usize {
        self.height
    }
    pub fn stride(self) -> usize {
        self.stride
    }
    pub fn get(self, x: usize, y: usize) -> u8 {
        self.data[y * self.stride + x]
    }
    pub fn row(self, y: usize) -> &'a [u8] {
        let start = y * self.stride;
        &self.data[start..start + self.width]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_downscale(image: &GrayImage, max_width: usize, max_height: usize) -> GrayImage {
        if image.width <= max_width && image.height <= max_height {
            return image.clone();
        }
        let scale = (image.width as f64 / max_width.max(1) as f64)
            .max(image.height as f64 / max_height.max(1) as f64);
        let out_width = ((image.width as f64 / scale).round() as usize).max(1);
        let out_height = ((image.height as f64 / scale).round() as usize).max(1);
        let mut output = GrayImage::new(out_width, out_height, 255);
        for oy in 0..out_height {
            let y0 = oy * image.height / out_height;
            let y1 = ((oy + 1) * image.height / out_height)
                .max(y0 + 1)
                .min(image.height);
            for ox in 0..out_width {
                let x0 = ox * image.width / out_width;
                let x1 = ((ox + 1) * image.width / out_width)
                    .max(x0 + 1)
                    .min(image.width);
                let mut sum = 0u64;
                let mut count = 0u64;
                for y in y0..y1 {
                    for x in x0..x1 {
                        sum += u64::from(image.get(x, y));
                        count += 1;
                    }
                }
                output.set(ox, oy, (sum / count) as u8);
            }
        }
        output
    }

    #[test]
    fn preserves_padding_and_averages_pixels() {
        let image = GrayImage::from_vec(2, 2, 3, vec![0, 10, 99, 20, 30, 99]).unwrap();
        assert_eq!(image.view().row(1), &[20, 30]);
        assert_eq!(image.downscale_to_fit(1, 1).get(0, 0), 15);
    }

    #[test]
    fn upscaling_keeps_ink_where_the_page_scale_puts_it() {
        // A bar across the middle fifth of a small page: scaling the page to
        // twice its size has to put the bar across the middle fifth of the
        // result, and interpolate its interior rather than repeat pixels.
        let mut image = GrayImage::new(20, 20, 255);
        for y in 8..12 {
            for x in 2..18 {
                image.set(x, y, 0);
            }
        }

        let scaled = image.resample_to_dimensions(40, 40);

        assert_eq!((scaled.width(), scaled.height()), (40, 40));
        let ink_rows = (0..scaled.height())
            .filter(|&y| (0..scaled.width()).any(|x| scaled.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert_eq!(*ink_rows.first().unwrap(), 16);
        assert_eq!(*ink_rows.last().unwrap(), 23);
        assert_eq!(scaled.get(20, 20), 0);
        assert_eq!(scaled.get(1, 1), 255);
        // A downscale still averages, and a mixed direction does both.
        assert_eq!(image.resample_to_dimensions(10, 10).width(), 10);
        let mixed = image.resample_to_dimensions(40, 10);
        assert_eq!((mixed.width(), mixed.height()), (40, 10));
    }

    #[test]
    fn exact_dimension_downscale_honors_independently_rounded_non_integer_ratio() {
        let image = GrayImage::new(1_000, 1_001, 127);
        let output = image.downscale_to_dimensions(667, 667);

        assert_eq!((output.width(), output.height()), (667, 667));
    }

    #[test]
    fn row_slice_downscale_is_bit_identical_to_scalar_access() {
        let mut state = 0x5036_435f_4752_4159_u64;
        for case in 0..120 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let width = 1 + state as usize % 79;
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let height = 1 + state as usize % 61;
            let stride = width + case % 7;
            let mut image = GrayImage::with_stride(width, height, stride, 231);
            for y in 0..height {
                for value in image.row_mut(y) {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1_442_695_040_888_963_407);
                    *value = state as u8;
                }
            }
            let max_width = case % 37;
            let max_height = (case * 11) % 31;
            assert_eq!(
                image.downscale_to_fit(max_width, max_height),
                reference_downscale(&image, max_width, max_height)
            );
        }
    }
}
