use crate::BinaryImage;

const INF: i64 = i64::MAX / 8;

/// Exact squared Euclidean distance to the nearest black pixel.
pub fn squared_euclidean_distance(image: &BinaryImage) -> Vec<u32> {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let mut vertical = vec![INF; width * height];
    for x in 0..width {
        let mut last = None;
        for y in 0..height {
            if image.get(x, y) {
                last = Some(y);
                vertical[y * width + x] = 0;
            } else if let Some(seed) = last {
                let d = y - seed;
                vertical[y * width + x] = (d * d) as i64;
            }
        }
        last = None;
        for y in (0..height).rev() {
            if image.get(x, y) {
                last = Some(y);
            } else if let Some(seed) = last {
                let d = seed - y;
                vertical[y * width + x] = vertical[y * width + x].min((d * d) as i64);
            }
        }
    }
    let mut output = vec![u32::MAX; width * height];
    for y in 0..height {
        let row = &vertical[y * width..(y + 1) * width];
        let transformed = transform_1d(row);
        for x in 0..width {
            output[y * width + x] = transformed[x].min(u32::MAX as i64) as u32;
        }
    }
    output
}

fn transform_1d(values: &[i64]) -> Vec<i64> {
    let seeds: Vec<usize> = values
        .iter()
        .enumerate()
        .filter_map(|(index, &value)| (value < INF).then_some(index))
        .collect();
    if seeds.is_empty() {
        return vec![INF; values.len()];
    }
    let mut envelope = vec![0usize; seeds.len()];
    let mut boundaries = vec![f64::NEG_INFINITY; seeds.len() + 1];
    let mut top = 0usize;
    envelope[0] = seeds[0];
    boundaries[1] = f64::INFINITY;
    for &seed in &seeds[1..] {
        let mut intersection;
        loop {
            let previous = envelope[top];
            intersection = ((values[seed] + (seed * seed) as i64)
                - (values[previous] + (previous * previous) as i64))
                as f64
                / (2.0 * (seed as f64 - previous as f64));
            if intersection > boundaries[top] || top == 0 {
                break;
            }
            top -= 1;
        }
        top += 1;
        envelope[top] = seed;
        boundaries[top] = intersection;
        boundaries[top + 1] = f64::INFINITY;
    }
    let mut output = vec![0; values.len()];
    let mut candidate = 0usize;
    for (x, target) in output.iter_mut().enumerate() {
        while boundaries[candidate + 1] < x as f64 {
            candidate += 1;
        }
        let seed = envelope[candidate];
        let d = x.abs_diff(seed) as i64;
        *target = d * d + values[seed];
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_brute_force_for_deterministic_small_patterns() {
        for salt in 0..13 {
            let mut image = BinaryImage::new(9, 7);
            for y in 0usize..7 {
                for x in 0usize..9 {
                    image.set(x, y, (x * 17 + y * 11 + salt) % 19 == 0);
                }
            }
            image.set(salt % 9, salt % 7, true);
            let actual = squared_euclidean_distance(&image);
            for y in 0usize..7 {
                for x in 0usize..9 {
                    let expected = (0..7)
                        .flat_map(|sy| (0..9).map(move |sx| (sx, sy)))
                        .filter(|&(sx, sy)| image.get(sx, sy))
                        .map(|(sx, sy)| {
                            let dx = x.abs_diff(sx);
                            let dy = y.abs_diff(sy);
                            (dx * dx + dy * dy) as u32
                        })
                        .min()
                        .unwrap();
                    assert_eq!(actual[y * 9 + x], expected);
                }
            }
        }
    }
}
