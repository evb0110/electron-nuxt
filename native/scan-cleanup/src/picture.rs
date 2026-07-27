use crate::{
    calibration::PageCalibration, CleanupOptions, NormalizedZonePolygon, PictureZoneLayer,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, dilate_gray, erode_gray, fill_gray_holes, reconstruct_gray_by_erosion},
    threshold::{
        mokji_threshold, otsu_threshold, threshold_global, DEFAULT_MOKJI_MAX_EDGE_WIDTH,
        DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE,
    },
    BinaryImage, ComponentMap, GrayImage,
};

const DETECTOR_DPI: f64 = 300.0;
const CONTRAST_TAIL_FRACTION: f64 = 0.01;
const MIN_TEXT_COMPONENTS_FOR_VETO: usize = 8;

/// Detects continuous-tone picture regions. `true` pixels belong to pictures.
pub(crate) fn detect_picture_mask(
    source: &GrayImage,
    raster_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    if source.width() == 0 || source.height() == 0 {
        return BinaryImage::new(source.width(), source.height());
    }
    let scale = (raster_dpi / DETECTOR_DPI).clamp(0.25, 8.0);
    let small_radius = (1.0 * scale).round().max(1.0) as usize;
    let marker_radius = (17.0 * scale).round().max(1.0) as usize;
    let edge_width = (DEFAULT_MOKJI_MAX_EDGE_WIDTH as f64 * scale)
        .round()
        .max(1.0) as usize;

    let stretched = stretch_contrast(source, CONTRAST_TAIL_FRACTION);
    let eroded = erode_gray(&stretched, small_radius, small_radius);
    let dilated = dilate_gray(&stretched, small_radius, small_radius);
    let mut contrast = GrayImage::new(source.width(), source.height(), 255);
    contrast
        .data_mut()
        .par_iter_mut()
        .zip(eroded.data().par_iter())
        .zip(dilated.data().par_iter())
        .for_each(|((target, &erosion), &dilation)| {
            let erosion = u16::from(erosion);
            let dilation = u16::from(dilation);
            let value = 255 - (255 - dilation) * erosion / 255;
            *target = value as u8;
        });
    let marker = erode_gray(&contrast, marker_radius, marker_radius);
    let reconstructed = reconstruct_gray_by_erosion(&marker, &contrast);
    let mut inverted = reconstructed;
    inverted
        .data_mut()
        .par_iter_mut()
        .for_each(|value| *value = 255 - *value);
    let filled = fill_gray_holes(&inverted);
    let threshold = mokji_threshold(&filled, edge_width, DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE);
    let candidate = threshold_global(&filled, threshold).invert();
    veto_text_like_regions(source, candidate, raster_dpi, calibration)
}

pub(crate) fn extend_picture_mask_for_content(
    source: &GrayImage,
    picture_mask: &BinaryImage,
    calibration: PageCalibration,
) -> BinaryImage {
    let threshold = otsu_threshold(source);
    let binary = threshold_global(source, threshold);
    let component_map = ComponentMap::from_binary(&binary);
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    let long_span = (8.0 * nominal_height).round().max(24.0) as usize;
    let anchors = component_map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        width >= long_span || height >= long_span
    });
    let cluster_radius = (3.0 * nominal_height).round().max(8.0) as usize;
    let cluster_map = ComponentMap::from_binary(&dilate(&anchors, cluster_radius, cluster_radius));
    let minimum_width = (12.0 * nominal_height).round().max(48.0) as usize;
    let minimum_height = (8.0 * nominal_height).round().max(32.0) as usize;
    let mut structural = BinaryImage::new(source.width(), source.height());
    for cluster in cluster_map.components() {
        let width = cluster.right - cluster.left + 1;
        let height = cluster.bottom - cluster.top + 1;
        if width < minimum_width
            || height < minimum_height
            || width > height.saturating_mul(7)
            || height > width.saturating_mul(7)
        {
            continue;
        }
        let supporting_components = component_map
            .components()
            .iter()
            .filter(|component| {
                let center_x = (component.left + component.right) / 2;
                let center_y = (component.top + component.bottom) / 2;
                (cluster.left..=cluster.right).contains(&center_x)
                    && (cluster.top..=cluster.bottom).contains(&center_y)
            })
            .count();
        if supporting_components < 8 {
            continue;
        }
        for y in cluster.top..=cluster.bottom {
            for x in cluster.left..=cluster.right {
                structural.set(x, y, true);
            }
        }
    }
    picture_mask.or(&structural)
}

pub(crate) fn apply_manual_zones(mask: &mut BinaryImage, options: &CleanupOptions) {
    for layer in [
        PictureZoneLayer::Eraser1,
        PictureZoneLayer::Painter2,
        PictureZoneLayer::Eraser3,
    ] {
        for zone in &options.manual_zones.picture {
            if zone.layer == layer {
                fill_normalized_polygon(mask, &zone.polygon, layer == PictureZoneLayer::Painter2);
            }
        }
    }
    // Fill zones are final binary painters, matching the last eraser pass.
    for polygon in &options.manual_zones.fill {
        fill_normalized_polygon(mask, polygon, false);
    }
}

fn fill_normalized_polygon(
    mask: &mut BinaryImage,
    normalized: &NormalizedZonePolygon,
    picture: bool,
) {
    let polygon = normalized.resolve(mask.width(), mask.height());
    if polygon.points.len() < 3 {
        return;
    }
    let min_x = polygon
        .points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_x = polygon
        .points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(mask.width() as f64) as usize;
    let min_y = polygon
        .points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_y = polygon
        .points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(mask.height() as f64) as usize;
    for y in min_y..max_y {
        for x in min_x..max_x {
            if point_in_polygon(x as f64 + 0.5, y as f64 + 0.5, &polygon.points) {
                mask.set(x, y, picture);
            }
        }
    }
}

fn point_in_polygon(x: f64, y: f64, points: &[scan_primitives::Point]) -> bool {
    let mut inside = false;
    let mut previous = points[points.len() - 1];
    for &current in points {
        let crosses = (current.y > y) != (previous.y > y)
            && x < (previous.x - current.x) * (y - current.y) / (previous.y - current.y)
                + current.x;
        if crosses {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

fn stretch_contrast(source: &GrayImage, tail_fraction: f64) -> GrayImage {
    let histogram = source
        .data()
        .par_chunks(65_536)
        .map(|chunk| {
            let mut histogram = [0usize; 256];
            for &value in chunk {
                histogram[value as usize] += 1;
            }
            histogram
        })
        .reduce(
            || [0usize; 256],
            |left, right| std::array::from_fn(|index| left[index] + right[index]),
        );
    let count = source.width().saturating_mul(source.height());
    if count == 0 {
        return source.clone();
    }
    let tail = (count as f64 * tail_fraction).round() as usize;
    let low = percentile_from_histogram(&histogram, tail.min(count - 1));
    let high = percentile_from_histogram(&histogram, count.saturating_sub(tail).saturating_sub(1));
    if low >= high {
        return source.clone();
    }
    let range = u16::from(high - low);
    let mut output = source.clone();
    output
        .data_mut()
        .par_iter_mut()
        .zip(source.data().par_iter())
        .for_each(|(target, &value)| {
            let stretched = if value <= low {
                0
            } else if value >= high {
                255
            } else {
                ((u16::from(value - low) * 255 + range / 2) / range) as u8
            };
            *target = stretched;
        });
    output
}

fn percentile_from_histogram(histogram: &[usize; 256], rank: usize) -> u8 {
    let mut cumulative = 0usize;
    for (value, &frequency) in histogram.iter().enumerate() {
        cumulative += frequency;
        if cumulative > rank {
            return value as u8;
        }
    }
    255
}

fn veto_text_like_regions(
    source: &GrayImage,
    candidate: BinaryImage,
    raster_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    if !calibration.valid || candidate.count_black() == 0 {
        return candidate;
    }
    let candidate_components = ComponentMap::from_binary(&candidate);
    if candidate_components.components().is_empty() {
        return candidate;
    }
    let text = threshold_global(source, otsu_threshold(source));
    let text_components = ComponentMap::from_binary(&text);
    let distance_to_white = squared_euclidean_distance(&text.invert());
    let maxima = text_components.maximum_values_by_component(&distance_to_white);
    let scale = raster_dpi.max(1.0) / calibration.effective_dpi.max(1.0);
    let body_stroke = calibration.stroke_width_px * scale;
    let body_height = calibration.x_height_px * scale;
    let mut matched_strokes = vec![Vec::<f64>::new(); candidate_components.components().len() + 1];
    let mut contained_counts = vec![0usize; candidate_components.components().len() + 1];
    for component in text_components.components() {
        if component.area < 4 {
            continue;
        }
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let candidate_label = candidate_components.label_at(center_x, center_y) as usize;
        if candidate_label == 0 {
            continue;
        }
        contained_counts[candidate_label] += 1;
        let stroke = 2.0 * f64::from(maxima[component.label as usize]).sqrt();
        let height = (component.bottom - component.top + 1) as f64;
        if (body_stroke * 0.6..=body_stroke * 1.6).contains(&stroke)
            && (body_height * 0.55..=body_height * 1.8).contains(&height)
        {
            matched_strokes[candidate_label].push(stroke);
        }
    }

    let mut vetoed = vec![false; candidate_components.components().len() + 1];
    for component in candidate_components.components() {
        let label = component.label as usize;
        let strokes = &mut matched_strokes[label];
        if strokes.len() < MIN_TEXT_COMPONENTS_FOR_VETO
            || strokes.len() * 2 < contained_counts[label]
        {
            continue;
        }
        strokes.sort_unstable_by(f64::total_cmp);
        let median = strokes[strokes.len() / 2];
        if (body_stroke * 0.7..=body_stroke * 1.4).contains(&median) {
            vetoed[label] = true;
        }
    }
    if !vetoed.iter().any(|&value| value) {
        return candidate;
    }
    candidate_components.retain(|component| !vetoed[component.label as usize])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::CalibrationConfig;
    use crate::{ManualZones, NormalizedZonePoint, OrthogonalRotation, PictureZone};

    fn glyph_page(with_photo: bool) -> GrayImage {
        let mut image = GrayImage::new(260, 180, 242);
        for row in 0..4 {
            for column in 0..9 {
                let left = 15 + column * 18;
                let top = 18 + row * 28;
                for y in top..top + 15 {
                    for x in left..left + 10 {
                        if x < left + 2 || y < top + 2 || y >= top + 13 {
                            image.set(x, y, 28);
                        }
                    }
                }
            }
        }
        if with_photo {
            for y in 35..155 {
                for x in 185..250 {
                    let value = 35 + ((x * 11 + y * 7 + x * y % 41) % 190) as u8;
                    image.set(x, y, value);
                }
            }
        }
        image
    }

    #[test]
    fn text_only_page_is_vetoed_but_continuous_tone_patch_survives() {
        let text = glyph_page(false);
        let calibration = PageCalibration::estimate(&text, 300.0, CalibrationConfig::default());
        assert!(calibration.valid);
        assert_eq!(
            detect_picture_mask(&text, 300.0, calibration).count_black(),
            0
        );

        let mixed = glyph_page(true);
        let calibration = PageCalibration::estimate(&mixed, 300.0, CalibrationConfig::default());
        let mask = detect_picture_mask(&mixed, 300.0, calibration);
        let photo_pixels = (35..155)
            .flat_map(|y| (185..250).map(move |x| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            photo_pixels > 2_000,
            "detected only {photo_pixels} photo pixels"
        );
        let text_pixels = (0..160)
            .flat_map(|x| (0..150).map(move |y| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            text_pixels < 200,
            "misclassified {text_pixels} text-area pixels"
        );
    }

    #[test]
    fn halftone_fixture_does_not_turn_body_text_into_picture() {
        let mut image = glyph_page(false);
        for y in 25..165 {
            for x in 180..250 {
                let cell = (x / 4 + y / 4) % 7;
                if x % 4 < 1 + cell % 2 && y % 4 < 1 + (cell / 2) % 2 {
                    image.set(x, y, 35 + (cell * 18) as u8);
                }
            }
        }
        let calibration = PageCalibration::estimate(&image, 300.0, CalibrationConfig::default());
        let mask = detect_picture_mask(&image, 300.0, calibration);
        let text_area_pictures = (0..170)
            .flat_map(|x| (0..150).map(move |y| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            text_area_pictures < 200,
            "halftone detector leaked into {text_area_pictures} body-text pixels"
        );
    }

    #[test]
    fn content_picture_mask_extends_across_large_line_art_structure() {
        let mut image = GrayImage::new(420, 260, 242);
        for row in 0..8 {
            for column in 0..10 {
                let left = 15 + column * 15;
                let top = 18 + row * 27;
                for y in top..top + 14 {
                    for x in left..left + 8 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            image.set(x, y, 28);
                        }
                    }
                }
            }
        }
        for x in 190..390 {
            image.set(x, 22, 24);
            image.set(x, 224, 24);
        }
        for y in 22..225 {
            image.set(190, y, 24);
            image.set(389, y, 24);
        }
        for row in 0..11 {
            let top = 42 + row * 14;
            for stroke in 0..7 {
                let left = 204 + stroke * 24 + row % 3;
                for offset in 0..14 {
                    image.set(left + offset, top + offset % 3, 28);
                    image.set(left + offset, top + 1 + offset % 3, 28);
                }
            }
        }
        let calibration = PageCalibration::estimate(&image, 300.0, CalibrationConfig::default());
        let base = detect_picture_mask(&image, 300.0, calibration);
        let content = extend_picture_mask_for_content(&image, &base, calibration);
        let line_art_pixels = (22..225)
            .flat_map(|y| (190..390).map(move |x| (x, y)))
            .filter(|&(x, y)| content.get(x, y))
            .count();
        assert!(
            line_art_pixels > 30_000,
            "line-art picture mask covered only {line_art_pixels} pixels"
        );
        assert!(!content.get(20, 20), "unrelated body text was protected");
    }

    fn polygon(left: f64, top: f64, right: f64, bottom: f64) -> NormalizedZonePolygon {
        NormalizedZonePolygon {
            points: vec![
                NormalizedZonePoint { x: left, y: top },
                NormalizedZonePoint { x: right, y: top },
                NormalizedZonePoint {
                    x: right,
                    y: bottom,
                },
                NormalizedZonePoint { x: left, y: bottom },
            ],
            rotation: OrthogonalRotation::None,
        }
    }

    #[test]
    fn zones_apply_eraser_then_painter_then_eraser_and_fill() {
        let mut mask = BinaryImage::new(100, 100);
        let options = CleanupOptions {
            manual_zones: ManualZones {
                picture: vec![
                    PictureZone {
                        polygon: polygon(0.1, 0.1, 0.9, 0.9),
                        layer: PictureZoneLayer::Painter2,
                    },
                    PictureZone {
                        polygon: polygon(0.0, 0.0, 0.5, 0.5),
                        layer: PictureZoneLayer::Eraser1,
                    },
                    PictureZone {
                        polygon: polygon(0.7, 0.7, 1.0, 1.0),
                        layer: PictureZoneLayer::Eraser3,
                    },
                ],
                fill: vec![polygon(0.45, 0.45, 0.55, 0.55)],
            },
            ..CleanupOptions::default()
        };
        apply_manual_zones(&mut mask, &options);
        assert!(mask.get(20, 20), "painter must win over eraser1");
        assert!(!mask.get(80, 80), "eraser3 must win over painter");
        assert!(!mask.get(50, 50), "fill zones force the binary layer");
        assert!(!mask.get(5, 5));
    }
}
