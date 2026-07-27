use crate::{BinaryImage, GrayImage};
use rayon::prelude::*;
use std::collections::VecDeque;

/// Rectangular grayscale erosion (the local maximum) with black outside.
///
/// This follows the dark-foreground convention used by scan cleanup: erosion
/// shrinks dark structures, while dilation expands them.
pub fn erode_gray(source: &GrayImage, radius_x: usize, radius_y: usize) -> GrayImage {
    rectangular_gray(source, radius_x, radius_y, true)
}

/// Rectangular grayscale dilation (the local minimum) with white outside.
pub fn dilate_gray(source: &GrayImage, radius_x: usize, radius_y: usize) -> GrayImage {
    rectangular_gray(source, radius_x, radius_y, false)
}

fn rectangular_gray(
    source: &GrayImage,
    radius_x: usize,
    radius_y: usize,
    maximum: bool,
) -> GrayImage {
    if source.width() == 0 || source.height() == 0 {
        return source.clone();
    }
    if source.width().saturating_mul(source.height()) >= 65_536 {
        let horizontal = sliding_gray_rows(source, radius_x, maximum);
        let transposed = transpose_gray(&horizontal);
        return transpose_gray(&sliding_gray_rows(&transposed, radius_y, maximum));
    }
    let mut horizontal = GrayImage::new(
        source.width(),
        source.height(),
        if maximum { 0 } else { 255 },
    );
    for y in 0..source.height() {
        sliding_gray_line(
            source.width(),
            radius_x,
            maximum,
            |x| source.get(x, y),
            |x, value| horizontal.set(x, y, value),
        );
    }
    let mut output = GrayImage::new(
        source.width(),
        source.height(),
        if maximum { 0 } else { 255 },
    );
    for x in 0..source.width() {
        sliding_gray_line(
            source.height(),
            radius_y,
            maximum,
            |y| horizontal.get(x, y),
            |y, value| output.set(x, y, value),
        );
    }
    output
}

fn sliding_gray_rows(source: &GrayImage, radius: usize, maximum: bool) -> GrayImage {
    let mut output = GrayImage::new(
        source.width(),
        source.height(),
        if maximum { 0 } else { 255 },
    );
    output
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, output_row)| {
            let source_row = source.row(y);
            sliding_gray_line(
                source.width(),
                radius,
                maximum,
                |x| source_row[x],
                |x, value| output_row[x] = value,
            );
        });
    output
}

fn transpose_gray(source: &GrayImage) -> GrayImage {
    let mut output = GrayImage::new(source.height(), source.width(), 0);
    output
        .data_mut()
        .par_chunks_mut(source.height())
        .enumerate()
        .for_each(|(source_x, output_row)| {
            for (source_y, target) in output_row.iter_mut().enumerate() {
                *target = source.data()[source_y * source.width() + source_x];
            }
        });
    output
}

fn sliding_gray_line(
    length: usize,
    radius: usize,
    maximum: bool,
    mut sample: impl FnMut(usize) -> u8,
    mut write: impl FnMut(usize, u8),
) {
    let mut deque = VecDeque::<(usize, u8)>::new();
    let mut next = 0usize;
    for position in 0..length {
        let last = position.saturating_add(radius).min(length - 1);
        while next <= last {
            let value = sample(next);
            while deque.back().is_some_and(|&(_, queued)| {
                if maximum {
                    queued <= value
                } else {
                    queued >= value
                }
            }) {
                deque.pop_back();
            }
            deque.push_back((next, value));
            next += 1;
        }
        let first = position.saturating_sub(radius);
        while deque.front().is_some_and(|&(index, _)| index < first) {
            deque.pop_front();
        }
        write(
            position,
            deque.front().expect("grayscale window is nonempty").1,
        );
    }
}

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
    let word_parallel = source.width().saturating_mul(source.height()) >= 65_536
        || (radius_x >= 20 && radius_y <= 5)
        || (radius_y >= 20 && radius_x <= 5);
    if word_parallel {
        return rectangular_binary_words(source, radius_x, radius_y, any);
    }
    rectangular_binary_scalar(source, radius_x, radius_y, any)
}

fn rectangular_binary_words(
    source: &BinaryImage,
    radius_x: usize,
    radius_y: usize,
    any: bool,
) -> BinaryImage {
    if source.width() == 0 || source.height() == 0 {
        return BinaryImage::new(source.width(), source.height());
    }
    let words_per_line = source.words_per_line();
    let mut horizontal = BinaryImage::new(source.width(), source.height());
    horizontal
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for (word_index, target) in output_row.iter_mut().enumerate() {
                let mut combined = if any { 0 } else { u32::MAX };
                for offset in -(radius_x as isize)..=radius_x as isize {
                    let shifted = shifted_row_word(source, y, word_index, offset);
                    if any {
                        combined |= shifted;
                    } else {
                        combined &= shifted;
                    }
                }
                *target = combined;
            }
        });
    horizontal.clear_padding();

    let mut output = BinaryImage::new(source.width(), source.height());
    output
        .words_mut()
        .par_chunks_mut(words_per_line)
        .enumerate()
        .for_each(|(y, output_row)| {
            for (word_index, target) in output_row.iter_mut().enumerate() {
                let mut combined = if any { 0 } else { u32::MAX };
                for offset in -(radius_y as isize)..=radius_y as isize {
                    let source_y = y as isize + offset;
                    let word = if source_y < 0 || source_y >= source.height() as isize {
                        0
                    } else {
                        horizontal.words()[source_y as usize * words_per_line + word_index]
                    };
                    if any {
                        combined |= word;
                    } else {
                        combined &= word;
                    }
                }
                *target = combined;
            }
        });
    output.clear_padding();
    output
}

/// Returns a destination-aligned word whose bit at x comes from source x+offset.
fn shifted_row_word(source: &BinaryImage, y: usize, output_word: usize, offset: isize) -> u32 {
    let words_per_line = source.words_per_line();
    let source_bit = output_word as isize * 32 + offset;
    let source_word = source_bit.div_euclid(32);
    let bit_offset = source_bit.rem_euclid(32) as u32;
    let read = |word: isize| {
        if word < 0 || word >= words_per_line as isize {
            0
        } else {
            source.words()[y * words_per_line + word as usize]
        }
    };
    if bit_offset == 0 {
        read(source_word)
    } else {
        (read(source_word) << bit_offset) | (read(source_word + 1) >> (32 - bit_offset))
    }
}

fn rectangular_binary_scalar(
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
    let mut queued = vec![false; output.width().saturating_mul(output.height())];
    for y in 0..output.height() {
        for x in 0..output.width() {
            if output.get(x, y)
                && neighbors4(x, y, output.width(), output.height())
                    .any(|(nx, ny)| mask.get(nx, ny) && !output.get(nx, ny))
            {
                queued[y * output.width() + x] = true;
                queue.push_back((x, y));
            }
        }
    }
    while let Some((x, y)) = queue.pop_front() {
        queued[y * output.width() + x] = false;
        for (nx, ny) in neighbors4(x, y, output.width(), output.height()) {
            if mask.get(nx, ny) && !output.get(nx, ny) {
                output.set(nx, ny, true);
                let index = ny * output.width() + nx;
                if !queued[index] {
                    queued[index] = true;
                    queue.push_back((nx, ny));
                }
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
    if output.width() == 0 || output.height() == 0 {
        return output;
    }

    // Vincent's raster and anti-raster passes propagate values along the two
    // causal half-neighborhoods before the FIFO handles the remaining fronts.
    for y in 0..output.height() {
        for x in 0..output.width() {
            let mut value = output.get(x, y);
            if x > 0 {
                value = value.max(output.get(x - 1, y));
            }
            if y > 0 {
                value = value.max(output.get(x, y - 1));
            }
            output.set(x, y, value.min(mask.get(x, y)));
        }
    }
    for y in (0..output.height()).rev() {
        for x in (0..output.width()).rev() {
            let mut value = output.get(x, y);
            if x + 1 < output.width() {
                value = value.max(output.get(x + 1, y));
            }
            if y + 1 < output.height() {
                value = value.max(output.get(x, y + 1));
            }
            output.set(x, y, value.min(mask.get(x, y)));
        }
    }

    let mut queue = VecDeque::new();
    let mut queued = vec![false; output.width() * output.height()];
    for y in 0..output.height() {
        for x in 0..output.width() {
            let value = output.get(x, y);
            if neighbors4(x, y, output.width(), output.height())
                .any(|(nx, ny)| value.min(mask.get(nx, ny)) > output.get(nx, ny))
            {
                let index = y * output.width() + x;
                queued[index] = true;
                queue.push_back(index);
            }
        }
    }
    while let Some(index) = queue.pop_front() {
        queued[index] = false;
        let x = index % output.width();
        let y = index / output.width();
        let value = output.get(x, y);
        for (nx, ny) in neighbors4(x, y, output.width(), output.height()) {
            let candidate = value.min(mask.get(nx, ny));
            if candidate > output.get(nx, ny) {
                output.set(nx, ny, candidate);
                let neighbor_index = ny * output.width() + nx;
                if !queued[neighbor_index] {
                    queued[neighbor_index] = true;
                    queue.push_back(neighbor_index);
                }
            }
        }
    }
    output
}

/// Grayscale reconstruction by erosion, where marker values may only fall to
/// the mask. Implementing the dual through the dilation reconstruction keeps
/// both operations bit-exact and shares the established queue propagation.
pub fn reconstruct_gray_by_erosion(marker: &GrayImage, mask: &GrayImage) -> GrayImage {
    assert_eq!(
        (marker.width(), marker.height()),
        (mask.width(), mask.height())
    );
    let inverted_marker = invert_gray(marker);
    let inverted_mask = invert_gray(mask);
    invert_gray(&reconstruct_gray(&inverted_marker, &inverted_mask))
}

/// Fills grayscale minima that are not connected to the image frame.
pub fn fill_gray_holes(source: &GrayImage) -> GrayImage {
    if source.width() == 0 || source.height() == 0 {
        return source.clone();
    }
    let mut marker = GrayImage::new(source.width(), source.height(), 255);
    for x in 0..source.width() {
        marker.set(x, 0, 0);
        marker.set(x, source.height() - 1, 0);
    }
    for y in 0..source.height() {
        marker.set(0, y, 0);
        marker.set(source.width() - 1, y, 0);
    }
    reconstruct_gray_by_erosion(&marker, source)
}

fn invert_gray(source: &GrayImage) -> GrayImage {
    let mut output = source.clone();
    for y in 0..source.height() {
        for (target, &value) in output.row_mut(y).iter_mut().zip(source.row(y)) {
            *target = 255 - value;
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

    fn next_random(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *state
    }

    fn reference_rectangular_gray(
        source: &GrayImage,
        radius_x: usize,
        radius_y: usize,
        maximum: bool,
    ) -> GrayImage {
        let mut output = GrayImage::new(
            source.width(),
            source.height(),
            if maximum { 0 } else { 255 },
        );
        for y in 0..source.height() {
            for x in 0..source.width() {
                let mut value = if maximum { 0 } else { 255 };
                for sample_y in y.saturating_sub(radius_y)..=(y + radius_y).min(source.height() - 1)
                {
                    for sample_x in
                        x.saturating_sub(radius_x)..=(x + radius_x).min(source.width() - 1)
                    {
                        value = if maximum {
                            value.max(source.get(sample_x, sample_y))
                        } else {
                            value.min(source.get(sample_x, sample_y))
                        };
                    }
                }
                output.set(x, y, value);
            }
        }
        output
    }

    fn reference_reconstruct_binary(marker: &BinaryImage, mask: &BinaryImage) -> BinaryImage {
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

    fn reference_reconstruct_gray(marker: &GrayImage, mask: &GrayImage) -> GrayImage {
        let mut output = marker.clone();
        for y in 0..output.height() {
            for x in 0..output.width() {
                output.set(x, y, output.get(x, y).min(mask.get(x, y)));
            }
        }
        let mut buckets = (0..256).map(|_| Vec::<usize>::new()).collect::<Vec<_>>();
        for y in 0..output.height() {
            for x in 0..output.width() {
                let value = output.get(x, y);
                if value != 0 {
                    buckets[value as usize].push(y * output.width() + x);
                }
            }
        }
        let mut finalized = vec![false; output.width() * output.height()];
        for level in (1..=255usize).rev() {
            while let Some(index) = buckets[level].pop() {
                if finalized[index] {
                    continue;
                }
                let x = index % output.width();
                let y = index / output.width();
                if output.get(x, y) as usize != level {
                    continue;
                }
                finalized[index] = true;
                for (nx, ny) in neighbors4(x, y, output.width(), output.height()) {
                    let neighbor_index = ny * output.width() + nx;
                    if finalized[neighbor_index] {
                        continue;
                    }
                    let candidate = (level as u8).min(mask.get(nx, ny));
                    if candidate > output.get(nx, ny) {
                        output.set(nx, ny, candidate);
                        buckets[candidate as usize].push(neighbor_index);
                    }
                }
            }
        }
        output
    }

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

    #[test]
    fn boundary_seeded_binary_reconstruction_matches_all_marker_queue() {
        let mut state = 0x5034_425f_5245_434f;
        for _ in 0..160 {
            let width = next_random(&mut state) as usize % 31;
            let height = next_random(&mut state) as usize % 23;
            let mut marker = BinaryImage::new(width, height);
            let mut mask = BinaryImage::new(width, height);
            for y in 0..height {
                for x in 0..width {
                    marker.set(x, y, next_random(&mut state) >> 62 == 0);
                    mask.set(x, y, next_random(&mut state) >> 61 != 0);
                }
            }
            assert_eq!(
                reconstruct_binary(&marker, &mask),
                reference_reconstruct_binary(&marker, &mask)
            );
        }
    }

    #[test]
    fn word_parallel_large_bricks_are_bit_exact_to_scalar_morphology() {
        let mut state = 0x91e1_0da5_u64;
        let mut image = BinaryImage::new(103, 97);
        for y in 0..image.height() {
            for x in 0..image.width() {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                image.set(x, y, state >> 61 == 0);
            }
        }
        for (radius_x, radius_y) in [(40, 2), (2, 40), (75, 5), (5, 75)] {
            for any in [false, true] {
                assert_eq!(
                    rectangular_binary_words(&image, radius_x, radius_y, any),
                    rectangular_binary_scalar(&image, radius_x, radius_y, any),
                    "radius=({radius_x},{radius_y}) any={any}"
                );
            }
        }
    }

    #[test]
    fn grayscale_morphology_uses_dark_foreground_convention() {
        let mut image = GrayImage::new(5, 5, 200);
        image.set(2, 2, 20);
        let dilated = dilate_gray(&image, 1, 1);
        let eroded = erode_gray(&image, 1, 1);
        assert_eq!(dilated.get(1, 1), 20);
        assert_eq!(dilated.get(3, 3), 20);
        assert_eq!(eroded.get(2, 2), 200);
    }

    #[test]
    fn parallel_grayscale_morphology_is_bit_exact() {
        let mut state = 0x5047_5241_595f_4d4f;
        let mut image = GrayImage::new(257, 257, 0);
        for value in image.data_mut() {
            *value = next_random(&mut state) as u8;
        }
        for (radius_x, radius_y) in [(0, 0), (1, 3), (9, 9)] {
            for maximum in [false, true] {
                assert_eq!(
                    rectangular_gray(&image, radius_x, radius_y, maximum),
                    reference_rectangular_gray(&image, radius_x, radius_y, maximum),
                    "radius=({radius_x},{radius_y}) maximum={maximum}"
                );
            }
        }
    }

    #[test]
    fn grayscale_hole_fill_preserves_frame_connected_minima() {
        let mut image = GrayImage::new(7, 7, 180);
        image.set(3, 3, 20);
        image.set(0, 3, 30);
        image.set(1, 3, 30);
        let filled = fill_gray_holes(&image);
        assert_eq!(filled.get(3, 3), 180);
        assert_eq!(filled.get(0, 3), 30);
        assert_eq!(filled.get(1, 3), 30);
    }

    #[test]
    fn grayscale_reconstruction_matches_naive_fixed_point() {
        let mut marker = GrayImage::new(19, 13, 0);
        let mut mask = GrayImage::new(19, 13, 0);
        let mut state = 0x917c_4ad3_u64;
        for y in 0..mask.height() {
            for x in 0..mask.width() {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let ceiling = (state >> 32) as u8;
                mask.set(x, y, ceiling);
                marker.set(x, y, ceiling.saturating_sub((state >> 24) as u8));
            }
        }
        let mut expected = marker.clone();
        for y in 0..expected.height() {
            for x in 0..expected.width() {
                expected.set(x, y, expected.get(x, y).min(mask.get(x, y)));
            }
        }
        loop {
            let before = expected.clone();
            for y in 0..expected.height() {
                for x in 0..expected.width() {
                    let value = neighbors4(x, y, expected.width(), expected.height())
                        .fold(expected.get(x, y), |value, (nx, ny)| {
                            value.max(expected.get(nx, ny))
                        })
                        .min(mask.get(x, y));
                    expected.set(x, y, value);
                }
            }
            if expected == before {
                break;
            }
        }
        assert_eq!(reconstruct_gray(&marker, &mask), expected);
    }

    #[test]
    fn vincent_gray_reconstruction_matches_hierarchical_queue() {
        let mut state = 0x5034_475f_5245_434f;
        for _ in 0..160 {
            let width = next_random(&mut state) as usize % 29;
            let height = next_random(&mut state) as usize % 21;
            let mut marker = GrayImage::new(width, height, 0);
            let mut mask = GrayImage::new(width, height, 0);
            for y in 0..height {
                for x in 0..width {
                    marker.set(x, y, next_random(&mut state) as u8);
                    mask.set(x, y, next_random(&mut state) as u8);
                }
            }
            assert_eq!(
                reconstruct_gray(&marker, &mask),
                reference_reconstruct_gray(&marker, &mask)
            );
        }
    }
}
