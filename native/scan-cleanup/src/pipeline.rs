use crate::{
    auto_dewarp::detect_curves,
    background::normalize_illumination,
    bw::{binarize_normalized, binary_to_gray},
    content::detect_content_and_margins,
    deskew::{detect_skew, DeskewResult},
    dewarp::{rasterize_inverse_area, DewarpModel},
    png::RgbImage,
    split::{detect_split, LayoutClassification, SplitResult},
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use scan_primitives::{Affine, GrayImage, Point, Polygon, Rect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageHalf {
    Full,
    Left,
    Right,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpMappingGrid {
    pub columns: usize,
    pub rows: usize,
    pub output_origin: Point,
    pub output_width: usize,
    pub output_height: usize,
    pub output_to_source: Vec<Point>,
    pub source_to_output: Vec<Point>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupMetadata {
    pub source_page_index: usize,
    pub half: PageHalf,
    pub detected_skew_degrees: f64,
    pub skew_confidence: f64,
    pub skew_applied: bool,
    pub layout_classification: LayoutClassification,
    pub layout_confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_geometry: Vec<Polygon>,
    pub source_region: Rect,
    pub content_box: Option<Rect>,
    pub applied_margins: [f64; 4],
    pub soft_margins_pixels: [usize; 4],
    pub uniform_canvas: bool,
    pub output_mode: OutputMode,
    pub binarization_mode: Option<crate::BinarizationMode>,
    pub forward_transform: Option<Affine>,
    pub inverse_transform: Option<Affine>,
    pub dewarp_model: Option<crate::DewarpOptions>,
    pub dewarp_mapping: Option<DewarpMappingGrid>,
    pub dewarp_confidence: Option<f64>,
    pub input_width: usize,
    pub input_height: usize,
    pub output_width: usize,
    pub output_height: usize,
    pub rotation: OrthogonalRotation,
    pub resample_passes: usize,
    pub warnings: Vec<String>,
}

pub struct CleanupResult {
    pub image: GrayImage,
    pub color_image: Option<RgbImage>,
    pub metadata: CleanupMetadata,
    effectively_blank: bool,
}

pub struct PageCleanupResult {
    pub outputs: Vec<CleanupResult>,
    pub classification: LayoutClassification,
    pub layout_confidence: f64,
    pub cutter_x: Option<f64>,
    pub blank_outputs_skipped: usize,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
}

pub fn clean_page(
    source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    clean_page_with_color(source, None, options, source_page_index)
}

pub fn clean_page_with_color(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    options.validate()?;
    if options.excluded {
        return Ok(PageCleanupResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            layout_confidence: 1.0,
            cutter_x: None,
            blank_outputs_skipped: 0,
            excluded: true,
            rotation: options.rotation,
        });
    }
    let (rotated, original_to_rotated) = rotate_orthogonal(source, options.rotation);
    let rotated_color = color_source.map(|image| rotate_rgb_orthogonal(image, options.rotation));
    let normalized = if options.normalize_illumination {
        normalize_illumination(&rotated, options.dpi)
    } else {
        rotated
    };
    let (analysis_binary, _) = binarize_normalized(&normalized, options);
    let split = if options.ocr_mode {
        detect_split(
            &normalized,
            &analysis_binary,
            options.dpi,
            crate::LayoutMode::Single,
            None,
        )
    } else {
        detect_split(
            &normalized,
            &analysis_binary,
            options.dpi,
            options.layout,
            options.manual_split_x,
        )
    };
    drop(analysis_binary);
    let regions = output_regions(
        normalized.width(),
        normalized.height(),
        &split,
        options.layout,
    );
    let mut outputs = Vec::with_capacity(regions.len());
    for (region, half) in regions {
        outputs.push(clean_region(
            source,
            &normalized,
            rotated_color.as_ref(),
            options,
            source_page_index,
            &split,
            region,
            half,
            original_to_rotated,
        )?);
    }
    let before_blank_filter = outputs.len();
    if options.skip_blank_pages {
        outputs.retain(|output| !output.effectively_blank);
    }
    let blank_outputs_skipped = before_blank_filter - outputs.len();
    Ok(PageCleanupResult {
        outputs,
        classification: split.classification,
        layout_confidence: split.confidence,
        cutter_x: split.cutter_x,
        blank_outputs_skipped,
        excluded: false,
        rotation: options.rotation,
    })
}

fn output_regions(
    width: usize,
    height: usize,
    split: &SplitResult,
    layout: crate::LayoutMode,
) -> Vec<(Rect, PageHalf)> {
    let full = Rect::new(0.0, 0.0, width as f64, height as f64);
    let Some(cutter) = split.cutter_x else {
        return vec![(full, PageHalf::Full)];
    };
    let cutter = cutter.round().clamp(1.0, width.saturating_sub(1) as f64);
    let left = Rect::new(0.0, 0.0, cutter, height as f64);
    let right = Rect::new(cutter, 0.0, width as f64 - cutter, height as f64);
    match split.classification {
        LayoutClassification::TwoPageSpread => {
            vec![(left, PageHalf::Left), (right, PageHalf::Right)]
        }
        LayoutClassification::PageWithOffcut => {
            if matches!(layout, crate::LayoutMode::KeepLeft)
                || !matches!(layout, crate::LayoutMode::KeepRight) && left.width >= right.width
            {
                vec![(left, PageHalf::Left)]
            } else {
                vec![(right, PageHalf::Right)]
            }
        }
        LayoutClassification::SingleUncutPage => vec![(full, PageHalf::Full)],
    }
}

#[allow(clippy::too_many_arguments)]
fn clean_region(
    source: &GrayImage,
    normalized: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    split: &SplitResult,
    region: Rect,
    half: PageHalf,
    original_to_rotated: Affine,
) -> Result<CleanupResult, String> {
    let working = crop_gray(normalized, region);
    let deskew = detect_skew(&working, options.dpi);
    let content = detect_content_and_margins(
        &working,
        options.dpi,
        options.margins_mm,
        options.margins_pixels,
    );
    let automatic_dewarp = if options.dewarp.is_none() && options.experimental_auto_dewarp {
        Some(detect_curves(&working))
    } else {
        None
    };
    let effective_dewarp = options.dewarp.clone().or_else(|| {
        automatic_dewarp
            .as_ref()
            .and_then(|result| result.model.clone())
    });
    let crop_enabled = options.crop_content
        && !options.ocr_mode
        && content.content.is_some()
        && effective_dewarp.is_none();
    let output_rect = if crop_enabled {
        content.output_rect
    } else {
        Rect::new(0.0, 0.0, working.width() as f64, working.height() as f64)
    };
    let output_width = output_rect.width.ceil().max(1.0) as usize;
    let output_height = output_rect.height.ceil().max(1.0) as usize;
    let local_forward = deskew_transform(working.width(), working.height(), deskew)
        .then(Affine::translation(-output_rect.x, -output_rect.y));
    let rotated_forward = Affine::translation(-region.x, -region.y).then(local_forward);
    let source_forward = original_to_rotated.then(rotated_forward);
    let render_inverse = rotated_forward
        .inverse()
        .ok_or("Cleanup transform is not invertible")?;
    let source_inverse = source_forward
        .inverse()
        .ok_or("Cleanup source transform is not invertible")?;

    let (rendered_gray, forward_transform, inverse_transform, dewarp_mapping) =
        if let Some(dewarp) = &effective_dewarp {
            let model = DewarpModel::from_options(dewarp)?;
            let gray = rasterize_inverse_area(&working, &model, working.width(), working.height());
            let grid = sampled_dewarp_grid(&model, region, working.width(), working.height());
            (gray, None, None, Some(grid))
        } else {
            (
                render_affine_gray(normalized, output_width, output_height, render_inverse),
                Some(source_forward),
                Some(source_inverse),
                None,
            )
        };
    let effectively_blank = is_effectively_blank(&rendered_gray, options.dpi);
    let (image, color_image, binarization_mode) = match options.output_mode {
        OutputMode::Bw => {
            let (binary, mode) = binarize_normalized(&rendered_gray, options);
            (binary_to_gray(&binary), None, Some(mode))
        }
        OutputMode::Grayscale => (rendered_gray, None, None),
        OutputMode::Color => {
            let color = color_source
                .map(|color| render_affine_rgb(color, output_width, output_height, render_inverse));
            (rendered_gray, color, None)
        }
    };
    let mut warnings = if deskew.accepted || effective_dewarp.is_some() {
        Vec::new()
    } else {
        vec![format!(
            "Deskew confidence {:.3} was below the 2.0 acceptance threshold",
            deskew.confidence
        )]
    };
    if options.crop_content && !crop_enabled && content.content.is_none() {
        warnings.push("Content crop was skipped because no content box was detected".into());
    }
    if let Some(auto) = &automatic_dewarp {
        if auto.model.is_none() {
            warnings.push(format!(
                "Experimental automatic dewarp confidence {:.3} was below 0.6; no dewarp was applied",
                auto.confidence
            ));
        }
    }
    Ok(CleanupResult {
        image,
        color_image,
        effectively_blank,
        metadata: CleanupMetadata {
            source_page_index,
            half,
            detected_skew_degrees: deskew.angle_degrees,
            skew_confidence: deskew.confidence,
            skew_applied: deskew.accepted,
            layout_classification: split.classification,
            layout_confidence: split.confidence,
            cutter_x: split.cutter_x,
            split_geometry: split.pages.clone(),
            source_region: region,
            content_box: content.content,
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            },
            soft_margins_pixels: [0; 4],
            uniform_canvas: false,
            output_mode: options.output_mode,
            binarization_mode,
            forward_transform,
            inverse_transform,
            dewarp_model: effective_dewarp,
            dewarp_mapping,
            dewarp_confidence: automatic_dewarp.as_ref().map(|result| result.confidence),
            input_width: source.width(),
            input_height: source.height(),
            output_width,
            output_height,
            rotation: options.rotation,
            resample_passes: 1,
            warnings,
        },
    })
}

fn rotate_rgb_orthogonal(source: &RgbImage, rotation: OrthogonalRotation) -> RgbImage {
    let (width, height) = (source.width(), source.height());
    let (output_width, output_height) = match rotation {
        OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => (width, height),
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => (height, width),
    };
    let mut output = RgbImage::new(output_width, output_height, [255; 3]);
    for y in 0..height {
        for x in 0..width {
            let (target_x, target_y) = match rotation {
                OrthogonalRotation::None => (x, y),
                OrthogonalRotation::Clockwise90 => (height - 1 - y, x),
                OrthogonalRotation::Clockwise180 => (width - 1 - x, height - 1 - y),
                OrthogonalRotation::Clockwise270 => (y, width - 1 - x),
            };
            output.set(target_x, target_y, source.get(x, y));
        }
    }
    output
}

fn rotate_orthogonal(source: &GrayImage, rotation: OrthogonalRotation) -> (GrayImage, Affine) {
    let (width, height) = (source.width(), source.height());
    let (output_width, output_height, forward) = match rotation {
        OrthogonalRotation::None => (width, height, Affine::IDENTITY),
        OrthogonalRotation::Clockwise90 => (
            height,
            width,
            Affine {
                matrix: [[0.0, -1.0, height as f64], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            },
        ),
        OrthogonalRotation::Clockwise180 => (
            width,
            height,
            Affine {
                matrix: [
                    [-1.0, 0.0, width as f64],
                    [0.0, -1.0, height as f64],
                    [0.0, 0.0, 1.0],
                ],
            },
        ),
        OrthogonalRotation::Clockwise270 => (
            height,
            width,
            Affine {
                matrix: [[0.0, 1.0, 0.0], [-1.0, 0.0, width as f64], [0.0, 0.0, 1.0]],
            },
        ),
    };
    let mut output = GrayImage::new(output_width, output_height, 255);
    for y in 0..height {
        for x in 0..width {
            let (target_x, target_y) = match rotation {
                OrthogonalRotation::None => (x, y),
                OrthogonalRotation::Clockwise90 => (height - 1 - y, x),
                OrthogonalRotation::Clockwise180 => (width - 1 - x, height - 1 - y),
                OrthogonalRotation::Clockwise270 => (y, width - 1 - x),
            };
            output.set(target_x, target_y, source.get(x, y));
        }
    }
    (output, forward)
}

fn is_effectively_blank(image: &GrayImage, dpi: f64) -> bool {
    let ink = image.data().iter().filter(|&&value| value < 224).count();
    let dpi_floor = (24.0 * (dpi / 300.0).powi(2)).round().max(6.0) as usize;
    let coverage_floor =
        (image.width().saturating_mul(image.height()) as f64 * 0.00002).round() as usize;
    ink <= dpi_floor.max(coverage_floor)
}

fn crop_gray(source: &GrayImage, rect: Rect) -> GrayImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = GrayImage::new(width, height, 255);
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
    }
    output
}

fn deskew_transform(width: usize, height: usize, deskew: DeskewResult) -> Affine {
    if !deskew.accepted {
        return Affine::IDENTITY;
    }
    let cx = width as f64 * 0.5;
    let cy = height as f64 * 0.5;
    Affine::translation(-cx, -cy)
        .then(Affine::rotation_radians(-deskew.angle_degrees.to_radians()))
        .then(Affine::translation(cx, cy))
}

fn render_affine_gray(
    source: &GrayImage,
    width: usize,
    height: usize,
    inverse: Affine,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    let offsets = [0.125, 0.375, 0.625, 0.875];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0u32;
            for &oy in &offsets {
                for &ox in &offsets {
                    let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                    sum += u32::from(sample_bilinear_white(source, mapped.x, mapped.y));
                }
            }
            output.set(x, y, (sum / 16) as u8);
        }
    }
    output
}

fn render_affine_rgb(source: &RgbImage, width: usize, height: usize, inverse: Affine) -> RgbImage {
    let mut output = RgbImage::new(width, height, [255; 3]);
    let offsets = [0.125, 0.375, 0.625, 0.875];
    for y in 0..height {
        for x in 0..width {
            let mut sum = [0u32; 3];
            for &oy in &offsets {
                for &ox in &offsets {
                    let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                    let sample = sample_bilinear_rgb_white(source, mapped.x, mapped.y);
                    for channel in 0..3 {
                        sum[channel] += u32::from(sample[channel]);
                    }
                }
            }
            output.set(
                x,
                y,
                [
                    (sum[0] / 16) as u8,
                    (sum[1] / 16) as u8,
                    (sum[2] / 16) as u8,
                ],
            );
        }
    }
    output
}

fn sample_bilinear_rgb_white(source: &RgbImage, x: f64, y: f64) -> [u8; 3] {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> [u8; 3] {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            [255; 3]
        } else {
            source.get(sx as usize, sy as usize)
        }
    };
    let samples = [
        sample(x0, y0),
        sample(x0 + 1, y0),
        sample(x0, y0 + 1),
        sample(x0 + 1, y0 + 1),
    ];
    let mut output = [0u8; 3];
    for (channel, target) in output.iter_mut().enumerate() {
        let top = f64::from(samples[0][channel]) * (1.0 - fx) + f64::from(samples[1][channel]) * fx;
        let bottom =
            f64::from(samples[2][channel]) * (1.0 - fx) + f64::from(samples[3][channel]) * fx;
        *target = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
    }
    output
}

fn sample_bilinear_white(source: &GrayImage, x: f64, y: f64) -> u8 {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> f64 {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            255.0
        } else {
            f64::from(source.get(sx as usize, sy as usize))
        }
    };
    let top = sample(x0, y0) * (1.0 - fx) + sample(x0 + 1, y0) * fx;
    let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
    (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8
}

fn sampled_dewarp_grid(
    model: &DewarpModel,
    region: Rect,
    width: usize,
    height: usize,
) -> DewarpMappingGrid {
    const GRID: usize = 17;
    let mut output_to_source = Vec::with_capacity(GRID * GRID);
    let mut source_to_output = Vec::with_capacity(GRID * GRID);
    for row in 0..GRID {
        for column in 0..GRID {
            let u = column as f64 / (GRID - 1) as f64;
            let v = row as f64 / (GRID - 1) as f64;
            let mapped = model
                .map_unit_to_source(u, v)
                .unwrap_or(Point::new(u * width as f64, v * height as f64));
            output_to_source.push(Point::new(mapped.x + region.x, mapped.y + region.y));
            let source = Point::new(u * width as f64, v * height as f64);
            let mapped = model
                .map_source_to_unit_approx(source)
                .unwrap_or(Point::new(u, v));
            source_to_output.push(Point::new(
                mapped.x * width as f64,
                mapped.y * height as f64,
            ));
        }
    }
    DewarpMappingGrid {
        columns: GRID,
        rows: GRID,
        output_origin: Point::new(0.0, 0.0),
        output_width: width,
        output_height: height,
        output_to_source,
        source_to_output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thin_stroke_fixture() -> (GrayImage, Vec<(usize, usize)>) {
        let mut source = GrayImage::new(420, 300, 240);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(
                    x,
                    y,
                    (226 + (x * 12 / source.width()) + (y * 2 / source.height())) as u8,
                );
            }
        }
        let mut path = Vec::new();
        for x in 28..252 {
            let y = (72.0 + 24.0 * (x as f64 / 24.0).sin()).round() as usize;
            path.push((x, y));
            source.set(x, y, 158);
            if x % 3 != 0 && y + 1 < source.height() {
                source.set(x, y + 1, 172);
            }
        }
        for degree in 0..360 {
            let angle = (degree as f64).to_radians();
            let x = (330.0 + 34.0 * angle.cos()).round() as usize;
            let y = (78.0 + 34.0 * angle.sin()).round() as usize;
            path.push((x, y));
            source.set(x, y, 158);
            if degree % 3 != 0 && x + 1 < source.width() {
                source.set(x + 1, y, 172);
            }
        }
        for line in 0..9 {
            let top = 142 + line * 14;
            for word in 0..10 {
                let left = 32 + word * 34;
                for y in top..top + 3 {
                    for x in left..(left + 22).min(source.width() - 20) {
                        source.set(x, y, 62);
                    }
                }
            }
        }
        (source, path)
    }

    fn cleaned_fixture(source: &GrayImage, thickness: i8) -> GrayImage {
        clean_page(
            source,
            &CleanupOptions {
                dpi: 300.0,
                binarization: crate::BinarizationMode::Wolf,
                thickness,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0)
        .image
    }

    fn spread_fixture() -> GrayImage {
        let mut source = GrayImage::new(320, 200, 245);
        for y in (35..165).step_by(14) {
            for word in 0..7 {
                for x in 24 + word * 18..(36 + word * 18).min(142) {
                    source.set(x, y, 18);
                    source.set(x, y + 1, 18);
                    source.set(x, y + 2, 18);
                }
            }
            for word in 0..7 {
                for x in 178 + word * 18..(190 + word * 18).min(296) {
                    source.set(x, y, 22);
                    source.set(x, y + 1, 22);
                    source.set(x, y + 2, 22);
                }
            }
        }
        source
    }

    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }

    #[test]
    fn ocr_pipeline_preserves_dimensions_and_invertible_transform() {
        let mut source = GrayImage::new(160, 100, 240);
        for y in (20..80).step_by(12) {
            for x in 20..140 {
                source.set(x, y, 20);
                source.set(x, y + 1, 20);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                ocr_mode: true,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(result.outputs.len(), 1);
        let output = &result.outputs[0];
        assert_eq!((output.image.width(), output.image.height()), (160, 100));
        let point = Point::new(40.5, 50.5);
        let restored = output
            .metadata
            .inverse_transform
            .unwrap()
            .apply(output.metadata.forward_transform.unwrap().apply(point));
        assert!((restored.x - point.x).abs() < 1e-8);
    }

    #[test]
    fn default_bw_preserves_thin_curves_and_thickness_is_monotonic() {
        let (source, path) = thin_stroke_fixture();
        let thin = cleaned_fixture(&source, -5);
        let normal = cleaned_fixture(&source, 0);
        let thick = cleaned_fixture(&source, 5);
        let connected = path
            .iter()
            .filter(|&&(x, y)| {
                (y.saturating_sub(1)..=(y + 1).min(normal.height() - 1)).any(|ny| {
                    (x.saturating_sub(1)..=(x + 1).min(normal.width() - 1))
                        .any(|nx| normal.get(nx, ny) == 0)
                })
            })
            .count();
        let connectivity = connected as f64 / path.len() as f64;
        assert!(
            connectivity >= 0.98,
            "thin-stroke connectivity was {connectivity:.4}"
        );
        let black = |image: &GrayImage| image.data().iter().filter(|&&value| value == 0).count();
        assert!(
            black(&thin) < black(&normal) && black(&normal) < black(&thick),
            "black counts were thin={}, normal={}, thick={}",
            black(&thin),
            black(&normal),
            black(&thick)
        );
    }

    #[test]
    fn grayscale_output_keeps_midtones() {
        let mut source = GrayImage::new(120, 80, 230);
        for y in 20..60 {
            for x in 20..100 {
                source.set(x, y, 70 + ((x + y) % 100) as u8);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert!(result.outputs[0]
            .image
            .data()
            .iter()
            .any(|value| (1..255).contains(value)));
        assert_eq!(result.outputs[0].metadata.binarization_mode, None);
    }

    #[test]
    fn color_output_preserves_hue_and_uses_grayscale_geometry() {
        let mut gray = GrayImage::new(120, 90, 245);
        let mut color = RgbImage::new(120, 90, [245; 3]);
        for y in 24..66 {
            for x in 30..90 {
                gray.set(x, y, 90);
                color.set(x, y, [220, 35, 45]);
            }
        }
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let grayscale = clean_page(
            &gray,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base
            },
            0,
        )
        .unwrap();
        assert_eq!(
            colored.outputs[0].metadata.forward_transform,
            grayscale.outputs[0].metadata.forward_transform
        );
        assert_eq!(colored.outputs[0].metadata.resample_passes, 1);
        let patch = colored.outputs[0].color_image.as_ref().unwrap().get(60, 45);
        assert!(patch[0] > 180 && patch[0] > patch[1] * 3 && patch[0] > patch[2] * 3);
    }

    #[test]
    fn auto_spread_renders_two_independently_cropped_outputs() {
        let source = spread_fixture();
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                ..CleanupOptions::default()
            },
            4,
        )
        .unwrap();
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!((result.cutter_x.unwrap() - 160.0).abs() <= 3.0);
        assert_eq!(result.outputs.len(), 2);
        for (index, output) in result.outputs.iter().enumerate() {
            let expected = Rect::new(if index == 0 { 24.0 } else { 18.0 }, 35.0, 118.0, 129.0);
            let content = output.metadata.content_box.unwrap();
            assert!(
                iou(content, expected) >= 0.8,
                "half={index} actual={content:?}"
            );
            assert_eq!(output.metadata.source_page_index, 4);
            assert!(output.metadata.forward_transform.is_some());
            assert!(output.metadata.inverse_transform.is_some());
        }
        assert_eq!(result.outputs[0].metadata.half, PageHalf::Left);
        assert_eq!(result.outputs[1].metadata.half, PageHalf::Right);
    }

    #[test]
    fn forced_layouts_and_offcut_discard_are_authoritative() {
        let source = spread_fixture();
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        };
        let single = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::Single,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        assert_eq!(single.outputs.len(), 1);
        let spread = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::TwoPage,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        assert_eq!(spread.outputs.len(), 2);
        let offcut = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::PageWithOffcut,
                manual_split_x: Some(280.0),
                ..base
            },
            0,
        )
        .unwrap();
        assert_eq!(offcut.outputs.len(), 1);
        assert_eq!(offcut.outputs[0].metadata.half, PageHalf::Left);
        assert_eq!(offcut.outputs[0].metadata.source_region.width, 280.0);
    }

    #[test]
    fn exclusion_rotation_and_manual_cutter_are_authoritative() {
        let source = spread_fixture();
        let excluded = clean_page(
            &source,
            &CleanupOptions {
                excluded: true,
                ..CleanupOptions::default()
            },
            7,
        )
        .unwrap();
        assert!(excluded.outputs.is_empty());
        assert!(excluded.excluded);

        let rotated = clean_page(
            &source,
            &CleanupOptions {
                rotation: OrthogonalRotation::Clockwise90,
                layout: crate::LayoutMode::TwoPage,
                manual_split_x: Some(73.0),
                normalize_illumination: false,
                crop_content: false,
                ..CleanupOptions::default()
            },
            7,
        )
        .unwrap();
        assert_eq!(rotated.cutter_x, Some(73.0));
        assert_eq!(rotated.outputs.len(), 2);
        let metadata = &rotated.outputs[0].metadata;
        assert_eq!(metadata.rotation, OrthogonalRotation::Clockwise90);
        assert_eq!(metadata.resample_passes, 1);
        assert_eq!((metadata.input_width, metadata.input_height), (320, 200));
        let source_point = Point::new(32.5, 44.5);
        let restored = metadata
            .inverse_transform
            .unwrap()
            .apply(metadata.forward_transform.unwrap().apply(source_point));
        assert!((restored.x - source_point.x).abs() < 1e-8);
        assert!((restored.y - source_point.y).abs() < 1e-8);
    }

    #[test]
    fn skip_blank_pages_filters_only_effectively_blank_outputs() {
        let blank = GrayImage::new(180, 120, 255);
        let skipped = clean_page(
            &blank,
            &CleanupOptions {
                skip_blank_pages: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert!(skipped.outputs.is_empty());
        assert_eq!(skipped.blank_outputs_skipped, 1);

        let mut inked = blank;
        for y in 45..55 {
            for x in 40..140 {
                inked.set(x, y, 0);
            }
        }
        let retained = clean_page(
            &inked,
            &CleanupOptions {
                skip_blank_pages: true,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(retained.outputs.len(), 1);
        assert_eq!(retained.blank_outputs_skipped, 0);
    }
}
