use crate::{BinaryImage, GrayImage};
use std::collections::VecDeque;

/// Rectangular binary dilation with white outside the image.
pub fn dilate(source: &BinaryImage, radius_x: usize, radius_y: usize) -> BinaryImage {
    rectangular_binary(source, radius_x, radius_y, true)
}

/// Rectangular binary erosion with white outside the image.
pub fn erode(source: &BinaryImage, radius_x: usize, radius_y: usize) -> BinaryImage {
    rectangular_binary(source, radius_x, radius_y, false)
}

pub fn open(source: &BinaryImage, radius_x: usize, radius_y: usize) -> BinaryImage {
    dilate(&erode(source, radius_x, radius_y), radius_x, radius_y)
}

pub fn close(source: &BinaryImage, radius_x: usize, radius_y: usize) -> BinaryImage {
    erode(&dilate(source, radius_x, radius_y), radius_x, radius_y)
}

fn rectangular_binary(
    source: &BinaryImage,
    radius_x: usize,
    radius_y: usize,
    any: bool,
) -> BinaryImage {
    if source.width() == 0 || source.height() == 0 {
        return BinaryImage::new(source.width(), source.height());
    }
    let mut horizontal = BinaryImage::new(source.width(), source.height());
    for y in 0..source.height() {
        let mut left = 0usize;
        let mut right = radius_x.min(source.width() - 1);
        let mut count = (left..=right).filter(|&x| source.get(x, y)).count();
        for x in 0..source.width() {
            horizontal.set(
                x,
                y,
                if any {
                    count > 0
                } else {
                    count == radius_x.saturating_mul(2).saturating_add(1)
                },
            );
            let next_left = (x + 1).saturating_sub(radius_x);
            let next_right = (x + 1 + radius_x).min(source.width() - 1);
            while left < next_left {
                if source.get(left, y) {
                    count -= 1;
                }
                left += 1;
            }
            while right < next_right {
                right += 1;
                if source.get(right, y) {
                    count += 1;
                }
            }
        }
    }
    let mut output = BinaryImage::new(source.width(), source.height());
    for x in 0..source.width() {
        let mut top = 0usize;
        let mut bottom = radius_y.min(source.height() - 1);
        let mut count = (top..=bottom).filter(|&y| horizontal.get(x, y)).count();
        for y in 0..source.height() {
            output.set(
                x,
                y,
                if any {
                    count > 0
                } else {
                    count == radius_y.saturating_mul(2).saturating_add(1)
                },
            );
            let next_top = (y + 1).saturating_sub(radius_y);
            let next_bottom = (y + 1 + radius_y).min(source.height() - 1);
            while top < next_top {
                if horizontal.get(x, top) {
                    count -= 1;
                }
                top += 1;
            }
            while bottom < next_bottom {
                bottom += 1;
                if horizontal.get(x, bottom) {
                    count += 1;
                }
            }
        }
    }
    output
}

/// Reconstructs the marker by geodesic dilation constrained by the mask.
pub fn reconstruct_binary(marker: &BinaryImage, mask: &BinaryImage) -> BinaryImage {
    assert_eq!(
        (marker.width(), marker.height()),
        (mask.width(), mask.height())
    );
    let mut output = marker.and(mask);
    let mut queue = VecDeque::new();
    for y in 0..output.height() {
        for x in 0..output.width() {
            if output.get(x, y) {
                queue.push_back((x, y));
            }
        }
    }
    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in neighbors4(x, y, output.width(), output.height()) {
            if mask.get(nx, ny) && !output.get(nx, ny) {
                output.set(nx, ny, true);
                queue.push_back((nx, ny));
            }
        }
    }
    output
}

/// Grayscale reconstruction by dilation, where marker values may only rise up to the mask.
pub fn reconstruct_gray(marker: &GrayImage, mask: &GrayImage) -> GrayImage {
    assert_eq!(
        (marker.width(), marker.height()),
        (mask.width(), mask.height())
    );
    let mut output = marker.clone();
    for y in 0..output.height() {
        for x in 0..output.width() {
            output.set(x, y, output.get(x, y).min(mask.get(x, y)));
        }
    }
    let mut queue = VecDeque::new();
    for y in 0..output.height() {
        for x in 0..output.width() {
            queue.push_back((x, y));
        }
    }
    while let Some((x, y)) = queue.pop_front() {
        let value = output.get(x, y);
        for (nx, ny) in neighbors4(x, y, output.width(), output.height()) {
            let candidate = value.min(mask.get(nx, ny));
            if candidate > output.get(nx, ny) {
                output.set(nx, ny, candidate);
                queue.push_back((nx, ny));
            }
        }
    }
    output
}

pub(crate) fn neighbors4(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> impl Iterator<Item = (usize, usize)> {
    let mut result = [(usize::MAX, usize::MAX); 4];
    let mut count = 0;
    if x > 0 {
        result[count] = (x - 1, y);
        count += 1;
    }
    if x + 1 < width {
        result[count] = (x + 1, y);
        count += 1;
    }
    if y > 0 {
        result[count] = (x, y - 1);
        count += 1;
    }
    if y + 1 < height {
        result[count] = (x, y + 1);
        count += 1;
    }
    result.into_iter().take(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> BinaryImage {
        let mut image = BinaryImage::new(9, 7);
        for y in 2..5 {
            for x in 2..7 {
                image.set(x, y, true);
            }
        }
        image.set(4, 3, false);
        image
    }

    #[test]
    fn erosion_treats_pixels_outside_the_image_as_white() {
        let mut image = BinaryImage::new(5, 5);
        for y in 0..5 {
            for x in 0..5 {
                image.set(x, y, true);
            }
        }
        let eroded = erode(&image, 1, 1);
        assert_eq!(eroded.count_black(), 9);
        assert!(!eroded.get(0, 2));
        assert!(!eroded.get(4, 2));
        assert!(!eroded.get(2, 0));
        assert!(!eroded.get(2, 4));
        assert!(eroded.get(2, 2));
    }

    #[test]
    fn dilation_keeps_white_outside_semantics() {
        let mut image = BinaryImage::new(5, 5);
        image.set(0, 0, true);
        let dilated = dilate(&image, 1, 1);
        assert_eq!(dilated.count_black(), 4);
        assert!(dilated.get(0, 0));
        assert!(dilated.get(1, 1));
    }

    #[test]
    fn opening_and_closing_are_idempotent() {
        let image = fixture();
        let opened = open(&image, 1, 1);
        let closed = close(&image, 1, 1);
        assert_eq!(open(&opened, 1, 1), opened);
        assert_eq!(close(&closed, 1, 1), closed);
    }

    #[test]
    fn reconstruction_stays_in_mask_and_contains_marker() {
        let mask = fixture();
        let mut marker = BinaryImage::new(9, 7);
        marker.set(2, 2, true);
        let reconstructed = reconstruct_binary(&marker, &mask);
        assert_eq!(reconstructed.and(&mask), reconstructed);
        assert_eq!(reconstructed.and(&marker), marker);
        assert!(reconstructed.count_black() > marker.count_black());
    }
}
