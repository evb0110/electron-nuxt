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
        for oy in 0..out_height {
            let (y0, y1) = sample_bounds(oy, self.height, out_height);
            let output_row = output.row_mut(oy);
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
        }
        output
    }
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
