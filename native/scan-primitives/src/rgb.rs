/// Owned tightly packed 8-bit RGB image.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RgbImage {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

impl RgbImage {
    pub fn new(width: usize, height: usize, fill: [u8; 3]) -> Self {
        let mut data = vec![0; width.saturating_mul(height).saturating_mul(3)];
        for pixel in data.chunks_exact_mut(3) {
            pixel.copy_from_slice(&fill);
        }
        Self {
            width,
            height,
            data,
        }
    }

    pub fn from_vec(width: usize, height: usize, data: Vec<u8>) -> Option<Self> {
        (data.len() == width.checked_mul(height)?.checked_mul(3)?).then_some(Self {
            width,
            height,
            data,
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    pub fn row(&self, y: usize) -> &[u8] {
        &self.data[y * self.width * 3..(y + 1) * self.width * 3]
    }

    pub fn get(&self, x: usize, y: usize) -> [u8; 3] {
        self.data[(y * self.width + x) * 3..(y * self.width + x + 1) * 3]
            .try_into()
            .unwrap()
    }

    pub fn set(&mut self, x: usize, y: usize, value: [u8; 3]) {
        self.data[(y * self.width + x) * 3..(y * self.width + x + 1) * 3].copy_from_slice(&value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn construction_rows_and_mutation_match_the_scan_cleanup_type() {
        let mut image = RgbImage::new(2, 2, [17, 34, 51]);

        assert_eq!(image.width(), 2);
        assert_eq!(image.height(), 2);
        assert_eq!(
            image.data(),
            &[17, 34, 51, 17, 34, 51, 17, 34, 51, 17, 34, 51]
        );
        assert_eq!(image.row(1), &[17, 34, 51, 17, 34, 51]);
        assert_eq!(image.get(1, 0), [17, 34, 51]);
        image.set(1, 0, [7, 8, 9]);
        image.data_mut()[0..3].copy_from_slice(&[1, 2, 3]);
        assert_eq!(image.row(0), &[1, 2, 3, 7, 8, 9]);
    }

    #[test]
    fn from_vec_requires_an_exact_packed_rgb_buffer() {
        let pixels = vec![1, 2, 3, 4, 5, 6];

        assert_eq!(
            RgbImage::from_vec(2, 1, pixels.clone()).unwrap().data(),
            pixels
        );
        assert!(RgbImage::from_vec(2, 1, vec![1, 2, 3, 4, 5]).is_none());
        assert!(RgbImage::from_vec(usize::MAX, 2, Vec::new()).is_none());
    }
}
