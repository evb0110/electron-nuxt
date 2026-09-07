use super::*;
use crate::background::normalize_illumination;

#[allow(clippy::too_many_arguments)]
fn prepare_analysis_page(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    prepare_quality_raster: bool,
    render_policy: PageRenderPolicy,
    document_prior: Option<DocumentPrior>,
    calibration_config: CalibrationConfig,
    cache: Option<&PageCache>,
    trusted_mrc_background: Option<&GrayImage>,
    timings: &mut PageStageTimings,
) -> PreparedAnalysis {
    document_analysis::run(document_analysis::Input {
        source,
        color_source,
        options,
        prepare_quality_raster,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    })
}

fn crop_gray_to_fit(
    source: &GrayImage,
    rect: Rect,
    max_width: usize,
    max_height: usize,
) -> GrayImage {
    crop_gray(source, rect).downscale_to_fit(max_width, max_height)
}

fn render_affine_gray_supersampled_reference(
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

include!("../render_tests.rs");
