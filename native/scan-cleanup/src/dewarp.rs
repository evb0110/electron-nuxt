use crate::DewarpOptions;
use scan_primitives::{GrayImage, Point, Projective};

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
    pub fn from_options(options: &DewarpOptions) -> Result<Self, String> {
        if options.top_curve.len() < 2 || options.bottom_curve.len() < 2 {
            return Err("Dewarp directrices require at least two points each".into());
        }
        if !options.depth.is_finite() || !(-0.9..=4.0).contains(&options.depth) {
            return Err("Dewarp depth must be finite and between -0.9 and 4.0".into());
        }
        let corners = [
            options.top_curve[0],
            *options.top_curve.last().unwrap(),
            *options.bottom_curve.last().unwrap(),
            options.bottom_curve[0],
        ];
        let unit = [
            Point::new(0.0, 0.0),
            Point::new(1.0, 0.0),
            Point::new(1.0, 1.0),
            Point::new(0.0, 1.0),
        ];
        let homography = homography_from_four(corners, unit)
            .ok_or("Dewarp endpoint quadrilateral is degenerate")?;
        let inverse_homography = homography
            .inverse()
            .ok_or("Dewarp homography is not invertible")?;
        let top_points = options
            .top_curve
            .iter()
            .map(|&point| homography.apply(point).ok_or("Invalid top directrix point"))
            .collect::<Result<Vec<_>, _>>()?;
        let bottom_points = options
            .bottom_curve
            .iter()
            .map(|&point| {
                homography
                    .apply(point)
                    .ok_or("Invalid bottom directrix point")
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            homography,
            inverse_homography,
            top: ArcPolyline::new(top_points)?,
            bottom: ArcPolyline::new(bottom_points)?,
            depth: options.depth,
        })
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
}

impl ArcPolyline {
    fn new(points: Vec<Point>) -> Result<Self, String> {
        let mut cumulative = vec![0.0];
        for pair in points.windows(2) {
            let length = ((pair[1].x - pair[0].x).powi(2) + (pair[1].y - pair[0].y).powi(2)).sqrt();
            cumulative.push(cumulative.last().copied().unwrap() + length);
        }
        let length = *cumulative.last().unwrap();
        if length <= 1e-9 {
            return Err("Dewarp directrix has zero length".into());
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

pub fn rasterize_inverse_area(
    source: &GrayImage,
    model: &DewarpModel,
    width: usize,
    height: usize,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    for y in 0..height {
        for x in 0..width {
            let u0 = x as f64 / width as f64;
            let u1 = (x + 1) as f64 / width as f64;
            let v0 = y as f64 / height as f64;
            let v1 = (y + 1) as f64 / height as f64;
            let Some(quad) = mapped_quad(model, u0, v0, u1, v1) else {
                continue;
            };
            output.set(x, y, integrate_quad(source, &quad));
        }
    }
    output
}

fn mapped_quad(model: &DewarpModel, u0: f64, v0: f64, u1: f64, v1: f64) -> Option<[Point; 4]> {
    Some([
        model.map_unit_to_source(u0, v0)?,
        model.map_unit_to_source(u1, v0)?,
        model.map_unit_to_source(u1, v1)?,
        model.map_unit_to_source(u0, v1)?,
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
}
