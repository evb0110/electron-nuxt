use crate::{content::border_artifact_mask, io::png::RgbImage, OutputMode};
use scan_primitives::{threshold::otsu_threshold, BinaryImage, Component, ComponentMap, GrayImage};
use serde::{Deserialize, Serialize};

const CHROMA_NOISE_FLOOR: f64 = 18.0;
const DARK_CHROMA_NOISE_FLOOR: f64 = 36.0;
const DARK_LUMINANCE_CUTOFF: u8 = 48;
const CHROMA_SATURATION_FLOOR: f64 = 0.08;
const COLOR_PIXEL_FRACTION_FLOOR: f64 = 0.003;
const COLOR_PIXEL_FRACTION_HYSTERESIS: f64 = 0.0005;
const SIGNIFICANT_CHROMA_COMPONENT_PIXELS: usize = 500;
const CHROMA_COMPONENT_HYSTERESIS_PIXELS: usize = 80;
const MIN_PICTURE_COMPONENT_PIXELS: usize = 1_024;
const PICTURE_NOISE_FLOOR: f64 = 0.012;
const PICTURE_HYSTERESIS: f64 = 0.003;
const PICTURE_BALANCE_FRACTION: f64 = 0.14;
const BLANK_INK_LUMINANCE_CUTOFF: u8 = 160;
const BLANK_MAX_INK_FRACTION: f64 = 0.001;
const BLANK_EDGE_DIFFERENCE: u8 = 12;
const BLANK_MAX_EDGE_FRACTION: f64 = 0.0015;
const STRONG_BIMODALITY: f64 = 0.78;
const BIMODALITY_HYSTERESIS: f64 = 0.03;
const MIN_LUMINANCE_MODE_DISTANCE: f64 = 60.0;
const LUMINANCE_DISTANCE_HYSTERESIS: f64 = 6.0;
const MAX_BW_MIDTONE_FRACTION: f64 = 0.16;
const MIDTONE_HYSTERESIS: f64 = 0.02;
const TONAL_MIDTONE_FRACTION: f64 = 0.24;
const MIN_TEXT_LINES: usize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputModeRecommendationReason {
    Blank,
    ColorChroma,
    TextWithPictures,
    ContinuousTone,
    BimodalText,
    UncertainTonal,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutputModeRecommendation {
    pub mode: OutputMode,
    pub confidence: f64,
    pub reason: OutputModeRecommendationReason,
}

#[derive(Clone, Copy, Debug)]
struct ChromaEvidence {
    colored_fraction: f64,
    largest_component_pixels: usize,
    mean_saturation: f64,
}

#[derive(Clone, Copy, Debug)]
struct LuminanceEvidence {
    bimodality: f64,
    midtone_fraction: f64,
    mode_distance: f64,
    ink_fraction: f64,
    edge_fraction: f64,
}

pub(crate) struct PreparedModeEvidence<'a> {
    pub analysis: &'a GrayImage,
    pub analysis_rgb: Option<&'a RgbImage>,
    pub picture_mask: &'a BinaryImage,
    pub text_line_count: usize,
}

/// Chooses a concrete output mode from the renderer's prepared analysis artifacts.
///
/// Detect-all receives a direct 150-DPI raster while final rendering can downsample
/// a source-DPI raster to the same analysis ceiling. Those inputs can differ by a
/// few pixels and histogram counts. Every destructive B&W gate therefore includes
/// an explicit hysteresis margin; evidence near a boundary resolves to the more
/// tonal mode in both paths instead of depending on exact `>=` comparisons.
pub(crate) fn recommend_output_mode(
    evidence: PreparedModeEvidence<'_>,
) -> OutputModeRecommendation {
    let chroma = chroma_evidence(evidence.analysis, evidence.analysis_rgb);
    let significant_color = chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS
        >= COLOR_PIXEL_FRACTION_FLOOR
        || chroma
            .largest_component_pixels
            .saturating_add(CHROMA_COMPONENT_HYSTERESIS_PIXELS)
            >= SIGNIFICANT_CHROMA_COMPONENT_PIXELS;
    let pixel_count = evidence
        .analysis
        .width()
        .saturating_mul(evidence.analysis.height())
        .max(1);
    let picture_map = ComponentMap::from_binary(evidence.picture_mask);
    let border_artifacts = border_artifact_mask(evidence.analysis);
    let gutter_shadow = has_gutter_shadow(evidence.analysis);
    let picture_pixels = picture_map
        .components()
        .iter()
        .filter(|component| component.area >= MIN_PICTURE_COMPONENT_PIXELS)
        .filter(|component| {
            !is_border_artifact_picture_component(
                &picture_map,
                component,
                &border_artifacts,
                evidence.analysis,
                gutter_shadow,
            )
        })
        .map(|component| component.area)
        .sum::<usize>();
    let picture_fraction = picture_pixels as f64 / pixel_count as f64;
    let significant_picture = picture_fraction >= PICTURE_NOISE_FLOOR;
    let has_text = evidence.text_line_count >= MIN_TEXT_LINES;
    let luminance = luminance_evidence(evidence.analysis);

    if significant_color && significant_picture && has_text {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 8.0).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Mixed,
            confidence: (0.72 + 0.16 * picture_margin + 0.12 * text_margin).clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::TextWithPictures,
        };
    }

    if significant_color {
        let fraction_margin = ((chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS)
            / COLOR_PIXEL_FRACTION_FLOOR)
            .clamp(0.0, 1.0);
        let component_margin = (chroma
            .largest_component_pixels
            .saturating_add(CHROMA_COMPONENT_HYSTERESIS_PIXELS)
            as f64
            / SIGNIFICANT_CHROMA_COMPONENT_PIXELS as f64)
            .clamp(0.0, 1.0);
        let saturation_margin =
            (chroma.mean_saturation / (CHROMA_SATURATION_FLOOR * 3.0)).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Color,
            confidence: (0.68
                + 0.12 * fraction_margin
                + 0.12 * component_margin
                + 0.08 * saturation_margin)
                .clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::ColorChroma,
        };
    }

    if luminance.ink_fraction <= BLANK_MAX_INK_FRACTION
        && luminance.edge_fraction <= BLANK_MAX_EDGE_FRACTION
    {
        let ink_margin = (1.0 - luminance.ink_fraction / BLANK_MAX_INK_FRACTION).clamp(0.0, 1.0);
        let edge_margin = (1.0 - luminance.edge_fraction / BLANK_MAX_EDGE_FRACTION).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Bw,
            confidence: (0.8 + 0.08 * ink_margin + 0.08 * edge_margin).clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::Blank,
        };
    }

    if significant_picture && has_text {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 8.0).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Mixed,
            confidence: (0.68 + 0.18 * picture_margin + 0.14 * text_margin).clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::TextWithPictures,
        };
    }

    if significant_picture {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let tonal_margin = (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0);
        let weak_bimodality = ((STRONG_BIMODALITY - luminance.bimodality) / 0.35).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Grayscale,
            confidence: (0.66
                + 0.16 * picture_margin
                + 0.1 * tonal_margin
                + 0.08 * weak_bimodality)
                .clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::ContinuousTone,
        };
    }

    if luminance.midtone_fraction >= TONAL_MIDTONE_FRACTION
        && luminance.bimodality < STRONG_BIMODALITY
    {
        let tonal_margin = (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0);
        let weak_bimodality = ((STRONG_BIMODALITY - luminance.bimodality) / 0.35).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Grayscale,
            confidence: (0.64 + 0.22 * tonal_margin + 0.14 * weak_bimodality).clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::ContinuousTone,
        };
    }

    let confident_text = has_text
        && picture_fraction + PICTURE_HYSTERESIS < PICTURE_NOISE_FLOOR
        && luminance.bimodality >= STRONG_BIMODALITY + BIMODALITY_HYSTERESIS
        && luminance.mode_distance >= MIN_LUMINANCE_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS
        && luminance.midtone_fraction <= MAX_BW_MIDTONE_FRACTION - MIDTONE_HYSTERESIS;
    if confident_text {
        let bimodal_margin = ((luminance.bimodality - STRONG_BIMODALITY - BIMODALITY_HYSTERESIS)
            / 0.15)
            .clamp(0.0, 1.0);
        let separation_margin = ((luminance.mode_distance
            - MIN_LUMINANCE_MODE_DISTANCE
            - LUMINANCE_DISTANCE_HYSTERESIS)
            / 100.0)
            .clamp(0.0, 1.0);
        let tonal_margin = ((MAX_BW_MIDTONE_FRACTION - luminance.midtone_fraction)
            / MAX_BW_MIDTONE_FRACTION)
            .clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 10.0).clamp(0.0, 1.0);
        return OutputModeRecommendation {
            mode: OutputMode::Bw,
            confidence: (0.72
                + 0.08 * bimodal_margin
                + 0.08 * separation_margin
                + 0.06 * tonal_margin
                + 0.06 * text_margin)
                .clamp(0.0, 1.0),
            reason: OutputModeRecommendationReason::BimodalText,
        };
    }

    OutputModeRecommendation {
        mode: OutputMode::Grayscale,
        confidence: (0.52
            + 0.18 * (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0)
            + 0.1
                * ((MIN_LUMINANCE_MODE_DISTANCE - luminance.mode_distance)
                    / MIN_LUMINANCE_MODE_DISTANCE)
                    .clamp(0.0, 1.0))
        .clamp(0.0, 1.0),
        reason: OutputModeRecommendationReason::UncertainTonal,
    }
}

fn is_border_artifact_picture_component(
    picture_map: &ComponentMap,
    component: &Component,
    border_artifacts: &BinaryImage,
    analysis: &GrayImage,
    gutter_shadow: bool,
) -> bool {
    let page_width = analysis.width();
    let page_height = analysis.height();
    let width = component.right - component.left + 1;
    let height = component.bottom - component.top + 1;
    let horizontal_edge_zone = page_width.div_ceil(40).max(1);
    let vertical_edge_zone = page_height.div_ceil(40).max(1);
    let vertical_shadow = (component.top < vertical_edge_zone
        || component.bottom.saturating_add(vertical_edge_zone) >= page_height)
        && height.saturating_mul(2) >= page_height
        && height >= width.saturating_mul(4)
        && width.saturating_mul(5) <= page_width;
    let horizontal_shadow = (component.left < horizontal_edge_zone
        || component.right.saturating_add(horizontal_edge_zone) >= page_width)
        && width.saturating_mul(2) >= page_width
        && width >= height.saturating_mul(4)
        && height.saturating_mul(5) <= page_height;
    if vertical_shadow || horizontal_shadow {
        return true;
    }

    let mut overlap = 0usize;
    let mut midtones = 0usize;
    for y in component.top..=component.bottom {
        for x in component.left..=component.right {
            if picture_map.label_at(x, y) == component.label {
                overlap += usize::from(border_artifacts.get(x, y));
                midtones += usize::from((40..=224).contains(&analysis.get(x, y)));
            }
        }
    }
    if overlap >= 16 && overlap.saturating_mul(100) >= component.area {
        return true;
    }

    let touches_vertical_edge = component.top < vertical_edge_zone
        || component.bottom.saturating_add(vertical_edge_zone) >= page_height;
    let center = page_width / 2;
    let crosses_gutter = component.left <= center.saturating_add(horizontal_edge_zone)
        && component.right.saturating_add(horizontal_edge_zone) >= center;
    let page_filling = width.saturating_mul(5) >= page_width.saturating_mul(4)
        && height.saturating_mul(5) >= page_height.saturating_mul(4);
    let sparse_midtones = midtones.saturating_mul(100) <= component.area.saturating_mul(8);
    gutter_shadow && touches_vertical_edge && crosses_gutter && !page_filling && sparse_midtones
}

fn has_gutter_shadow(analysis: &GrayImage) -> bool {
    if analysis.width() <= analysis.height() || analysis.width() < 100 {
        return false;
    }
    let window_width = analysis.width().div_ceil(100).max(1);
    let column_ink = (0..analysis.width())
        .map(|x| {
            (0..analysis.height())
                .filter(|&y| analysis.get(x, y) <= BLANK_INK_LUMINANCE_CUTOFF)
                .count()
        })
        .collect::<Vec<_>>();
    let central_left = analysis.width() * 3 / 10;
    let central_right = analysis.width() * 7 / 10;
    let mut windows = (central_left..central_right.saturating_sub(window_width))
        .map(|left| {
            column_ink[left..left + window_width].iter().sum::<usize>() as f64
                / window_width.saturating_mul(analysis.height()).max(1) as f64
        })
        .collect::<Vec<_>>();
    if windows.is_empty() {
        return false;
    }
    windows.sort_unstable_by(f64::total_cmp);
    let median = windows[windows.len() / 2];
    let maximum = windows[windows.len() - 1];
    maximum >= 0.12 && maximum >= (median + 0.01) * 4.0
}

fn chroma_evidence(gray: &GrayImage, rgb: Option<&RgbImage>) -> ChromaEvidence {
    let Some(rgb) = rgb else {
        return ChromaEvidence {
            colored_fraction: 0.0,
            largest_component_pixels: 0,
            mean_saturation: 0.0,
        };
    };
    let bright_cutoff = grayscale_percentile(gray, 0.7);
    let mut background_histograms = [[0usize; 256]; 3];
    let mut background_count = 0usize;
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if gray.get(x, y) < bright_cutoff {
                continue;
            }
            let pixel = rgb.get(x, y);
            for channel in 0..3 {
                background_histograms[channel][pixel[channel] as usize] += 1;
            }
            background_count += 1;
        }
    }
    if background_count == 0 {
        return ChromaEvidence {
            colored_fraction: 0.0,
            largest_component_pixels: 0,
            mean_saturation: 0.0,
        };
    }
    let background = background_histograms
        .map(|histogram| histogram_percentile(&histogram, background_count / 2).max(1) as f64);
    let background_mean = background.iter().sum::<f64>() / 3.0;
    let mut colored = 0usize;
    let mut saturation_sum = 0.0;
    let mut chroma_mask = BinaryImage::new(gray.width(), gray.height());
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let pixel = rgb.get(x, y);
            let dark_ink = gray.get(x, y) <= DARK_LUMINANCE_CUTOFF;
            let compared = if dark_ink {
                pixel.map(f64::from)
            } else {
                [
                    f64::from(pixel[0]) * background_mean / background[0],
                    f64::from(pixel[1]) * background_mean / background[1],
                    f64::from(pixel[2]) * background_mean / background[2],
                ]
            };
            let minimum = compared.iter().copied().fold(f64::INFINITY, f64::min);
            let maximum = compared.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let chroma = maximum - minimum;
            let saturation = chroma / maximum.max(1.0);
            let noise_floor = if dark_ink {
                DARK_CHROMA_NOISE_FLOOR
            } else {
                CHROMA_NOISE_FLOOR
            };
            if chroma >= noise_floor && saturation >= CHROMA_SATURATION_FLOOR {
                colored += 1;
                saturation_sum += saturation;
                chroma_mask.set(x, y, true);
            }
        }
    }
    let largest_component_pixels = ComponentMap::from_binary(&chroma_mask)
        .components()
        .iter()
        .map(|component| component.area)
        .max()
        .unwrap_or(0);
    ChromaEvidence {
        colored_fraction: colored as f64 / gray.width().saturating_mul(gray.height()).max(1) as f64,
        largest_component_pixels,
        mean_saturation: saturation_sum / colored.max(1) as f64,
    }
}

fn luminance_evidence(image: &GrayImage) -> LuminanceEvidence {
    let mut histogram = [0u64; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let total = histogram.iter().sum::<u64>().max(1);
    let mean = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| value as f64 * *count as f64)
        .sum::<f64>()
        / total as f64;
    let total_variance = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| {
            let difference = value as f64 - mean;
            difference * difference * *count as f64
        })
        .sum::<f64>();
    let threshold = otsu_threshold(image) as usize;
    let dark_count = histogram[..threshold].iter().sum::<u64>();
    let light_count = total.saturating_sub(dark_count);
    let dark_mean = if dark_count == 0 {
        0.0
    } else {
        histogram[..threshold]
            .iter()
            .enumerate()
            .map(|(value, count)| value as f64 * *count as f64)
            .sum::<f64>()
            / dark_count as f64
    };
    let light_mean = if light_count == 0 {
        255.0
    } else {
        histogram[threshold..]
            .iter()
            .enumerate()
            .map(|(offset, count)| (threshold + offset) as f64 * *count as f64)
            .sum::<f64>()
            / light_count as f64
    };
    let between_variance =
        dark_count as f64 * light_count as f64 / total as f64 * (dark_mean - light_mean).powi(2);
    let lower = (dark_mean + 18.0).clamp(0.0, 255.0);
    let upper = (light_mean - 18.0).clamp(0.0, 255.0);
    let midtone_count = if lower < upper {
        histogram[lower.ceil() as usize..=upper.floor() as usize]
            .iter()
            .sum::<u64>()
    } else {
        0
    };
    let ink_count = histogram[..=BLANK_INK_LUMINANCE_CUTOFF as usize]
        .iter()
        .sum::<u64>();
    let mut strong_edges = 0usize;
    let mut edge_comparisons = 0usize;
    for y in 0..image.height() {
        for x in 0..image.width() {
            let value = image.get(x, y);
            if x > 0 {
                strong_edges +=
                    usize::from(value.abs_diff(image.get(x - 1, y)) >= BLANK_EDGE_DIFFERENCE);
                edge_comparisons += 1;
            }
            if y > 0 {
                strong_edges +=
                    usize::from(value.abs_diff(image.get(x, y - 1)) >= BLANK_EDGE_DIFFERENCE);
                edge_comparisons += 1;
            }
        }
    }
    LuminanceEvidence {
        bimodality: if total_variance <= f64::EPSILON {
            0.0
        } else {
            (between_variance / total_variance).clamp(0.0, 1.0)
        },
        midtone_fraction: midtone_count as f64 / total as f64,
        mode_distance: light_mean - dark_mean,
        ink_fraction: ink_count as f64 / total as f64,
        edge_fraction: strong_edges as f64 / edge_comparisons.max(1) as f64,
    }
}

fn grayscale_percentile(image: &GrayImage, percentile: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let rank = (image.width().saturating_mul(image.height()) as f64 * percentile).floor() as usize;
    histogram_percentile(&histogram, rank)
}

fn histogram_percentile(histogram: &[usize; 256], rank: usize) -> u8 {
    let mut cumulative = 0usize;
    for (value, count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative > rank {
            return value as u8;
        }
    }
    255
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::render::analyze_page_with_color_and_document_prior;
    use crate::CleanupOptions;
    use crate::{
        calibration::{CalibrationConfig, PageCalibration},
        picture::detect_picture_mask,
    };

    fn text_page(background: [u8; 3]) -> (GrayImage, RgbImage) {
        let mut rgb = RgbImage::new(360, 260, background);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            let value = [35, 32, 28];
                            rgb.set(x, y, value);
                        }
                    }
                }
            }
        }
        (rgb_to_gray(&rgb), rgb)
    }

    fn rgb_to_gray(rgb: &RgbImage) -> GrayImage {
        let mut gray = GrayImage::new(rgb.width(), rgb.height(), 255);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let pixel = rgb.get(x, y);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        gray
    }

    fn auto_options() -> CleanupOptions {
        CleanupOptions {
            output_mode: OutputMode::Auto,
            dpi: 150.0,
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        }
    }

    fn classify(gray: &GrayImage, rgb: Option<&RgbImage>) -> OutputModeRecommendation {
        analyze_page_with_color_and_document_prior(gray, rgb, &auto_options(), None)
            .unwrap()
            .output_mode_recommendation
            .expect("automatic mode emits a recommendation")
    }

    fn report(label: &str, recommendation: OutputModeRecommendation) {
        println!(
            "CLASSIFICATION_MATRIX\t{label}\t{:?}\t{:.6}\t{:?}",
            recommendation.mode, recommendation.confidence, recommendation.reason
        );
    }

    #[test]
    fn near_blank_flyleaf_is_explicitly_clean_bw() {
        let mut gray = GrayImage::new(620, 877, 190);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                gray.set(x, y, 187 + ((x * 7 + y * 11) % 7) as u8);
            }
        }
        for y in 20..24 {
            for x in 20..28 {
                gray.set(x, y, 145);
            }
        }
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            text_line_count: 0,
        });
        report("blank-flyleaf", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Bw);
        assert_eq!(recommendation.reason, OutputModeRecommendationReason::Blank);
        assert!(recommendation.confidence >= 0.8);
    }

    #[test]
    fn recommends_bw_for_text_and_ignores_yellowed_paper_tint() {
        for background in [[245, 245, 245], [244, 226, 176]] {
            let (gray, rgb) = text_page(background);
            let recommendation = classify(&gray, Some(&rgb));
            if background == [244, 226, 176] {
                report("yellowed-black-ink", recommendation);
            }
            assert_eq!(
                recommendation.mode,
                OutputMode::Bw,
                "{background:?}: {recommendation:?}"
            );
            assert!(recommendation.confidence >= 0.75);
        }
    }

    #[test]
    fn hollow_red_seal_on_text_page_is_color() {
        let (_, mut rgb) = text_page([245; 3]);
        let center = (290_i32, 170_i32);
        for y in 135..205 {
            for x in 255..325 {
                let distance_squared = (x as i32 - center.0).pow(2) + (y as i32 - center.1).pow(2);
                if (28_i32.pow(2)..=34_i32.pow(2)).contains(&distance_squared) {
                    rgb.set(x, y, [150, 25, 32]);
                }
            }
        }
        let gray = rgb_to_gray(&rgb);
        let recommendation = classify(&gray, Some(&rgb));
        report("hollow-seal-small", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color);
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn a4_hollow_seal_qualifies_only_through_its_connected_component() {
        let mut rgb = RgbImage::new(1_240, 1_754, [245; 3]);
        for row in 0..18 {
            for column in 0..24 {
                let left = 80 + column * 42;
                let top = 90 + row * 76;
                for y in top..top + 18 {
                    for x in left..left + 20 {
                        if x < left + 3 || y < top + 3 || y >= top + 15 {
                            rgb.set(x, y, [35, 32, 28]);
                        }
                    }
                }
            }
        }
        let center = (1_070_i32, 1_520_i32);
        for y in 1_475..1_565 {
            for x in 1_025..1_115 {
                let distance_squared = (x as i32 - center.0).pow(2) + (y as i32 - center.1).pow(2);
                if (36_i32.pow(2)..=41_i32.pow(2)).contains(&distance_squared) {
                    rgb.set(x, y, [150, 25, 32]);
                }
            }
        }
        let gray = rgb_to_gray(&rgb);
        let chroma = chroma_evidence(&gray, Some(&rgb));
        assert!(
            chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS < COLOR_PIXEL_FRACTION_FLOOR,
            "{chroma:?}"
        );
        assert!(
            chroma.largest_component_pixels >= SIGNIFICANT_CHROMA_COMPONENT_PIXELS,
            "{chroma:?}"
        );
        let recommendation = classify(&gray, Some(&rgb));
        report("hollow-seal-a4-component-only", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color, "{recommendation:?}");
    }

    #[test]
    fn dark_blue_stamp_on_text_page_is_color() {
        let (_, mut rgb) = text_page([245; 3]);
        for y in 150..175 {
            for x in 255..285 {
                rgb.set(x, y, [5, 18, 55]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let recommendation = classify(&gray, Some(&rgb));
        report("dark-blue-stamp", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn pale_blue_stock_with_dark_blue_ink_is_color_but_black_ink_on_yellow_stock_is_bw() {
        let mut blue_stock = RgbImage::new(360, 260, [205, 225, 245]);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            blue_stock.set(x, y, [12, 32, 76]);
                        }
                    }
                }
            }
        }
        let blue_recommendation = classify(&rgb_to_gray(&blue_stock), Some(&blue_stock));
        report("pale-blue-stock-dark-blue-ink", blue_recommendation);
        assert_eq!(
            blue_recommendation.mode,
            OutputMode::Color,
            "{blue_recommendation:?}"
        );

        let (yellow_gray, yellow_stock) = text_page([244, 226, 176]);
        let yellow_recommendation = classify(&yellow_gray, Some(&yellow_stock));
        assert_eq!(
            yellow_recommendation.mode,
            OutputMode::Bw,
            "{yellow_recommendation:?}"
        );
    }

    #[test]
    fn dark_jpeg_chroma_noise_stays_bw_below_36_and_qualifies_at_36() {
        let (gray, mut below_boundary) = text_page([245; 3]);
        for y in 155..180 {
            for x in 250..282 {
                let wobble = ((x * 13 + y * 17) % 4) as u8;
                below_boundary.set(x, y, [10 + wobble, 10, 45]);
            }
        }
        let below_gray = rgb_to_gray(&below_boundary);
        let below = classify(&below_gray, Some(&below_boundary));
        report("jpeg-dark-chroma-35", below);
        assert_eq!(below.mode, OutputMode::Bw, "{below:?}");

        let mut at_boundary = below_boundary;
        for y in 155..180 {
            for x in 250..282 {
                at_boundary.set(x, y, [10, 10, 46]);
            }
        }
        let at_boundary_gray = rgb_to_gray(&at_boundary);
        let at_boundary_recommendation = classify(&at_boundary_gray, Some(&at_boundary));
        report("jpeg-dark-chroma-36", at_boundary_recommendation);
        assert_eq!(
            at_boundary_recommendation.mode,
            OutputMode::Color,
            "{at_boundary_recommendation:?}; baseline={:?}",
            classify(&gray, None)
        );
    }

    #[test]
    fn recommends_grayscale_for_a_photo_like_page() {
        let mut gray = GrayImage::new(360, 260, 255);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let gradient = 28 + (x * 176 / gray.width()) as u8;
                let texture = ((x * 17 + y * 29 + x * y % 53) % 45) as u8;
                gray.set(x, y, gradient.saturating_add(texture));
            }
        }
        let recommendation = classify(&gray, None);
        report("photo-like-page", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Grayscale);
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ContinuousTone
        );
    }

    #[test]
    fn ten_percent_photo_vetoes_bw_and_keeps_text_page_mixed() {
        let (mut gray, _) = text_page([245; 3]);
        for y in 135..230 {
            for x in 255..345 {
                gray.set(x, y, 35 + ((x * 11 + y * 7 + x * y % 41) % 190) as u8);
            }
        }
        let recommendation = classify(&gray, None);
        report("ten-percent-photo", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
    }

    #[test]
    fn color_plate_with_caption_routes_to_mixed_while_a_color_cover_stays_color() {
        let (_, mut plate_page) = text_page([245; 3]);
        for y in 125..235 {
            for x in 225..345 {
                let red = 35 + ((x * 11 + y * 7) % 190) as u8;
                let green = 25 + ((x * 3 + y * 17) % 150) as u8;
                let blue = 80 + ((x * 19 + y * 5) % 170) as u8;
                plate_page.set(x, y, [red, green, blue]);
            }
        }
        let plate_recommendation = classify(&rgb_to_gray(&plate_page), Some(&plate_page));
        report("color-plate-with-caption", plate_recommendation);
        assert_eq!(
            plate_recommendation.mode,
            OutputMode::Mixed,
            "{plate_recommendation:?}"
        );
        assert_eq!(
            plate_recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );

        let mut cover = RgbImage::new(360, 260, [28, 74, 132]);
        for y in 0..cover.height() {
            for x in 0..cover.width() {
                cover.set(
                    x,
                    y,
                    [
                        20 + ((x * 5 + y * 3) % 210) as u8,
                        35 + ((x * 7 + y * 11) % 180) as u8,
                        45 + ((x * 13 + y * 17) % 170) as u8,
                    ],
                );
            }
        }
        let cover_recommendation = classify(&rgb_to_gray(&cover), Some(&cover));
        report("pure-color-cover", cover_recommendation);
        assert_eq!(
            cover_recommendation.mode,
            OutputMode::Color,
            "{cover_recommendation:?}"
        );
        assert_eq!(
            cover_recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn scanner_edge_bars_and_gutter_shadow_do_not_veto_bw() {
        let (_, half_page) = text_page([245; 3]);
        let mut rgb = RgbImage::new(760, 300, [245; 3]);
        for y in 0..half_page.height() {
            for x in 0..half_page.width() {
                rgb.set(x + 10, y + 20, half_page.get(x, y));
                rgb.set(x + 390, y + 20, half_page.get(x, y));
            }
        }
        for y in 0..rgb.height() {
            for x in 0..10 {
                rgb.set(x, y, [18; 3]);
                rgb.set(rgb.width() - 1 - x, y, [18; 3]);
            }
            for x in 370_usize..390 {
                let distance = x.abs_diff(379).min(8) as u8;
                let texture = ((x * 17 + y * 29 + x * y % 31) % 28) as u8;
                let value = 34_u8
                    .saturating_add(distance.saturating_mul(12))
                    .saturating_add(texture);
                rgb.set(x, y, [value; 3]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let calibration = PageCalibration::estimate(&gray, 150.0, CalibrationConfig::default());
        let raw_picture_mask = detect_picture_mask(&gray, 150.0, calibration);
        let raw_picture_pixels = ComponentMap::from_binary(&raw_picture_mask)
            .components()
            .iter()
            .filter(|component| component.area >= MIN_PICTURE_COMPONENT_PIXELS)
            .map(|component| component.area)
            .sum::<usize>();
        assert!(
            raw_picture_pixels as f64 / gray.width().saturating_mul(gray.height()) as f64
                >= PICTURE_NOISE_FLOOR,
            "fixture must exercise the aggregate picture veto"
        );

        let recommendation = classify(&gray, Some(&rgb));
        report("scanner-border-and-gutter", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Bw, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::BimodalText
        );
    }

    #[test]
    fn full_page_halftone_plate_touching_edges_stays_tonal() {
        let mut gray = GrayImage::new(360, 260, 238);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let coarse_tone = 28 + (x * 176 / gray.width()) as u8;
                let irregular_screen = ((x * 17 + y * 29 + x * y % 53) % 45) as u8;
                gray.set(x, y, coarse_tone.saturating_add(irregular_screen));
            }
        }
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 0..picture_mask.height() {
            for x in 0..picture_mask.width() {
                picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            text_line_count: 0,
        });
        report("full-page-edge-halftone", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
    }

    #[test]
    fn aggregate_of_many_small_picture_components_vetoes_bw() {
        let (small_gray, _) = text_page([245; 3]);
        let mut gray = GrayImage::new(1_240, 1_754, 245);
        for y in 0..small_gray.height() {
            for x in 0..small_gray.width() {
                gray.set(x + 40, y + 40, small_gray.get(x, y));
            }
        }
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for thumbnail in 0..7 {
            let left = 80 + (thumbnail % 4) * 260;
            let top = 520 + (thumbnail / 4) * 260;
            for y in top..top + 80 {
                for x in left..left + 50 {
                    picture_mask.set(x, y, true);
                }
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            text_line_count: 8,
        });
        report("many-small-pictures", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
    }

    #[test]
    fn faint_pencil_text_is_grayscale_despite_bimodality() {
        let (mut gray, _) = text_page([235; 3]);
        for value in gray.data_mut() {
            if *value < 230 {
                *value = 215;
            }
        }
        let recommendation = classify(&gray, None);
        report("faint-pencil", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::UncertainTonal
        );
    }

    #[test]
    fn textless_halftone_page_is_grayscale_not_mixed() {
        let mut gray = GrayImage::new(360, 260, 238);
        for y in 25..235 {
            for x in 30..330 {
                let cell = (x / 4 + y / 4) % 7;
                if x % 4 < 1 + cell % 2 && y % 4 < 1 + (cell / 2) % 2 {
                    gray.set(x, y, 35 + (cell * 18) as u8);
                }
            }
        }
        let recommendation = classify(&gray, None);
        report("halftone", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::UncertainTonal
        );
    }
}
