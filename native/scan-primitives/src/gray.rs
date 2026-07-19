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
        let out_width = ((self.width as f64 / scale).round() as usize).max(1);
        let out_height = ((self.height as f64 / scale).round() as usize).max(1);
        let mut output = Self::new(out_width, out_height, 255);
        for oy in 0..out_height {
            let y0 = oy * self.height / out_height;
            let y1 = ((oy + 1) * self.height / out_height)
                .max(y0 + 1)
                .min(self.height);
            for ox in 0..out_width {
                let x0 = ox * self.width / out_width;
                let x1 = ((ox + 1) * self.width / out_width)
                    .max(x0 + 1)
                    .min(self.width);
                let mut sum = 0u64;
                let mut count = 0u64;
                for y in y0..y1 {
                    for x in x0..x1 {
                        sum += u64::from(self.get(x, y));
                        count += 1;
                    }
                }
                output.set(ox, oy, (sum / count) as u8);
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

    #[test]
    fn preserves_padding_and_averages_pixels() {
        let image = GrayImage::from_vec(2, 2, 3, vec![0, 10, 99, 20, 30, 99]).unwrap();
        assert_eq!(image.view().row(1), &[20, 30]);
        assert_eq!(image.downscale_to_fit(1, 1).get(0, 0), 15);
    }
}
