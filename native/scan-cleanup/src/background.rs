use scan_primitives::{morphology::reconstruct_gray, GrayImage};

pub fn normalize_illumination(source: &GrayImage, dpi: f64) -> GrayImage {
    let small = source.downscale_to_fit(300, 300);
    let radius = ((small.width().min(small.height()) as f64 * 0.025).round() as usize).clamp(2, 12);
    let inverted = invert(&small);
    let marker = gray_erode(&inverted, radius);
    let reconstructed = reconstruct_gray(&marker, &inverted);
    let candidate = invert(&reconstructed);
    let coefficients = fit_masked_surface(&small, &candidate, 8, 5);
    let mut normalized = GrayImage::new(source.width(), source.height(), 255);
    for y in 0..source.height() {
        for x in 0..source.width() {
            let nx = normalized_coordinate(x, source.width());
            let ny = normalized_coordinate(y, source.height());
            let background = evaluate_surface(&coefficients, 8, 5, nx, ny).clamp(32.0, 255.0);
            normalized.set(
                x,
                y,
                (f64::from(source.get(x, y)) * 240.0 / background)
                    .round()
                    .clamp(0.0, 255.0) as u8,
            );
        }
    }
    savitzky_golay(&normalized, dpi)
}

fn invert(image: &GrayImage) -> GrayImage {
    let mut output = image.clone();
    for value in output.data_mut() {
        *value = 255 - *value;
    }
    output
}

fn gray_erode(source: &GrayImage, radius: usize) -> GrayImage {
    let mut output = GrayImage::new(source.width(), source.height(), 0);
    for y in 0..source.height() {
        for x in 0..source.width() {
            let mut value = u8::MAX;
            for sy in y.saturating_sub(radius)..=(y + radius).min(source.height() - 1) {
                for sx in x.saturating_sub(radius)..=(x + radius).min(source.width() - 1) {
                    value = value.min(source.get(sx, sy));
                }
            }
            output.set(x, y, value);
        }
    }
    output
}

fn fit_masked_surface(
    source: &GrayImage,
    candidate: &GrayImage,
    x_terms: usize,
    y_terms: usize,
) -> Vec<f64> {
    let terms = x_terms * y_terms;
    let mut normal = vec![vec![0.0; terms + 1]; terms];
    let mut accepted = 0usize;
    for y in 0..source.height() {
        for x in 0..source.width() {
            let original = source.get(x, y);
            let background = candidate.get(x, y);
            if original.saturating_add(18) < background {
                continue;
            }
            let basis = surface_basis(
                normalized_coordinate(x, source.width()),
                normalized_coordinate(y, source.height()),
                x_terms,
                y_terms,
            );
            let weight = if x < source.width() / 30 || x + source.width() / 30 >= source.width() {
                0.4
            } else {
                1.0
            };
            for row in 0..terms {
                for column in 0..terms {
                    normal[row][column] += weight * basis[row] * basis[column];
                }
                normal[row][terms] += weight * basis[row] * f64::from(background);
            }
            accepted += 1;
        }
    }
    if accepted < terms * 2 {
        return vec![0.0; terms];
    }
    solve(normal).unwrap_or_else(|| vec![0.0; terms])
}

fn normalized_coordinate(value: usize, length: usize) -> f64 {
    if length <= 1 {
        0.0
    } else {
        2.0 * value as f64 / (length - 1) as f64 - 1.0
    }
}
fn surface_basis(x: f64, y: f64, x_terms: usize, y_terms: usize) -> Vec<f64> {
    let tx = chebyshev(x, x_terms);
    let ty = chebyshev(y, y_terms);
    let mut basis = Vec::with_capacity(x_terms * y_terms);
    for &yv in &ty {
        for &xv in &tx {
            basis.push(xv * yv);
        }
    }
    basis
}
fn chebyshev(value: f64, terms: usize) -> Vec<f64> {
    let mut result = vec![0.0; terms];
    if terms > 0 {
        result[0] = 1.0;
    }
    if terms > 1 {
        result[1] = value;
    }
    for index in 2..terms {
        result[index] = 2.0 * value * result[index - 1] - result[index - 2];
    }
    result
}
fn evaluate_surface(coefficients: &[f64], x_terms: usize, y_terms: usize, x: f64, y: f64) -> f64 {
    coefficients
        .iter()
        .zip(surface_basis(x, y, x_terms, y_terms))
        .map(|(coefficient, basis)| coefficient * basis)
        .sum()
}

fn solve(mut matrix: Vec<Vec<f64>>) -> Option<Vec<f64>> {
    let size = matrix.len();
    for pivot in 0..size {
        let best = (pivot..size)
            .max_by(|&a, &b| matrix[a][pivot].abs().total_cmp(&matrix[b][pivot].abs()))?;
        if matrix[best][pivot].abs() < 1e-9 {
            return None;
        }
        matrix.swap(pivot, best);
        let divisor = matrix[pivot][pivot];
        for column in pivot..=size {
            matrix[pivot][column] /= divisor;
        }
        for row in 0..size {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            for column in pivot..=size {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
        }
    }
    Some(matrix.into_iter().map(|row| row[size]).collect())
}

fn savitzky_golay(source: &GrayImage, dpi: f64) -> GrayImage {
    let radius = ((dpi / 150.0).round() as usize).clamp(1, 4);
    let coefficients = smoothing_coefficients(radius, 2);
    let mut horizontal = GrayImage::new(source.width(), source.height(), 255);
    for y in 0..source.height() {
        for x in 0..source.width() {
            horizontal.set(x, y, convolve(source, x, y, true, &coefficients, radius));
        }
    }
    let mut output = GrayImage::new(source.width(), source.height(), 255);
    for y in 0..source.height() {
        for x in 0..source.width() {
            output.set(
                x,
                y,
                convolve(&horizontal, x, y, false, &coefficients, radius),
            );
        }
    }
    output
}

fn smoothing_coefficients(radius: usize, degree: usize) -> Vec<f64> {
    let terms = degree + 1;
    let mut normal = vec![vec![0.0; terms + 1]; terms];
    for offset in -(radius as isize)..=radius as isize {
        let x = offset as f64;
        let powers: Vec<f64> = (0..terms).map(|power| x.powi(power as i32)).collect();
        for row in 0..terms {
            for column in 0..terms {
                normal[row][column] += powers[row] * powers[column];
            }
            normal[row][terms] += if row == 0 { 1.0 } else { 0.0 };
        }
    }
    let polynomial = solve(normal).unwrap_or_else(|| vec![1.0 / (radius * 2 + 1) as f64; terms]);
    (-(radius as isize)..=radius as isize)
        .map(|offset| {
            polynomial
                .iter()
                .enumerate()
                .map(|(power, coefficient)| coefficient * (offset as f64).powi(power as i32))
                .sum()
        })
        .collect()
}

fn convolve(
    source: &GrayImage,
    x: usize,
    y: usize,
    horizontal: bool,
    coefficients: &[f64],
    radius: usize,
) -> u8 {
    let mut sum = 0.0;
    let mut weight = 0.0;
    for (index, &coefficient) in coefficients.iter().enumerate() {
        let offset = index as isize - radius as isize;
        let sx = if horizontal {
            x.saturating_add_signed(offset).min(source.width() - 1)
        } else {
            x
        };
        let sy = if horizontal {
            y
        } else {
            y.saturating_add_signed(offset).min(source.height() - 1)
        };
        sum += coefficient * f64::from(source.get(sx, sy));
        weight += coefficient;
    }
    (sum / weight.max(1e-9)).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_flattens_a_gradient_without_erasing_ink() {
        let mut image = GrayImage::new(120, 80, 255);
        for y in 0..80 {
            for x in 0..120 {
                let background = 170 + x * 70 / 119;
                image.set(x, y, background as u8);
            }
        }
        for y in 30..35 {
            for x in 20..100 {
                image.set(x, y, 30);
            }
        }
        let normalized = normalize_illumination(&image, 300.0);
        assert!(
            i16::from(normalized.get(10, 10)).abs_diff(i16::from(normalized.get(110, 10))) < 20
        );
        assert!(normalized.get(50, 32) < 80);
    }
}
