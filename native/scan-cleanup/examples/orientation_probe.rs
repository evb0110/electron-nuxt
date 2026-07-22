//! Experimental page-orientation probe.
//!
//! This example is intentionally disconnected from the production protocol and
//! cleanup pipeline. It measures scoring on the already prepared analysis
//! raster; PNG decode, pyramid construction, layout normalization, and optional
//! synthetic rotation are excluded from `elapsed_ms`.

use evb_scan_cleanup::{
    background::normalize_illumination, engine::prepare::build_analysis_level, png::read_gray,
    DEFAULT_MAX_DIMENSION, DEFAULT_MAX_PIXELS,
};
use scan_primitives::{threshold::otsu_threshold, GrayImage};
use serde::Serialize;
use std::{env, path::PathBuf, process, time::Instant};

#[derive(Clone, Copy, Debug)]
struct ProbeOptions {
    dpi: f64,
    synthetic_rotations: bool,
}

#[derive(Clone, Copy, Debug)]
struct ProjectionEvidence {
    score: f64,
    period: usize,
}

#[derive(Clone, Copy, Debug)]
struct OrientationEvidence {
    orientation: u16,
    confidence: f64,
    axis_confidence: f64,
    direction_confidence: f64,
    horizontal_score: f64,
    vertical_score: f64,
    polarity_score: f64,
    line_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRecord<'a> {
    page: &'a str,
    orientation: u16,
    confidence: f64,
    elapsed_ms: f64,
    axis_confidence: f64,
    direction_confidence: f64,
    horizontal_score: f64,
    vertical_score: f64,
    polarity_score: f64,
    line_count: usize,
    analysis_width: usize,
    analysis_height: usize,
    analysis_dpi: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    synthetic_rotation: Option<u16>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("orientation_probe: {error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let (options, paths) = parse_args()?;
    for path in paths {
        let source = read_gray(&path, DEFAULT_MAX_PIXELS, DEFAULT_MAX_DIMENSION)?;
        let level = build_analysis_level(&source, options.dpi, 150.0);
        let normalized = normalize_illumination(&level.image, level.effective_dpi);
        let rotations: &[u16] = if options.synthetic_rotations {
            &[0, 90, 180, 270]
        } else {
            &[0]
        };
        for &rotation in rotations {
            let raster = rotate_clockwise(&normalized, rotation);
            let started = Instant::now();
            let evidence = detect_orientation(&raster);
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            let page = path.to_string_lossy();
            let record = ProbeRecord {
                page: &page,
                orientation: evidence.orientation,
                confidence: evidence.confidence,
                elapsed_ms,
                axis_confidence: evidence.axis_confidence,
                direction_confidence: evidence.direction_confidence,
                horizontal_score: evidence.horizontal_score,
                vertical_score: evidence.vertical_score,
                polarity_score: evidence.polarity_score,
                line_count: evidence.line_count,
                analysis_width: raster.width(),
                analysis_height: raster.height(),
                analysis_dpi: level.effective_dpi,
                synthetic_rotation: options.synthetic_rotations.then_some(rotation),
            };
            println!(
                "{}",
                serde_json::to_string(&record).map_err(|error| error.to_string())?
            );
        }
    }
    Ok(())
}

fn parse_args() -> Result<(ProbeOptions, Vec<PathBuf>), String> {
    let mut dpi = 150.0;
    let mut synthetic_rotations = false;
    let mut paths = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--dpi" => {
                dpi = args
                    .next()
                    .ok_or("--dpi requires a value")?
                    .parse::<f64>()
                    .map_err(|_| "--dpi must be numeric")?;
                if !dpi.is_finite() || dpi <= 0.0 {
                    return Err("--dpi must be positive and finite".into());
                }
            }
            "--synthetic-rotations" => synthetic_rotations = true,
            "--help" | "-h" => {
                eprintln!(
                    "usage: cargo run --release --example orientation_probe -- \
                     [--dpi 150] [--synthetic-rotations] PAGE.png ..."
                );
                process::exit(0);
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown option: {value}"));
            }
            value => paths.push(PathBuf::from(value)),
        }
    }
    if paths.is_empty() {
        return Err("at least one rendered page PNG is required (use --help for usage)".into());
    }
    Ok((
        ProbeOptions {
            dpi,
            synthetic_rotations,
        },
        paths,
    ))
}

fn detect_orientation(image: &GrayImage) -> OrientationEvidence {
    let threshold = otsu_threshold(image).clamp(48, 232);
    let (rows, columns) = ink_projections(image, threshold);
    let horizontal = projection_evidence(&rows);
    let vertical = projection_evidence(&columns);
    let horizontal_axis = horizontal.score >= vertical.score;
    let (profile, period) = if horizontal_axis {
        (&rows, horizontal.period)
    } else {
        (&columns, vertical.period)
    };
    let (forward_polarity, forward_lines, forward_quality) = line_polarity(profile, period);
    let reversed_profile: Vec<f64> = profile.iter().rev().copied().collect();
    let (reverse_polarity, reverse_lines, reverse_quality) =
        line_polarity(&reversed_profile, period);
    // The antisymmetric form removes peak-plateau tie bias and guarantees that
    // a 180-degree reversal negates, rather than merely perturbs, the signal.
    let polarity_score = (forward_polarity - reverse_polarity) * 0.5;
    let line_count = forward_lines.min(reverse_lines);
    let direction_quality = (forward_quality + reverse_quality) * 0.5;
    let orientation = if horizontal_axis {
        if polarity_score >= 0.0 {
            0
        } else {
            180
        }
    } else if polarity_score >= 0.0 {
        270
    } else {
        90
    };
    let total_axis_score = horizontal.score + vertical.score + f64::EPSILON;
    let axis_margin = (horizontal.score - vertical.score).abs() / total_axis_score;
    let axis_confidence = (axis_margin * 2.2).clamp(0.0, 1.0);
    let direction_confidence = (polarity_score.abs() * 8.0)
        .min(direction_quality * 3.0)
        .clamp(0.0, 1.0);
    let line_support = (line_count as f64 / 12.0).clamp(0.15, 1.0);
    let confidence = (axis_confidence * direction_confidence).sqrt() * line_support.sqrt();
    OrientationEvidence {
        orientation,
        confidence: confidence.clamp(0.0, 1.0),
        axis_confidence,
        direction_confidence,
        horizontal_score: horizontal.score,
        vertical_score: vertical.score,
        polarity_score,
        line_count,
    }
}

fn ink_projections(image: &GrayImage, threshold: u8) -> (Vec<f64>, Vec<f64>) {
    let mut rows = vec![0.0; image.height()];
    let mut columns = vec![0.0; image.width()];
    let x_margin = image.width() / 25;
    let y_margin = image.height() / 25;
    let x_start = x_margin.min(image.width());
    let x_end = image.width().saturating_sub(x_margin).max(x_start);
    let y_start = y_margin.min(image.height());
    let y_end = image.height().saturating_sub(y_margin).max(y_start);
    let threshold = f64::from(threshold);
    let softness = 24.0;
    for (y, row_sum) in rows.iter_mut().enumerate().take(y_end).skip(y_start) {
        for (x, column_sum) in columns.iter_mut().enumerate().take(x_end).skip(x_start) {
            let value = f64::from(image.get(x, y));
            let ink = ((threshold + softness - value) / softness).clamp(0.0, 1.0);
            *row_sum += ink;
            *column_sum += ink;
        }
    }
    let row_scale = (x_end.saturating_sub(x_start)).max(1) as f64;
    let column_scale = (y_end.saturating_sub(y_start)).max(1) as f64;
    for value in &mut rows[y_start..y_end] {
        *value /= row_scale;
    }
    for value in &mut columns[x_start..x_end] {
        *value /= column_scale;
    }
    (rows, columns)
}

fn projection_evidence(profile: &[f64]) -> ProjectionEvidence {
    if profile.len() < 24 {
        return ProjectionEvidence {
            score: 0.0,
            period: 8,
        };
    }
    // A few full-height rules, page borders, or gutter edges can otherwise
    // dominate a column profile. Text lines occupy many bins, so winsorizing
    // only the upper tail suppresses rules while retaining line periodicity.
    let cap = percentile(profile, 0.92);
    let clipped: Vec<f64> = profile.iter().map(|value| value.min(cap)).collect();
    let small = moving_average(&clipped, 1);
    let broad_radius = (profile.len() / 90).clamp(5, 24);
    let broad = moving_average(&small, broad_radius);
    let residual: Vec<f64> = small
        .iter()
        .zip(&broad)
        .map(|(value, background)| value - background)
        .collect();
    let start = profile.len() / 25;
    let end = profile.len().saturating_sub(start);
    let body = &residual[start..end.max(start)];
    let residual_energy = mean_square(body).sqrt();
    let mean_ink = clipped[start..end.max(start)].iter().sum::<f64>() / body.len().max(1) as f64;
    let min_lag = 6usize;
    let max_lag = (profile.len() / 12).clamp(min_lag + 1, 80);
    let mut best_correlation = 0.0_f64;
    let mut best_period = min_lag;
    let energy = body.iter().map(|value| value * value).sum::<f64>();
    if energy > f64::EPSILON {
        for lag in min_lag..=max_lag.min(body.len().saturating_sub(1)) {
            let numerator = body[..body.len() - lag]
                .iter()
                .zip(&body[lag..])
                .map(|(left, right)| left * right)
                .sum::<f64>();
            let correlation = numerator / energy;
            if correlation > best_correlation {
                best_correlation = correlation;
                best_period = lag;
            }
        }
    }
    let periodicity = best_correlation.max(0.0).sqrt();
    let normalized_energy = residual_energy / (mean_ink + 0.0025);
    ProjectionEvidence {
        score: normalized_energy * (0.55 + 0.45 * periodicity),
        period: best_period,
    }
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len().saturating_sub(1)) as f64 * quantile)
        .round()
        .clamp(0.0, sorted.len().saturating_sub(1) as f64) as usize;
    sorted.get(index).copied().unwrap_or(0.0)
}

fn line_polarity(profile: &[f64], estimated_period: usize) -> (f64, usize, f64) {
    if profile.len() < 24 {
        return (0.0, 0, 0.0);
    }
    let smooth = moving_average(profile, 1);
    let background = moving_average(&smooth, estimated_period.clamp(6, 60));
    let residual: Vec<f64> = smooth
        .iter()
        .zip(&background)
        .map(|(value, local)| (value - local).max(0.0))
        .collect();
    let mean = residual.iter().sum::<f64>() / residual.len() as f64;
    let deviation = residual
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (residual.len().max(1) as f64).sqrt();
    let peak_floor = mean + deviation * 0.35;
    let half_window = (estimated_period * 2 / 5).clamp(3, 24);
    let min_separation = (estimated_period * 3 / 5).clamp(4, 36);
    let mut candidates: Vec<(usize, f64)> = (half_window..residual.len() - half_window)
        .filter(|&index| {
            residual[index] >= peak_floor
                && residual[index] >= residual[index - 1]
                && residual[index] > residual[index + 1]
        })
        .map(|index| (index, residual[index]))
        .collect();
    candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
    let mut peaks = Vec::new();
    for (index, strength) in candidates {
        if peaks
            .iter()
            .all(|&(selected, _): &(usize, f64)| selected.abs_diff(index) >= min_separation)
        {
            peaks.push((index, strength));
        }
    }
    peaks.sort_by_key(|&(index, _)| index);
    let mut weighted_scores = Vec::new();
    for (peak, strength) in peaks {
        let mut before = 0.0;
        let mut after = 0.0;
        for distance in 1..=half_window {
            let weight = 1.0 - (distance - 1) as f64 / half_window as f64 * 0.45;
            before += residual[peak - distance] * weight;
            after += residual[peak + distance] * weight;
        }
        let mass = before + after;
        if mass > mean * half_window as f64 * 0.8 {
            let score = (before - after) / (mass + f64::EPSILON);
            weighted_scores.push((score, strength * mass));
        }
    }
    if weighted_scores.is_empty() {
        return (0.0, 0, 0.0);
    }
    weighted_scores.sort_by(|left, right| left.0.total_cmp(&right.0));
    let trim = weighted_scores.len() / 8;
    let retained = &weighted_scores[trim..weighted_scores.len() - trim];
    let total_weight = retained.iter().map(|(_, weight)| weight).sum::<f64>();
    let score = retained
        .iter()
        .map(|(score, weight)| score * weight)
        .sum::<f64>()
        / (total_weight + f64::EPSILON);
    let quality = retained
        .iter()
        .map(|(line, weight)| line.abs() * weight)
        .sum::<f64>()
        / (total_weight + f64::EPSILON);
    (score, retained.len(), quality)
}

fn moving_average(values: &[f64], radius: usize) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(values.len() + 1);
    prefix.push(0.0);
    for &value in values {
        prefix.push(prefix.last().copied().unwrap_or(0.0) + value);
    }
    (0..values.len())
        .map(|index| {
            let start = index.saturating_sub(radius);
            let end = (index + radius + 1).min(values.len());
            (prefix[end] - prefix[start]) / (end - start).max(1) as f64
        })
        .collect()
}

fn mean_square(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum::<f64>() / values.len().max(1) as f64
}

fn rotate_clockwise(source: &GrayImage, degrees: u16) -> GrayImage {
    match degrees {
        0 => source.clone(),
        90 => {
            let mut output = GrayImage::new(source.height(), source.width(), 255);
            for y in 0..source.height() {
                for x in 0..source.width() {
                    output.set(source.height() - 1 - y, x, source.get(x, y));
                }
            }
            output
        }
        180 => {
            let mut output = GrayImage::new(source.width(), source.height(), 255);
            for y in 0..source.height() {
                for x in 0..source.width() {
                    output.set(
                        source.width() - 1 - x,
                        source.height() - 1 - y,
                        source.get(x, y),
                    );
                }
            }
            output
        }
        270 => {
            let mut output = GrayImage::new(source.height(), source.width(), 255);
            for y in 0..source.height() {
                for x in 0..source.width() {
                    output.set(y, source.width() - 1 - x, source.get(x, y));
                }
            }
            output
        }
        _ => unreachable!("synthetic rotations are orthogonal"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_page() -> GrayImage {
        let mut image = GrayImage::new(500, 700, 245);
        for line in 0..22 {
            let baseline = 45 + line * 27;
            for word in 0..7 {
                let left = 35 + word * 61 + (line % 3) * 2;
                let width = 38 + word % 3 * 5;
                for x in left..left + width {
                    for y in baseline - 9..=baseline {
                        image.set(x, y, 20);
                    }
                }
                for x in left + 5..left + 9 {
                    for y in baseline - 16..baseline - 9 {
                        image.set(x, y, 20);
                    }
                }
                if word % 3 == 0 {
                    for x in left + width - 7..left + width - 4 {
                        for y in baseline + 1..baseline + 4 {
                            image.set(x, y, 20);
                        }
                    }
                }
            }
        }
        image
    }

    #[test]
    fn detects_all_synthetic_orthogonal_orientations() {
        let upright = text_page();
        for expected in [0, 90, 180, 270] {
            let evidence = detect_orientation(&rotate_clockwise(&upright, expected));
            assert_eq!(evidence.orientation, expected);
            assert!(evidence.axis_confidence > 0.5);
        }
    }
}
