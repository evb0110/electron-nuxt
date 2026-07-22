use crate::png::RgbImage;
use rayon::prelude::*;
use scan_primitives::{morphology::reconstruct_gray, GrayImage};

const X_TERMS: usize = 8;
const Y_TERMS: usize = 5;
const SURFACE_TERMS: usize = X_TERMS * Y_TERMS;

#[derive(Clone, Debug)]
enum BackgroundModel {
    Surface(Vec<f64>),
    Reconstruction { image: GrayImage, floor: f64 },
}

#[derive(Clone, Copy, Debug)]
struct SurfaceDiagnostics {
    accepted_samples: usize,
    median_absolute_residual: f64,
    p90_absolute_residual: f64,
    minimum: f64,
    maximum: f64,
}

#[derive(Clone, Debug)]
struct SurfaceFit {
    coefficients: Vec<f64>,
    diagnostics: SurfaceDiagnostics,
}

pub fn normalize_illumination(source: &GrayImage, _dpi: f64) -> GrayImage {
    let model = background_model(source);
    normalize_with_model(source, &model)
}

pub fn normalize_illumination_rgb(luminance: &GrayImage, source: &RgbImage, _dpi: f64) -> RgbImage {
    let model = background_model(luminance);
    normalize_rgb_with_model(source, &model)
}

fn background_model(source: &GrayImage) -> BackgroundModel {
    let (small, candidate) = reconstructed_background(source);
    match fit_masked_surface(&small, &candidate) {
        Some(fit) => {
            debug_assert!(validate_surface(fit.diagnostics));
            BackgroundModel::Surface(fit.coefficients)
        }
        None => reconstruction_fallback(candidate),
    }
}

/// Stage-B split calibration is intentionally held against the pre-Stage-F
/// surface solve. Final rendering uses the validated Cholesky model above.
pub(crate) fn normalize_illumination_for_layout(source: &GrayImage) -> GrayImage {
    let (small, candidate) = reconstructed_background(source);
    let model = fit_masked_surface_legacy(&small, &candidate)
        .map(BackgroundModel::Surface)
        .unwrap_or_else(|| reconstruction_fallback(candidate));
    normalize_with_model(source, &model)
}

fn reconstructed_background(source: &GrayImage) -> (GrayImage, GrayImage) {
    let small = source.downscale_to_fit(300, 300);
    let radius = ((small.width().min(small.height()) as f64 * 0.025).round() as usize).clamp(2, 12);
    let inverted = invert(&small);
    let marker = gray_erode(&inverted, radius);
    let reconstructed = reconstruct_gray(&marker, &inverted);
    let candidate = invert(&reconstructed);
    (small, candidate)
}

fn reconstruction_fallback(candidate: GrayImage) -> BackgroundModel {
    let floor = robust_image_percentile(&candidate, 0.5) * 0.5;
    BackgroundModel::Reconstruction {
        image: candidate,
        floor,
    }
}

fn normalize_with_model(source: &GrayImage, model: &BackgroundModel) -> GrayImage {
    let mut normalized = GrayImage::new(source.width(), source.height(), 255);
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    normalized
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, output_row)| {
            let mut row_coefficients = [0.0; X_TERMS];
            if let BackgroundModel::Surface(coefficients) = &model {
                for y_term in 0..Y_TERMS {
                    for x_term in 0..X_TERMS {
                        row_coefficients[x_term] +=
                            coefficients[y_term * X_TERMS + x_term] * y_basis[y][y_term];
                    }
                }
            }
            for (x, target) in output_row.iter_mut().enumerate() {
                let background = match &model {
                    BackgroundModel::Surface(_) => row_coefficients
                        .iter()
                        .zip(&x_basis[x])
                        .map(|(coefficient, basis)| coefficient * basis)
                        .sum::<f64>(),
                    BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
                        image,
                        source_coordinate(x, source.width(), image.width()),
                        source_coordinate(y, source.height(), image.height()),
                    )
                    .max(*floor),
                }
                .clamp(32.0, 255.0);
                *target = (f64::from(source.get(x, y)) * 240.0 / background)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        });
    normalized
}

fn normalize_rgb_with_model(source: &RgbImage, model: &BackgroundModel) -> RgbImage {
    let mut normalized = RgbImage::new(source.width(), source.height(), [255; 3]);
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    normalized
        .data_mut()
        .par_chunks_mut(source.width() * 3)
        .enumerate()
        .for_each(|(y, output_row)| {
            let mut row_coefficients = [0.0; X_TERMS];
            if let BackgroundModel::Surface(coefficients) = model {
                for y_term in 0..Y_TERMS {
                    for x_term in 0..X_TERMS {
                        row_coefficients[x_term] +=
                            coefficients[y_term * X_TERMS + x_term] * y_basis[y][y_term];
                    }
                }
            }
            for (x, target) in output_row.chunks_exact_mut(3).enumerate() {
                let background = match model {
                    BackgroundModel::Surface(_) => row_coefficients
                        .iter()
                        .zip(&x_basis[x])
                        .map(|(coefficient, basis)| coefficient * basis)
                        .sum::<f64>(),
                    BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
                        image,
                        source_coordinate(x, source.width(), image.width()),
                        source_coordinate(y, source.height(), image.height()),
                    )
                    .max(*floor),
                }
                .clamp(32.0, 255.0);
                let factor = 240.0 / background;
                let source_pixel = source.get(x, y);
                for channel in 0..3 {
                    target[channel] = (f64::from(source_pixel[channel]) * factor)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        });
    normalized
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

fn fit_masked_surface(source: &GrayImage, candidate: &GrayImage) -> Option<SurfaceFit> {
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    let mut accepted = 0usize;
    let (normal, rhs) =
        accumulate_surface_system(source, candidate, &x_basis, &y_basis, &mut accepted);
    if accepted < SURFACE_TERMS * 2 {
        return None;
    }
    let coefficients = cholesky_solve_regularized(normal, rhs)?;
    let mut residuals = surface_residuals(source, candidate, &x_basis, &y_basis, &coefficients);
    let median_absolute_residual = percentile(&mut residuals, 0.5);
    let p90_absolute_residual = percentile(&mut residuals, 0.9);
    let (minimum, maximum) = surface_range(&x_basis, &y_basis, &coefficients);
    let diagnostics = SurfaceDiagnostics {
        accepted_samples: accepted,
        median_absolute_residual,
        p90_absolute_residual,
        minimum,
        maximum,
    };
    validate_surface(diagnostics).then_some(SurfaceFit {
        coefficients,
        diagnostics,
    })
}

fn fit_masked_surface_legacy(source: &GrayImage, candidate: &GrayImage) -> Option<Vec<f64>> {
    let mut normal = vec![vec![0.0; SURFACE_TERMS + 1]; SURFACE_TERMS];
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    let mut basis = [0.0; SURFACE_TERMS];
    let mut accepted = 0usize;
    for (y, y_values) in y_basis.iter().enumerate() {
        for (x, x_values) in x_basis.iter().enumerate() {
            let original = source.get(x, y);
            let background = candidate.get(x, y);
            if original.saturating_add(18) < background {
                continue;
            }
            fill_surface_basis(&mut basis, x_values, y_values);
            let border_x = source.width() / 30;
            let weight = if x < border_x || x + border_x >= source.width() {
                0.4
            } else {
                1.0
            };
            for row in 0..SURFACE_TERMS {
                for column in 0..SURFACE_TERMS {
                    normal[row][column] += weight * basis[row] * basis[column];
                }
                normal[row][SURFACE_TERMS] += weight * basis[row] * f64::from(background);
            }
            accepted += 1;
        }
    }
    (accepted >= SURFACE_TERMS * 2)
        .then(|| solve(normal))
        .flatten()
}

fn accumulate_surface_system(
    source: &GrayImage,
    candidate: &GrayImage,
    x_basis: &[[f64; X_TERMS]],
    y_basis: &[[f64; Y_TERMS]],
    accepted: &mut usize,
) -> (Vec<Vec<f64>>, Vec<f64>) {
    let mut normal = vec![vec![0.0; SURFACE_TERMS]; SURFACE_TERMS];
    let mut rhs = vec![0.0; SURFACE_TERMS];
    let mut basis = [0.0; SURFACE_TERMS];
    for (y, y_values) in y_basis.iter().enumerate() {
        for (x, x_values) in x_basis.iter().enumerate() {
            let original = source.get(x, y);
            let background = candidate.get(x, y);
            if original.saturating_add(18) < background {
                continue;
            }
            fill_surface_basis(&mut basis, x_values, y_values);
            let border_x = source.width() / 30;
            let weight = if x < border_x || x + border_x >= source.width() {
                0.4
            } else {
                1.0
            };
            for row in 0..SURFACE_TERMS {
                for column in 0..=row {
                    normal[row][column] += weight * basis[row] * basis[column];
                }
                rhs[row] += weight * basis[row] * f64::from(background);
            }
            *accepted += 1;
        }
    }
    for row in 0..SURFACE_TERMS {
        for column in 0..row {
            normal[column][row] = normal[row][column];
        }
    }
    (normal, rhs)
}

fn fill_surface_basis(
    basis: &mut [f64; SURFACE_TERMS],
    x_values: &[f64; X_TERMS],
    y_values: &[f64; Y_TERMS],
) {
    for y_term in 0..Y_TERMS {
        for x_term in 0..X_TERMS {
            basis[y_term * X_TERMS + x_term] = x_values[x_term] * y_values[y_term];
        }
    }
}

fn evaluate_surface(coefficients: &[f64], basis: &[f64; SURFACE_TERMS]) -> f64 {
    coefficients
        .iter()
        .zip(basis)
        .map(|(coefficient, value)| coefficient * value)
        .sum()
}

fn surface_residuals(
    source: &GrayImage,
    candidate: &GrayImage,
    x_basis: &[[f64; X_TERMS]],
    y_basis: &[[f64; Y_TERMS]],
    coefficients: &[f64],
) -> Vec<f64> {
    let mut residuals = Vec::new();
    let mut basis = [0.0; SURFACE_TERMS];
    for (y, y_values) in y_basis.iter().enumerate() {
        for (x, x_values) in x_basis.iter().enumerate() {
            let original = source.get(x, y);
            let background = candidate.get(x, y);
            if original.saturating_add(18) < background {
                continue;
            }
            fill_surface_basis(&mut basis, x_values, y_values);
            residuals.push((evaluate_surface(coefficients, &basis) - f64::from(background)).abs());
        }
    }
    residuals
}

fn surface_range(
    x_basis: &[[f64; X_TERMS]],
    y_basis: &[[f64; Y_TERMS]],
    coefficients: &[f64],
) -> (f64, f64) {
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    let mut basis = [0.0; SURFACE_TERMS];
    for y_values in y_basis {
        for x_values in x_basis {
            fill_surface_basis(&mut basis, x_values, y_values);
            let value = evaluate_surface(coefficients, &basis);
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
    }
    (minimum, maximum)
}

fn validate_surface(diagnostics: SurfaceDiagnostics) -> bool {
    diagnostics.accepted_samples >= SURFACE_TERMS * 2
        && diagnostics.median_absolute_residual.is_finite()
        && diagnostics.p90_absolute_residual.is_finite()
        && diagnostics.minimum.is_finite()
        && diagnostics.maximum.is_finite()
        && diagnostics.p90_absolute_residual <= 32.0
        && diagnostics.minimum >= 1.0
        && diagnostics.maximum <= 320.0
        && diagnostics.maximum - diagnostics.minimum <= 255.0
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return f64::INFINITY;
    }
    values.sort_unstable_by(f64::total_cmp);
    let position = (values.len() - 1) as f64 * fraction;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        values[lower]
    } else {
        values[lower] * (upper as f64 - position) + values[upper] * (position - lower as f64)
    }
}

fn robust_image_percentile(image: &GrayImage, fraction: f64) -> f64 {
    let mut histogram = [0usize; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let target =
        ((image.width() * image.height()).saturating_sub(1) as f64 * fraction).round() as usize;
    let mut cumulative = 0usize;
    for (value, count) in histogram.into_iter().enumerate() {
        cumulative += count;
        if cumulative > target {
            return value as f64;
        }
    }
    255.0
}

fn cholesky_solve_regularized(mut matrix: Vec<Vec<f64>>, rhs: Vec<f64>) -> Option<Vec<f64>> {
    let size = matrix.len();
    let trace = matrix
        .iter()
        .enumerate()
        .map(|(index, row)| row[index])
        .sum::<f64>();
    let regularization = 1e-4 * trace / size.max(1) as f64;
    for (index, row) in matrix.iter_mut().enumerate() {
        row[index] += regularization;
    }
    let mut lower = vec![vec![0.0; size]; size];
    for row in 0..size {
        for column in 0..=row {
            let previous = (0..column)
                .map(|index| lower[row][index] * lower[column][index])
                .sum::<f64>();
            if row == column {
                let diagonal = matrix[row][row] - previous;
                if !diagonal.is_finite() || diagonal <= 1e-12 {
                    return None;
                }
                lower[row][column] = diagonal.sqrt();
            } else {
                lower[row][column] = (matrix[row][column] - previous) / lower[column][column];
            }
        }
    }
    let mut intermediate = vec![0.0; size];
    for row in 0..size {
        let previous = (0..row)
            .map(|column| lower[row][column] * intermediate[column])
            .sum::<f64>();
        intermediate[row] = (rhs[row] - previous) / lower[row][row];
    }
    let mut solution = vec![0.0; size];
    for row in (0..size).rev() {
        let previous = (row + 1..size)
            .map(|column| lower[column][row] * solution[column])
            .sum::<f64>();
        solution[row] = (intermediate[row] - previous) / lower[row][row];
    }
    solution
        .iter()
        .all(|value| value.is_finite())
        .then_some(solution)
}

fn source_coordinate(value: usize, source_length: usize, target_length: usize) -> f64 {
    if source_length <= 1 || target_length <= 1 {
        0.0
    } else {
        value as f64 * (target_length - 1) as f64 / (source_length - 1) as f64
    }
}

fn sample_bilinear(image: &GrayImage, x: f64, y: f64) -> f64 {
    let x0 = x.floor().clamp(0.0, image.width().saturating_sub(1) as f64) as usize;
    let y0 = y
        .floor()
        .clamp(0.0, image.height().saturating_sub(1) as f64) as usize;
    let x1 = (x0 + 1).min(image.width().saturating_sub(1));
    let y1 = (y0 + 1).min(image.height().saturating_sub(1));
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let top = f64::from(image.get(x0, y0)) * (1.0 - fx) + f64::from(image.get(x1, y0)) * fx;
    let bottom = f64::from(image.get(x0, y1)) * (1.0 - fx) + f64::from(image.get(x1, y1)) * fx;
    top * (1.0 - fy) + bottom * fy
}

fn normalized_coordinate(value: usize, length: usize) -> f64 {
    if length <= 1 {
        0.0
    } else {
        2.0 * value as f64 / (length - 1) as f64 - 1.0
    }
}
fn chebyshev_basis<const TERMS: usize>(value: f64) -> [f64; TERMS] {
    let mut result = [0.0; TERMS];
    if TERMS > 0 {
        result[0] = 1.0;
    }
    if TERMS > 1 {
        result[1] = value;
    }
    for index in 2..TERMS {
        result[index] = 2.0 * value * result[index - 1] - result[index - 2];
    }
    result
}

fn precompute_chebyshev<const TERMS: usize>(length: usize) -> Vec<[f64; TERMS]> {
    (0..length)
        .map(|value| chebyshev_basis(normalized_coordinate(value, length)))
        .collect()
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

pub(crate) fn smooth_for_binarization(source: &GrayImage, dpi: f64) -> GrayImage {
    let radius = ((dpi / 150.0).round() as usize).clamp(1, 4);
    let coefficients = smoothing_coefficients(radius, 2);
    if coefficients.iter().enumerate().all(|(index, &value)| {
        let expected = f64::from(index == radius);
        (value - expected).abs() < 1e-12
    }) {
        return source.clone();
    }
    let mut horizontal = GrayImage::new(source.width(), source.height(), 255);
    horizontal
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                *target = convolve(source, x, y, true, &coefficients, radius);
            }
        });
    let mut output = GrayImage::new(source.width(), source.height(), 255);
    output
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                *target = convolve(&horizontal, x, y, false, &coefficients, radius);
            }
        });
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

    #[test]
    fn surface_fit_reports_bounded_residuals_and_sparse_input_uses_fallback() {
        let mut source = GrayImage::new(120, 80, 230);
        let mut candidate = GrayImage::new(120, 80, 230);
        for y in 0..80 {
            for x in 0..120 {
                let value = 175 + (55 * x / 119) + (8 * y / 79);
                source.set(x, y, value as u8);
                candidate.set(x, y, value as u8);
            }
        }
        let fit = fit_masked_surface(&source, &candidate).expect("smooth surface must fit");
        assert_eq!(fit.diagnostics.accepted_samples, 120 * 80);
        assert!(fit.diagnostics.median_absolute_residual < 0.75);
        assert!(fit.diagnostics.p90_absolute_residual < 1.5);

        let sparse = GrayImage::new(8, 8, 220);
        assert!(fit_masked_surface(&sparse, &sparse).is_none());
        let normalized = normalize_illumination(&sparse, 300.0);
        assert!(normalized.data().iter().all(|value| *value >= 230));
    }

    #[test]
    fn ridge_keeps_a_quadrant_only_surface_system_bounded() {
        let mut source = GrayImage::new(120, 80, 0);
        let candidate = GrayImage::new(120, 80, 220);
        for y in 0..40 {
            for x in 0..60 {
                source.set(x, y, 220);
            }
        }
        let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
        let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
        let mut accepted = 0;
        let (normal, rhs) =
            accumulate_surface_system(&source, &candidate, &x_basis, &y_basis, &mut accepted);
        let coefficients = cholesky_solve_regularized(normal, rhs)
            .expect("ridge must solve a quadrant-only sample distribution");
        let (minimum, maximum) = surface_range(&x_basis, &y_basis, &coefficients);

        assert_eq!(accepted, 60 * 40);
        assert!(minimum.is_finite() && maximum.is_finite());
        assert!(minimum >= -64.0, "minimum={minimum}");
        assert!(maximum <= 320.0, "maximum={maximum}");
    }

    #[test]
    fn color_normalization_matches_real_gutter_fixture_golden() {
        let decoded = crate::png::decode_image(
            include_bytes!("../tests/fixtures/split/spread-luther-soft-gutter-p00001.png"),
            crate::DEFAULT_MAX_PIXELS,
            crate::DEFAULT_MAX_DIMENSION,
        )
        .unwrap();
        let normalized = normalize_illumination_rgb(&decoded.gray, &decoded.rgb, 300.0);
        let mut checksum = crc32fast::Hasher::new();
        for y in 0..normalized.height() {
            checksum.update(normalized.row(y));
        }

        assert_eq!(checksum.finalize(), 2_346_348_409);
    }

    #[test]
    fn savgol_is_an_explicit_bw_only_step() {
        let mut source = GrayImage::new(31, 31, 220);
        for y in 8..23 {
            source.set(15, y, if y % 2 == 0 { 15 } else { 75 });
        }
        let normalized = normalize_illumination(&source, 300.0);
        let threshold_input = smooth_for_binarization(&normalized, 300.0);
        assert_ne!(normalized, threshold_input);
        assert!(normalized.get(15, 14).abs_diff(normalized.get(15, 15)) > 20);
    }

    fn reference_surface(
        coefficients: &[f64],
        x_terms: usize,
        y_terms: usize,
        x: f64,
        y: f64,
    ) -> f64 {
        assert_eq!((x_terms, y_terms), (8, 5));
        let tx = chebyshev_basis::<8>(x);
        let ty = chebyshev_basis::<5>(y);
        let mut index = 0;
        let mut sum = 0.0;
        for y_value in ty {
            for &x_value in &tx {
                sum += coefficients[index] * x_value * y_value;
                index += 1;
            }
        }
        sum
    }

    #[test]
    fn separable_chebyshev_evaluation_matches_reference_tensor_basis() {
        let coefficients = (0..40)
            .map(|index| ((index * 37 % 19) as f64 - 9.0) / 7.0)
            .collect::<Vec<_>>();
        let x_basis = precompute_chebyshev::<8>(113);
        let y_basis = precompute_chebyshev::<5>(79);
        for (y, y_values) in y_basis.iter().enumerate() {
            let mut row_coefficients = [0.0; 8];
            for y_term in 0..5 {
                for x_term in 0..8 {
                    row_coefficients[x_term] +=
                        coefficients[y_term * 8 + x_term] * y_values[y_term];
                }
            }
            for (x, x_values) in x_basis.iter().enumerate() {
                let actual = row_coefficients
                    .iter()
                    .zip(x_values)
                    .map(|(coefficient, basis)| coefficient * basis)
                    .sum::<f64>();
                let expected = reference_surface(
                    &coefficients,
                    8,
                    5,
                    normalized_coordinate(x, 113),
                    normalized_coordinate(y, 79),
                );
                assert!((actual - expected).abs() <= 1e-12);
            }
        }
    }
}
