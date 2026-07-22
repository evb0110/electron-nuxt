use crate::{png::RgbImage, DewarpOptions};
use scan_primitives::{GrayImage, Point, Projective};
use thiserror::Error;

pub const DEWARP_GRID_SIZE: usize = 17;
const MIN_CURVE_SEPARATION: f64 = 0.05;
const MIN_ENDPOINT_CROSS_RATIO: f64 = 0.01;
const MAX_JACOBIAN_RATIO: f64 = 20.0;

#[derive(Clone, Debug, Error, PartialEq)]
pub enum DewarpModelError {
    #[error("dewarp-model-insufficient-points: each directrix requires at least two points")]
    InsufficientPoints,
    #[error("dewarp-model-invalid-depth: depth must be finite and between -0.9 and 4.0")]
    InvalidDepth,
    #[error("dewarp-model-endpoint-order: endpoint quadrilateral must be convex TL/TR/BR/BL with consistent orientation")]
    EndpointOrder,
    #[error("dewarp-model-degenerate-endpoints: endpoint quadrilateral is degenerate")]
    DegenerateEndpoints,
    #[error("dewarp-model-noninvertible-homography: endpoint homography is not invertible")]
    NoninvertibleHomography,
    #[error("dewarp-model-invalid-point: {directrix} directrix contains a point that cannot be normalized")]
    InvalidPoint { directrix: &'static str },
    #[error("dewarp-model-zero-length: {directrix} directrix has zero length")]
    ZeroLength { directrix: &'static str },
    #[error("dewarp-model-nonmonotonic-x: {directrix} directrix does not progress monotonically in normalized x")]
    NonMonotonicX { directrix: &'static str },
    #[error(
        "dewarp-model-curve-separation: directrices cross or fall below 5% vertical separation"
    )]
    CurveSeparation,
    #[error("dewarp-model-nonpositive-jacobian: mapping folds or reverses orientation on the 17x17 validity grid")]
    NonPositiveJacobian,
    #[error("dewarp-model-excessive-magnification: Jacobian magnitude ratio exceeds 20x on the 17x17 validity grid")]
    ExcessiveMagnification,
}

#[derive(Clone, Debug)]
pub struct DewarpModel {
    homography: Projective,
    inverse_homography: Projective,
    top: ArcPolyline,
    bottom: ArcPolyline,
    depth: f64,
}

#[derive(Clone, Debug)]
struct ArcPolyline {
    points: Vec<Point>,
    cumulative: Vec<f64>,
    length: f64,
}

impl DewarpModel {
    pub fn from_options(options: &DewarpOptions) -> Result<Self, DewarpModelError> {
        if options.top_curve.len() < 2 || options.bottom_curve.len() < 2 {
            return Err(DewarpModelError::InsufficientPoints);
        }
        if !options.depth.is_finite() || !(-0.9..=4.0).contains(&options.depth) {
            return Err(DewarpModelError::InvalidDepth);
        }
        let corners = [
            options.top_curve[0],
            *options.top_curve.last().unwrap(),
            *options.bottom_curve.last().unwrap(),
            options.bottom_curve[0],
        ];
        validate_endpoint_order(corners)?;
        let unit = [
            Point::new(0.0, 0.0),
            Point::new(1.0, 0.0),
            Point::new(1.0, 1.0),
            Point::new(0.0, 1.0),
        ];
        let homography =
            homography_from_four(corners, unit).ok_or(DewarpModelError::DegenerateEndpoints)?;
        let inverse_homography = homography
            .inverse()
            .ok_or(DewarpModelError::NoninvertibleHomography)?;
        let top_points = options
            .top_curve
            .iter()
            .map(|&point| {
                homography
                    .apply(point)
                    .ok_or(DewarpModelError::InvalidPoint { directrix: "top" })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let bottom_points = options
            .bottom_curve
            .iter()
            .map(|&point| {
                homography
                    .apply(point)
                    .ok_or(DewarpModelError::InvalidPoint {
                        directrix: "bottom",
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_monotonic_x(&top_points, "top")?;
        validate_monotonic_x(&bottom_points, "bottom")?;
        validate_curve_separation(&top_points, &bottom_points)?;
        let model = Self {
            homography,
            inverse_homography,
            top: ArcPolyline::new(top_points, "top")?,
            bottom: ArcPolyline::new(bottom_points, "bottom")?,
            depth: options.depth,
        };
        model.validate_jacobian()?;
        Ok(model)
    }

    pub fn map_unit_to_source(&self, u: f64, v: f64) -> Option<Point> {
        let top = self.top.sample(u.clamp(0.0, 1.0));
        let bottom = self.bottom.sample(u.clamp(0.0, 1.0));
        let denominator = 1.0 + self.depth * (1.0 - v);
        if denominator.abs() < 1e-9 {
            return None;
        }
        let projected_v = (v / denominator).clamp(0.0, 1.0);
        let normalized = Point::new(
            top.x + (bottom.x - top.x) * projected_v,
            top.y + (bottom.y - top.y) * projected_v,
        );
        self.inverse_homography.apply(normalized)
    }

    pub fn map_source_to_unit_approx(&self, source: Point) -> Option<Point> {
        let normalized = self.homography.apply(source)?;
        let mut best = Point::new(0.0, 0.0);
        let mut best_distance = f64::INFINITY;
        for step in 0..=256 {
            let u = step as f64 / 256.0;
            let top = self.top.sample(u);
            let bottom = self.bottom.sample(u);
            let dx = bottom.x - top.x;
            let dy = bottom.y - top.y;
            let length2 = dx * dx + dy * dy;
            if length2 <= 1e-12 {
                continue;
            }
            let projected = ((normalized.x - top.x) * dx + (normalized.y - top.y) * dy) / length2;
            let point = Point::new(top.x + dx * projected, top.y + dy * projected);
            let distance = (point.x - normalized.x).powi(2) + (point.y - normalized.y).powi(2);
            if distance < best_distance {
                let p = projected.clamp(0.0, 1.0);
                let v = p * (1.0 + self.depth) / (1.0 + p * self.depth);
                best = Point::new(u, v);
                best_distance = distance;
            }
        }
        Some(best)
    }

    /// Counts non-positive or non-finite samples on the same 17x17 Jacobian
    /// grid used by C2 model validation. Validated models necessarily return
    /// zero; the harness keeps this explicit counter as a catastrophic-warp
    /// regression metric.
    pub fn sampled_jacobian_failures(&self) -> usize {
        let mut failures = 0;
        for row in 0..DEWARP_GRID_SIZE {
            for column in 0..DEWARP_GRID_SIZE {
                let u = column as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let v = row as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                if numerical_jacobian(self, u, v)
                    .is_none_or(|value| !value.is_finite() || value <= 1e-12)
                {
                    failures += 1;
                }
            }
        }
        failures
    }

    fn validate_jacobian(&self) -> Result<(), DewarpModelError> {
        let mut minimum = f64::INFINITY;
        let mut maximum: f64 = 0.0;
        for row in 0..DEWARP_GRID_SIZE {
            for column in 0..DEWARP_GRID_SIZE {
                let u = column as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let v = row as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let determinant = numerical_jacobian(self, u, v)
                    .filter(|value| value.is_finite() && *value > 1e-12)
                    .ok_or(DewarpModelError::NonPositiveJacobian)?;
                minimum = minimum.min(determinant);
                maximum = maximum.max(determinant);
            }
        }
        if maximum / minimum > MAX_JACOBIAN_RATIO {
            return Err(DewarpModelError::ExcessiveMagnification);
        }
        Ok(())
    }
}

impl ArcPolyline {
    fn new(points: Vec<Point>, directrix: &'static str) -> Result<Self, DewarpModelError> {
        let mut cumulative = vec![0.0];
        for pair in points.windows(2) {
            let length = ((pair[1].x - pair[0].x).powi(2) + (pair[1].y - pair[0].y).powi(2)).sqrt();
            cumulative.push(cumulative.last().copied().unwrap() + length);
        }
        let length = *cumulative.last().unwrap();
        if length <= 1e-9 {
            return Err(DewarpModelError::ZeroLength { directrix });
        }
        Ok(Self {
            points,
            cumulative,
            length,
        })
    }
    fn sample(&self, position: f64) -> Point {
        let target = position * self.length;
        let segment = self
            .cumulative
            .partition_point(|&distance| distance < target)
            .clamp(1, self.points.len() - 1)
            - 1;
        let start = self.cumulative[segment];
        let end = self.cumulative[segment + 1];
        let amount = if end > start {
            (target - start) / (end - start)
        } else {
            0.0
        };
        Point::new(
            self.points[segment].x + (self.points[segment + 1].x - self.points[segment].x) * amount,
            self.points[segment].y + (self.points[segment + 1].y - self.points[segment].y) * amount,
        )
    }
}

fn validate_endpoint_order(corners: [Point; 4]) -> Result<(), DewarpModelError> {
    let crosses = std::array::from_fn::<_, 4, _>(|index| {
        let a = corners[index];
        let b = corners[(index + 1) % corners.len()];
        let c = corners[(index + 2) % corners.len()];
        (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    });
    let minimum = crosses
        .iter()
        .map(|value| value.abs())
        .fold(f64::INFINITY, f64::min);
    let maximum = crosses.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if crosses
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || maximum <= 1e-12
        || minimum / maximum < MIN_ENDPOINT_CROSS_RATIO
    {
        return Err(DewarpModelError::EndpointOrder);
    }
    Ok(())
}

fn validate_monotonic_x(points: &[Point], directrix: &'static str) -> Result<(), DewarpModelError> {
    if points.windows(2).any(|pair| pair[1].x - pair[0].x <= 1e-9) {
        return Err(DewarpModelError::NonMonotonicX { directrix });
    }
    Ok(())
}

fn validate_curve_separation(top: &[Point], bottom: &[Point]) -> Result<(), DewarpModelError> {
    // Both curves are piecewise linear and monotonic in x, so their vertical
    // separation is linear between the union of their x breakpoints. Checking
    // every breakpoint proves the minimum over the full width, rather than
    // relying on a sampling interval that could miss a narrow crossing.
    let mut breakpoints = top
        .iter()
        .chain(bottom)
        .map(|point| point.x.clamp(0.0, 1.0))
        .collect::<Vec<_>>();
    breakpoints.push(0.0);
    breakpoints.push(1.0);
    breakpoints.sort_by(f64::total_cmp);
    breakpoints.dedup_by(|left, right| (*left - *right).abs() <= 1e-12);
    for x in breakpoints {
        let top_y = sample_polyline_at_x(top, x).ok_or(DewarpModelError::CurveSeparation)?;
        let bottom_y = sample_polyline_at_x(bottom, x).ok_or(DewarpModelError::CurveSeparation)?;
        if bottom_y - top_y < MIN_CURVE_SEPARATION {
            return Err(DewarpModelError::CurveSeparation);
        }
    }
    Ok(())
}

fn sample_polyline_at_x(points: &[Point], x: f64) -> Option<f64> {
    let first = *points.first()?;
    let last = *points.last()?;
    if x <= first.x {
        return Some(first.y);
    }
    if x >= last.x {
        return Some(last.y);
    }
    let pair = points.windows(2).find(|pair| pair[1].x >= x)?;
    let amount = (x - pair[0].x) / (pair[1].x - pair[0].x);
    Some(pair[0].y + (pair[1].y - pair[0].y) * amount)
}

fn numerical_jacobian(model: &DewarpModel, u: f64, v: f64) -> Option<f64> {
    const STEP: f64 = 1.0 / 4096.0;
    let u0 = (u - STEP).max(0.0);
    let u1 = (u + STEP).min(1.0);
    let v0 = (v - STEP).max(0.0);
    let v1 = (v + STEP).min(1.0);
    let left = model.map_unit_to_source(u0, v)?;
    let right = model.map_unit_to_source(u1, v)?;
    let top = model.map_unit_to_source(u, v0)?;
    let bottom = model.map_unit_to_source(u, v1)?;
    let du = u1 - u0;
    let dv = v1 - v0;
    if du <= 0.0 || dv <= 0.0 {
        return None;
    }
    let dx_du = (right.x - left.x) / du;
    let dy_du = (right.y - left.y) / du;
    let dx_dv = (bottom.x - top.x) / dv;
    let dy_dv = (bottom.y - top.y) / dv;
    Some(dx_du * dy_dv - dy_du * dx_dv)
}

pub fn rasterize_inverse_area(
    source: &GrayImage,
    model: &DewarpModel,
    width: usize,
    height: usize,
) -> GrayImage {
    rasterize_inverse_area_with(source, width, height, |point| {
        model.map_unit_to_source(point.x / width as f64, point.y / height as f64)
    })
}

pub fn rasterize_inverse_area_with<F>(
    source: &GrayImage,
    width: usize,
    height: usize,
    output_to_source: F,
) -> GrayImage
where
    F: Fn(Point) -> Option<Point>,
{
    let mut output = GrayImage::new(width, height, 255);
    for y in 0..height {
        for x in 0..width {
            let Some(quad) = mapped_quad_with(&output_to_source, x, y) else {
                continue;
            };
            output.set(x, y, integrate_quad(source, &quad));
        }
    }
    output
}

pub fn rasterize_inverse_area_rgb(
    source: &RgbImage,
    model: &DewarpModel,
    width: usize,
    height: usize,
) -> RgbImage {
    rasterize_inverse_area_rgb_with(source, width, height, |point| {
        model.map_unit_to_source(point.x / width as f64, point.y / height as f64)
    })
}

pub fn rasterize_inverse_area_rgb_with<F>(
    source: &RgbImage,
    width: usize,
    height: usize,
    output_to_source: F,
) -> RgbImage
where
    F: Fn(Point) -> Option<Point>,
{
    let mut output = RgbImage::new(width, height, [255; 3]);
    for y in 0..height {
        for x in 0..width {
            let Some(quad) = mapped_quad_with(&output_to_source, x, y) else {
                continue;
            };
            output.set(x, y, integrate_quad_rgb(source, &quad));
        }
    }
    output
}

fn mapped_quad_with<F>(output_to_source: &F, x: usize, y: usize) -> Option<[Point; 4]>
where
    F: Fn(Point) -> Option<Point>,
{
    Some([
        output_to_source(Point::new(x as f64, y as f64))?,
        output_to_source(Point::new((x + 1) as f64, y as f64))?,
        output_to_source(Point::new((x + 1) as f64, (y + 1) as f64))?,
        output_to_source(Point::new(x as f64, (y + 1) as f64))?,
    ])
}

fn integrate_quad(source: &GrayImage, quad: &[Point; 4]) -> u8 {
    let min_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(source.width() as f64) as usize;
    let min_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(source.height() as f64) as usize;
    let mut weighted = 0.0;
    let mut area = 0.0;
    for sy in min_y..max_y {
        for sx in min_x..max_x {
            let clipped = clip_to_rect(
                quad.to_vec(),
                sx as f64,
                sy as f64,
                (sx + 1) as f64,
                (sy + 1) as f64,
            );
            let coverage = polygon_area(&clipped);
            if coverage > 1e-12 {
                weighted += coverage * f64::from(source.get(sx, sy));
                area += coverage;
            }
        }
    }
    if area > 1e-12 {
        (weighted / area).round().clamp(0.0, 255.0) as u8
    } else {
        255
    }
}

fn integrate_quad_rgb(source: &RgbImage, quad: &[Point; 4]) -> [u8; 3] {
    let min_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(source.width() as f64) as usize;
    let min_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(source.height() as f64) as usize;
    let mut weighted = [0.0; 3];
    let mut area = 0.0;
    for sy in min_y..max_y {
        for sx in min_x..max_x {
            let clipped = clip_to_rect(
                quad.to_vec(),
                sx as f64,
                sy as f64,
                (sx + 1) as f64,
                (sy + 1) as f64,
            );
            let coverage = polygon_area(&clipped);
            if coverage > 1e-12 {
                let pixel = source.get(sx, sy);
                for channel in 0..3 {
                    weighted[channel] += coverage * f64::from(pixel[channel]);
                }
                area += coverage;
            }
        }
    }
    if area > 1e-12 {
        weighted.map(|value| (value / area).round().clamp(0.0, 255.0) as u8)
    } else {
        [255; 3]
    }
}

fn clip_to_rect(
    mut polygon: Vec<Point>,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Vec<Point> {
    for (axis, bound, keep_greater) in [
        (0, left, true),
        (0, right, false),
        (1, top, true),
        (1, bottom, false),
    ] {
        let input = std::mem::take(&mut polygon);
        if input.is_empty() {
            break;
        }
        for index in 0..input.len() {
            let current = input[index];
            let previous = input[(index + input.len() - 1) % input.len()];
            let current_value = if axis == 0 { current.x } else { current.y };
            let previous_value = if axis == 0 { previous.x } else { previous.y };
            let current_inside = if keep_greater {
                current_value >= bound
            } else {
                current_value <= bound
            };
            let previous_inside = if keep_greater {
                previous_value >= bound
            } else {
                previous_value <= bound
            };
            if current_inside != previous_inside {
                let amount = (bound - previous_value) / (current_value - previous_value);
                polygon.push(Point::new(
                    previous.x + (current.x - previous.x) * amount,
                    previous.y + (current.y - previous.y) * amount,
                ));
            }
            if current_inside {
                polygon.push(current);
            }
        }
    }
    polygon
}

fn polygon_area(points: &[Point]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let next = points[(index + 1) % points.len()];
            point.x * next.y - next.x * point.y
        })
        .sum::<f64>()
        .abs()
        * 0.5
}

fn homography_from_four(source: [Point; 4], target: [Point; 4]) -> Option<Projective> {
    let mut equations = vec![vec![0.0; 9]; 8];
    for index in 0..4 {
        let x = source[index].x;
        let y = source[index].y;
        let u = target[index].x;
        let v = target[index].y;
        equations[index * 2][0] = x;
        equations[index * 2][1] = y;
        equations[index * 2][2] = 1.0;
        equations[index * 2][6] = -u * x;
        equations[index * 2][7] = -u * y;
        equations[index * 2][8] = u;
        equations[index * 2 + 1][3] = x;
        equations[index * 2 + 1][4] = y;
        equations[index * 2 + 1][5] = 1.0;
        equations[index * 2 + 1][6] = -v * x;
        equations[index * 2 + 1][7] = -v * y;
        equations[index * 2 + 1][8] = v;
    }
    let values = solve(equations)?;
    Some(Projective {
        matrix: [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
            [values[6], values[7], 1.0],
        ],
    })
}

fn solve(mut matrix: Vec<Vec<f64>>) -> Option<Vec<f64>> {
    let size = matrix.len();
    for pivot in 0..size {
        let best = (pivot..size)
            .max_by(|&a, &b| matrix[a][pivot].abs().total_cmp(&matrix[b][pivot].abs()))?;
        if matrix[best][pivot].abs() < 1e-12 {
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

#[cfg(test)]
mod tests {
    use super::*;
    fn curves() -> DewarpOptions {
        DewarpOptions {
            top_curve: (0..=8)
                .map(|step| {
                    let x = 10.0 + step as f64 * 20.0;
                    Point::new(
                        x,
                        15.0 + 10.0 * ((step as f64 / 8.0 - 0.5) * std::f64::consts::PI).cos(),
                    )
                })
                .collect(),
            bottom_curve: (0..=8)
                .map(|step| {
                    let x = 10.0 + step as f64 * 20.0;
                    Point::new(
                        x,
                        125.0 + 10.0 * ((step as f64 / 8.0 - 0.5) * std::f64::consts::PI).cos(),
                    )
                })
                .collect(),
            depth: 0.15,
        }
    }
    #[test]
    fn endpoints_and_inverse_mapping_round_trip() {
        let model = DewarpModel::from_options(&curves()).unwrap();
        for &(u, v) in &[(0.0, 0.0), (1.0, 1.0), (0.35, 0.6)] {
            let source = model.map_unit_to_source(u, v).unwrap();
            let restored = model.map_source_to_unit_approx(source).unwrap();
            assert!((restored.x - u).abs() < 0.006);
            assert!((restored.y - v).abs() < 0.015);
        }
    }
    #[test]
    fn inverse_area_rasterizer_straightens_known_curves() {
        let model = DewarpModel::from_options(&curves()).unwrap();
        let mut source = GrayImage::new(180, 150, 255);
        for line in 1..5 {
            let v = line as f64 / 5.0;
            for step in 0..800 {
                let point = model.map_unit_to_source(step as f64 / 799.0, v).unwrap();
                let x = point.x.round() as usize;
                let y = point.y.round() as usize;
                if x < 180 && y < 150 {
                    source.set(x, y, 0);
                    if y + 1 < 150 {
                        source.set(x, y + 1, 0);
                    }
                }
            }
        }
        let output = rasterize_inverse_area(&source, &model, 160, 110);
        for line in 1..5 {
            let expected: usize = line * 22;
            let deviations: Vec<f64> = (5..155)
                .filter_map(|x| {
                    (expected.saturating_sub(3)..=(expected + 3).min(109))
                        .min_by_key(|&y| output.get(x, y))
                        .map(|y| y as f64 - expected as f64)
                })
                .collect();
            let rms = (deviations.iter().map(|value| value * value).sum::<f64>()
                / deviations.len() as f64)
                .sqrt();
            assert!(rms < 1.8, "rms={rms}");
        }
    }

    #[test]
    fn rejects_folded_crossing_and_reversed_directrices_with_specific_errors() {
        for folded_x in [35.0, 45.0, 55.0] {
            let folded = DewarpOptions {
                top_curve: vec![
                    Point::new(0.0, 0.0),
                    Point::new(70.0, 4.0),
                    Point::new(folded_x, 2.0),
                    Point::new(100.0, 0.0),
                ],
                bottom_curve: vec![Point::new(0.0, 100.0), Point::new(100.0, 100.0)],
                depth: 0.0,
            };
            assert!(matches!(
                DewarpModel::from_options(&folded),
                Err(DewarpModelError::NonMonotonicX { directrix: "top" })
            ));
        }

        for overlap in [0.0, -5.0, -20.0] {
            let crossing = DewarpOptions {
                top_curve: vec![
                    Point::new(0.0, 0.0),
                    Point::new(50.0, 55.0),
                    Point::new(100.0, 0.0),
                ],
                bottom_curve: vec![
                    Point::new(0.0, 100.0),
                    Point::new(50.0, 55.0 + overlap),
                    Point::new(100.0, 100.0),
                ],
                depth: 0.0,
            };
            assert!(matches!(
                DewarpModel::from_options(&crossing),
                Err(DewarpModelError::CurveSeparation)
            ));
        }

        let mut reversed = curves();
        reversed.top_curve.reverse();
        reversed.bottom_curve.reverse();
        assert!(matches!(
            DewarpModel::from_options(&reversed),
            Err(DewarpModelError::EndpointOrder)
        ));
    }

    #[test]
    fn rejects_weak_endpoint_order_jacobian_folds_and_excessive_magnification() {
        let weak_corner = DewarpOptions {
            top_curve: vec![Point::new(0.0, 0.0), Point::new(100.0, 0.0)],
            bottom_curve: vec![Point::new(99.9, 100.0), Point::new(100.0, 100.0)],
            depth: 0.0,
        };
        assert!(matches!(
            DewarpModel::from_options(&weak_corner),
            Err(DewarpModelError::EndpointOrder)
        ));

        let jacobian_fold = DewarpOptions {
            top_curve: vec![
                Point::new(0.0, 0.0),
                Point::new(1.0, 10.0),
                Point::new(100.0, 0.0),
            ],
            bottom_curve: vec![
                Point::new(0.0, 20.0),
                Point::new(99.0, 10.1),
                Point::new(100.0, 20.0),
            ],
            depth: 0.0,
        };
        assert!(matches!(
            DewarpModel::from_options(&jacobian_fold),
            Err(DewarpModelError::NonPositiveJacobian)
        ));

        let excessive = DewarpOptions {
            top_curve: vec![Point::new(0.0, 0.0), Point::new(100.0, 0.0)],
            bottom_curve: vec![Point::new(0.0, 100.0), Point::new(100.0, 100.0)],
            depth: -0.9,
        };
        assert!(matches!(
            DewarpModel::from_options(&excessive),
            Err(DewarpModelError::ExcessiveMagnification)
        ));
    }

    #[test]
    fn valid_fixture_models_remain_valid_across_safe_depths() {
        for depth in [-0.5, 0.0, 0.15, 0.5, 1.0] {
            let mut fixture = curves();
            fixture.depth = depth;
            DewarpModel::from_options(&fixture)
                .unwrap_or_else(|error| panic!("depth={depth} unexpectedly failed: {error}"));
        }
    }
}
