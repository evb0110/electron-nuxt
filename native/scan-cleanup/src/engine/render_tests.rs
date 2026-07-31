mod tests {
    use super::*;
    use crate::bw::binarize_normalized;
    use jpeg_encoder::{ColorType, Encoder as JpegEncoder, SamplingFactor};
    use std::io::Cursor;
    use zune_jpeg::{
        zune_core::{colorspace::ColorSpace, options::DecoderOptions},
        JpegDecoder,
    };

    fn jpeg_luma_roundtrip(source: &GrayImage, quality: u8) -> GrayImage {
        let width = u16::try_from(source.width()).unwrap();
        let height = u16::try_from(source.height()).unwrap();
        let mut encoded = Vec::new();
        let mut encoder = JpegEncoder::new(&mut encoded, quality);
        encoder.set_sampling_factor(SamplingFactor::F_1_1);
        encoder
            .encode(source.data(), width, height, ColorType::Luma)
            .unwrap();
        let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::Luma);
        let mut decoder = JpegDecoder::new_with_options(Cursor::new(encoded), options);
        let decoded = decoder.decode().unwrap();
        assert_eq!(decoded.len(), source.width() * source.height());
        GrayImage::from_vec(source.width(), source.height(), source.width(), decoded).unwrap()
    }

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
        .into_gray()
    }

    #[test]
    fn affine_fast_paths_and_adaptive_resampler_match_supersampled_golden() {
        let (source, _) = thin_stroke_fixture();
        assert_eq!(
            render_affine_gray(&source, source.width(), source.height(), Affine::IDENTITY),
            source
        );

        let translated = render_affine_gray(
            &source,
            source.width() - 13,
            source.height() - 9,
            Affine::translation(13.0, 9.0),
        );
        for y in 0..translated.height() {
            for x in 0..translated.width() {
                assert_eq!(translated.get(x, y), source.get(x + 13, y + 9));
            }
        }

        let cx = source.width() as f64 * 0.5;
        let cy = source.height() as f64 * 0.5;
        let inverse = Affine::translation(-cx, -cy)
            .then(Affine::rotation_radians(2.7_f64.to_radians()))
            .then(Affine::translation(cx, cy));
        let actual = render_affine_gray(&source, source.width(), source.height(), inverse);
        let reference = render_affine_gray_supersampled_reference(
            &source,
            source.width(),
            source.height(),
            inverse,
        );
        let mut differences = actual
            .data()
            .iter()
            .zip(reference.data())
            .map(|(&left, &right)| left.abs_diff(right))
            .collect::<Vec<_>>();
        differences.sort_unstable();
        let mean = differences
            .iter()
            .map(|&value| f64::from(value))
            .sum::<f64>()
            / differences.len() as f64;
        let p99 = differences[differences.len() * 99 / 100];
        let threshold_mismatches = actual
            .data()
            .iter()
            .zip(reference.data())
            .filter(|(left, right)| (**left < 128) != (**right < 128))
            .count();
        assert!(mean <= 1.5, "mean absolute error={mean:.4}");
        assert!(p99 <= 12, "p99 absolute error={p99}");
        assert!(
            threshold_mismatches * 1_000 <= actual.data().len() * 5,
            "threshold mismatch ratio={:.4}",
            threshold_mismatches as f64 / actual.data().len() as f64
        );
    }

    #[test]
    fn full_cleanup_stays_within_stage_b_supersampling_golden_tolerance() {
        let (source, _) = thin_stroke_fixture();
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: crate::BinarizationMode::Wolf,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let normalized = normalize_illumination(&source, options.dpi);
        let deskew = detect_skew(&normalized, options.dpi);
        let inverse = deskew_transform(normalized.width(), normalized.height(), deskew)
            .inverse()
            .unwrap();
        let stage_b_render = render_affine_gray_supersampled_reference(
            &normalized,
            normalized.width(),
            normalized.height(),
            inverse,
        );
        let stage_b_golden = binary_to_gray(&binarize_normalized(&stage_b_render, &options).0);
        let actual = clean_page(&source, &options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .into_gray();
        let mismatches = actual
            .data()
            .iter()
            .zip(stage_b_golden.data())
            .filter(|(left, right)| left != right)
            .count();
        let ratio = mismatches as f64 / actual.data().len() as f64;
        assert!(ratio <= 0.001, "binary mismatch ratio={ratio:.6}");
    }

    #[test]
    fn reused_analysis_otsu_is_bit_exact_to_independent_final_binarization() {
        let mut source = GrayImage::new(513, 377, 242);
        let mut state = 0x84b5_13d9_u64;
        for y in 0..source.height() {
            for x in 0..source.width() {
                state = state
                    .wrapping_mul(2_862_933_555_777_941_757)
                    .wrapping_add(3_037_000_493);
                let noise = ((state >> 60) as i16 - 8).clamp(-8, 7);
                let value = (242_i16 + noise).clamp(0, 255) as u8;
                source.set(x, y, value);
            }
        }
        for y in (40..340).step_by(19) {
            for x in 38..475 {
                source.set(x, y, 24);
                source.set(x, y + 1, 24);
            }
        }
        let options = CleanupOptions {
            dpi: 150.0,
            normalize_illumination: false,
            binarization: crate::BinarizationMode::Otsu,
            thickness: 0,
            crop_content: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Auto,
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let prepared = prepare_analysis_page(
            &source,
            None,
            &options,
            true,
            PageRenderPolicy::COMPLETE,
            None,
            CalibrationConfig::default(),
            None,
            &mut timings,
        );
        assert_eq!(
            prepared.split.classification,
            LayoutClassification::SingleUncutPage
        );
        assert!(prepared.split.reusable_binary.is_some());
        let expected = binary_to_gray(&binarize_normalized(&source, &options).0);
        let actual = clean_page(&source, &options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .into_gray();
        assert_eq!(actual, expected);
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
        for y in 4..196 {
            source.set(159, y, 105);
            source.set(160, y, 175);
        }
        source
    }

    fn draw_display_glyphs(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        width: usize,
        height: usize,
        gap: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * (width + gap);
            for y in top..top + height {
                for x in glyph_left..glyph_left + width {
                    if x < glyph_left + 3
                        || x + 3 >= glyph_left + width
                        || y < top + 3
                        || y + 3 >= top + height
                    {
                        image.set(x, y, 24);
                    }
                }
            }
        }
    }

    fn page_seven_trim_twin() -> GrayImage {
        let mut source = GrayImage::new(620, 760, 245);
        for y in 28..38 {
            for x in 32..588 {
                source.set(x, y, 16);
            }
        }
        for y in 44..62 {
            for x in 286..304 {
                source.set(x, y, 20);
            }
        }
        for panel in 0..4 {
            let left = 150 + panel * 74;
            for y in 132..280 {
                for x in left..left + 52 {
                    let texture = (x * 17 + y * 11 + panel * 23 + x * y % 47) % 165;
                    source.set(x, y, 45 + texture as u8);
                }
            }
        }
        draw_display_glyphs(&mut source, 226, 342, 8, 11, 24, 6);
        for row in 0..16 {
            let top = 408 + row * 19;
            draw_display_glyphs(&mut source, 62, top, 14, 6, 10, 4);
            draw_display_glyphs(&mut source, 330, top, 14, 6, 10, 4);
        }
        source
    }

    fn dark_pixels_in_source_rect(output: &CleanupResult, source_rect: Rect) -> usize {
        let crop = output.metadata.crop_rect;
        let left = (source_rect.x - crop.x).floor().max(0.0) as usize;
        let top = (source_rect.y - crop.y).floor().max(0.0) as usize;
        let right = (source_rect.right() - crop.x)
            .ceil()
            .clamp(0.0, output.image.width() as f64) as usize;
        let bottom = (source_rect.bottom() - crop.y)
            .ceil()
            .clamp(0.0, output.image.height() as f64) as usize;
        (top..bottom)
            .flat_map(|y| (left..right).map(move |x| (x, y)))
            .filter(|&(x, y)| output.image.get(x, y) < 224)
            .count()
    }

    #[test]
    fn page_seven_twin_protects_picture_and_heading_in_every_output_mode() {
        let source = page_seven_trim_twin();
        for output_mode in [OutputMode::Auto, OutputMode::Mixed, OutputMode::Bw] {
            let output = clean_page(
                &source,
                &CleanupOptions {
                    dpi: 150.0,
                    output_mode,
                    crop_content: true,
                    normalize_illumination: false,
                    layout: crate::LayoutMode::Single,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    ..CleanupOptions::default()
                },
                6,
            )
            .unwrap()
            .outputs
            .remove(0);
            let content = output.metadata.content_box.unwrap();
            assert!(
                content.y <= 132.0 && content.bottom() >= 703.0,
                "mode={output_mode:?} content={content:?} diagnostics={:?}",
                output.metadata.content_diagnostics
            );
            assert!(
                output.metadata.crop_rect.y <= 132.0,
                "mode={output_mode:?} crop={:?}",
                output.metadata.crop_rect
            );
            let diagnostics = output.metadata.content_diagnostics.as_ref().unwrap();
            assert!(
                diagnostics
                    .protected_blocks
                    .iter()
                    .any(|block| block.picture_mask_overlap_pixels > 0),
                "mode={output_mode:?} missing picture evidence: {diagnostics:?}"
            );
            assert!(
                diagnostics
                    .protected_blocks
                    .iter()
                    .any(|block| block.heading_evidence),
                "mode={output_mode:?} missing heading evidence: {diagnostics:?}"
            );
            assert!(
                dark_pixels_in_source_rect(&output, Rect::new(150.0, 132.0, 274.0, 148.0),) > 2_500,
                "mode={output_mode:?} illustration pixels were cropped"
            );
            assert!(
                dark_pixels_in_source_rect(&output, Rect::new(226.0, 342.0, 130.0, 24.0),) > 250,
                "mode={output_mode:?} heading pixels were cropped"
            );
        }
    }

    fn single_page_fixture() -> GrayImage {
        let mut source = GrayImage::new(180, 280, 245);
        for y in (32..248).step_by(16) {
            for word in 0..7 {
                for x in 22 + word * 19..(34 + word * 19).min(158) {
                    source.set(x, y, 20);
                    source.set(x, y + 1, 20);
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

    fn ink_bounds(image: &GrayImage, threshold: u8) -> Option<(usize, usize, usize, usize)> {
        let mut bounds: Option<(usize, usize, usize, usize)> = None;
        for y in 0..image.height() {
            for x in 0..image.width() {
                if image.get(x, y) >= threshold {
                    continue;
                }
                bounds = Some(match bounds {
                    None => (x, y, x, y),
                    Some((left, top, right, bottom)) => {
                        (left.min(x), top.min(y), right.max(x), bottom.max(y))
                    }
                });
            }
        }
        bounds
    }

    fn rotated_text_page(angle_degrees: f64) -> GrayImage {
        let mut source = GrayImage::new(360, 280, 255);
        for line in 0..11 {
            let top = 52 + line * 16;
            for word in 0..8 {
                let left = 62 + word * 30 + line % 3;
                for y in top..top + 4 {
                    for x in left..left + 21 {
                        source.set(x, y, 20);
                    }
                }
            }
        }
        let mut rotated = GrayImage::new(source.width(), source.height(), 255);
        let angle = angle_degrees.to_radians();
        let (sine, cosine) = angle.sin_cos();
        let cx = source.width() as f64 * 0.5;
        let cy = source.height() as f64 * 0.5;
        for y in 0..rotated.height() {
            for x in 0..rotated.width() {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let source_x = cosine * dx + sine * dy + cx;
                let source_y = -sine * dx + cosine * dy + cy;
                if source_x >= 0.0
                    && source_y >= 0.0
                    && source_x < source.width() as f64
                    && source_y < source.height() as f64
                {
                    rotated.set(
                        x,
                        y,
                        source.get(
                            source_x.round().min((source.width() - 1) as f64) as usize,
                            source_y.round().min((source.height() - 1) as f64) as usize,
                        ),
                    );
                }
            }
        }
        rotated
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
        // The identity affine path now preserves source samples exactly instead of
        // receiving the old 4x4 resampler's incidental blur. The deliberately
        // sub-threshold curve still retains more than 95% local connectivity.
        assert!(
            connectivity >= 0.95,
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
            .to_gray()
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
        assert!(!colored.outputs[0].metadata.illumination_normalized);
        let color_image = colored.outputs[0].color_image.as_ref().unwrap();
        assert_eq!(color_image, &color);
        let patch = color_image.get(60, 45);
        assert!(patch[0] > 180 && patch[0] > patch[1] * 3 && patch[0] > patch[2] * 3);
    }

    #[test]
    fn color_normalization_whitens_tinted_paper_and_preserves_independent_chroma() {
        let mut gray = GrayImage::new(180, 120, 240);
        let mut color = RgbImage::new(180, 120, [240, 168, 96]);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let background = 135 + x * 105 / (gray.width() - 1);
                gray.set(x, y, background as u8);
                color.set(
                    x,
                    y,
                    [
                        background as u8,
                        (background * 7 / 10) as u8,
                        (background * 2 / 5) as u8,
                    ],
                );
            }
        }
        for y in 46..74 {
            for x in 54..126 {
                gray.set(x, y, 67);
                color.set(x, y, [25, 70, 185]);
            }
        }
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                normalize_illumination: true,
                output_mode: OutputMode::Color,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert!(output.metadata.illumination_normalized);
        let output = output.color_image.unwrap();
        let shadow_paper = output.get(12, 20);
        let bright_paper = output.get(168, 20);

        for channel in 0..3 {
            assert!(
                shadow_paper[channel].abs_diff(bright_paper[channel]) <= 12,
                "channel={channel} shadow={shadow_paper:?} bright={bright_paper:?}"
            );
        }
        assert!(
            shadow_paper.iter().all(|&channel| channel >= 248),
            "tinted paper was not mapped to white: {shadow_paper:?}"
        );
        let colored_patch = output.get(90, 60);
        assert!(
            colored_patch[2] > colored_patch[1]
                && colored_patch[2] > colored_patch[0].saturating_mul(2),
            "independent blue content lost its hue: {colored_patch:?}"
        );
    }

    #[test]
    fn auto_color_abstention_keeps_continuous_tone_pixels_unnormalized() {
        let mut gray = GrayImage::new(320, 220, 0);
        let mut color = RgbImage::new(320, 220, [0; 3]);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = [
                    ((x * 5 + y * 2) % 256) as u8,
                    ((x * 2 + y * 7 + 41) % 256) as u8,
                    ((x * 11 + y * 3 + 89) % 256) as u8,
                ];
                color.set(x, y, pixel);
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
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Auto,
                normalize_illumination: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.output_mode, OutputMode::Color);
        assert!(!output.metadata.illumination_normalized);
        assert_eq!(output.color_image.as_ref(), Some(&color));
    }

    #[test]
    fn color_dewarp_matches_grayscale_geometry_and_preserves_hue() {
        let mut gray = GrayImage::new(140, 100, 245);
        let mut color = RgbImage::new(140, 100, [245; 3]);
        for y in 24..76 {
            for x in 34..106 {
                gray.set(x, y, 91);
                color.set(x, y, [220, 35, 45]);
            }
        }
        let dewarp = crate::DewarpOptions {
            top_curve: vec![
                Point::new(0.0, 8.0),
                Point::new(70.0, 0.0),
                Point::new(140.0, 8.0),
            ],
            bottom_curve: vec![
                Point::new(0.0, 92.0),
                Point::new(70.0, 100.0),
                Point::new(140.0, 92.0),
            ],
            depth: 0.15,
        };
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            dewarp: Some(dewarp),
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
        .unwrap()
        .outputs
        .remove(0);
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let color_image = colored.color_image.unwrap();
        let mut color_luminance = GrayImage::new(color_image.width(), color_image.height(), 255);
        for y in 0..color_image.height() {
            for x in 0..color_image.width() {
                let pixel = color_image.get(x, y);
                color_luminance.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 299
                        + u32::from(pixel[1]) * 587
                        + u32::from(pixel[2]) * 114)
                        / 1000) as u8,
                );
            }
        }
        assert_eq!(
            ink_bounds(&color_luminance, 220),
            ink_bounds(&grayscale.image.to_gray(), 220)
        );
        let patch = color_image.get(70, 50);
        assert!(patch[0] > 180 && patch[0] > patch[1] * 3 && patch[0] > patch[2] * 3);
        assert!(colored.metadata.dewarp_mapping.is_some());
        assert_eq!(
            colored.metadata.dewarp_mapping,
            grayscale.metadata.dewarp_mapping
        );
    }

    #[test]
    fn deskewed_content_crop_keeps_symmetric_margins_without_clipping_ink() {
        let source = rotated_text_page(3.0);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: true,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([14.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert!(
            output.metadata.skew_applied,
            "metadata={:?}",
            output.metadata.detected_skew_degrees
        );
        assert!((output.metadata.detected_skew_degrees - 3.0).abs() < 0.2);
        let image = output.image.to_gray();
        let (left, top, right, bottom) = ink_bounds(&image, 128).unwrap();
        let right_margin = image.width() - 1 - right;
        let bottom_margin = image.height() - 1 - bottom;
        assert!(left >= 12 && top >= 12 && right_margin >= 12 && bottom_margin >= 12);
        assert!(
            left.abs_diff(right_margin) <= 2,
            "left={left} right={right_margin}"
        );
        assert!(
            top.abs_diff(bottom_margin) <= 2,
            "top={top} bottom={bottom_margin}"
        );
        assert!(image.data()[..image.width()]
            .iter()
            .all(|&value| value == 255));
        assert!(image.data()[image.data().len() - image.width()..]
            .iter()
            .all(|&value| value == 255));
    }

    #[test]
    fn manual_skew_bypasses_detection_and_is_reported_additively() {
        let source = GrayImage::new(240, 180, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                manual_skew_degrees: Some(4.2),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.detected_skew_degrees, 4.2);
        assert!(output.metadata.skew_applied);
        assert!(output.metadata.manual_skew);
        assert_eq!(
            serde_json::to_value(&output.metadata).unwrap()["manualSkew"],
            true
        );
    }

    #[test]
    fn no_deskew_evidence_serializes_zeroes_and_omits_manual_skew() {
        let source = GrayImage::new(240, 180, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.detected_skew_degrees, 0.0);
        assert_eq!(output.metadata.skew_confidence, 0.0);
        assert!(!output.metadata.skew_applied);
        assert!(!output.metadata.manual_skew);
        let serialized = serde_json::to_value(&output.metadata).unwrap();
        assert_eq!(serialized["detectedSkewDegrees"], 0.0);
        assert_eq!(serialized["skewConfidence"], 0.0);
        assert_eq!(serialized["skewApplied"], false);
        assert!(serialized.get("manualSkew").is_none());
    }

    #[test]
    fn deskew_dewarp_and_crop_share_one_composed_mapping() {
        let source = rotated_text_page(3.0);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: true,
                margins_mm: None,
                margins_pixels: Some([14.0; 4]),
                layout: crate::LayoutMode::Single,
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![
                        Point::new(0.0, 0.0),
                        Point::new(180.0, 14.0),
                        Point::new(360.0, 0.0),
                    ],
                    bottom_curve: vec![
                        Point::new(0.0, 280.0),
                        Point::new(180.0, 266.0),
                        Point::new(360.0, 280.0),
                    ],
                    depth: 0.08,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.metadata.detected_skew_degrees.abs() > 2.5);
        assert!(output.metadata.skew_applied);
        assert!(output.metadata.content_box.is_some());
        assert_eq!(output.metadata.applied_margins, [14.0; 4].into());
        assert!(output.image.width() < 360 && output.image.height() < 280);
        assert_eq!(output.metadata.resample_passes, 1);

        let grid = output.metadata.dewarp_mapping.unwrap();
        assert_eq!((grid.columns, grid.rows), (17, 17));
        assert_eq!(
            (grid.output_width, grid.output_height),
            (output.image.width(), output.image.height())
        );
        assert!(grid.output_origin.x > 0.0 && grid.output_origin.y > 0.0);
        assert_eq!(grid.output_origin.x, output.metadata.crop_rect.x);
        assert_eq!(grid.output_origin.y, output.metadata.crop_rect.y);
        assert_eq!(
            grid.output_width,
            output.metadata.crop_rect.width.ceil() as usize
        );
        assert_eq!(
            grid.output_height,
            output.metadata.crop_rect.height.ceil() as usize
        );
        let first_source = grid.output_to_source[0];
        assert!(first_source.x > 0.0 && first_source.y > 0.0);
        let center_source = grid.output_to_source[8 * 17 + 8];
        let center_output = grid.source_to_output[8 * 17 + 8];
        assert!(center_source.x.is_finite() && center_source.y.is_finite());
        assert!(center_output.x.is_finite() && center_output.y.is_finite());
    }

    #[test]
    fn invalid_manual_dewarp_surfaces_a_stable_error_identifier() {
        let error = clean_page(
            &GrayImage::new(120, 100, 255),
            &CleanupOptions {
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![Point::new(0.0, 0.0), Point::new(120.0, 100.0)],
                    bottom_curve: vec![Point::new(0.0, 100.0), Point::new(120.0, 0.0)],
                    depth: 0.0,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .err()
        .expect("crossing manual directrices must fail");

        assert!(
            error.starts_with("dewarp-model-endpoint-order:"),
            "error={error}"
        );
    }

    #[test]
    fn analyze_no_crop_reports_full_source_dimensions_above_analysis_caps() {
        let source = GrayImage::new(3_000, 2_000, 245);
        let analysis = analyze_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(analysis.outputs.len(), 1);
        assert_eq!(
            analysis.outputs[0].crop_rect,
            Rect::new(0.0, 0.0, 3_000.0, 2_000.0)
        );
    }

    #[test]
    fn document_prior_is_gated_at_full_resolution_before_analysis_downscaling() {
        let mut source = GrayImage::new(3_000, 2_100, 245);
        let gutter_x = 1_410;
        for y in (240..1_860).step_by(92) {
            for word in 0..12 {
                let left = 180 + word * 92;
                for row in y..y + 8 {
                    for x in left..left + 58 {
                        source.set(x, row, 24);
                    }
                }
            }
            for word in 0..12 {
                let left = 1_650 + word * 92;
                for row in y..y + 8 {
                    for x in left..left + 58 {
                        source.set(x, row, 28);
                    }
                }
            }
        }
        for y in 30..2_070 {
            source.set(gutter_x, y, 55);
            source.set(gutter_x + 1, y, 150);
        }
        let options = CleanupOptions {
            dpi: 300.0,
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        };
        let no_prior = analyze_page(&source, &options).unwrap();
        let matching_prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(gutter_x as f64 / source.width() as f64),
            cluster_dims: crate::split::ClusterDimensions {
                width: source.width() as f64,
                height: source.height() as f64,
            },
            agreement_strength: 0.9,
        };
        let with_prior =
            analyze_page_with_document_prior(&source, &options, Some(matching_prior)).unwrap();
        assert!(
            with_prior.reconciliation.cluster_agreement > 0.0,
            "{:?}",
            with_prior.reconciliation
        );

        let inapplicable_prior = DocumentPrior {
            cluster_dims: crate::split::ClusterDimensions {
                width: (source.width() * 2) as f64,
                height: (source.height() * 2) as f64,
            },
            cutter_ratio_median: Some(0.35),
            ..matching_prior
        };
        let inapplicable =
            analyze_page_with_document_prior(&source, &options, Some(inapplicable_prior)).unwrap();
        assert_eq!(inapplicable.classification, no_prior.classification);
        assert_eq!(inapplicable.reconciliation.cluster_agreement, 0.0);
    }

    #[test]
    fn cleanup_metadata_reports_despeckle_fallback_for_seedless_page() {
        let mut source = GrayImage::new(180, 120, 255);
        for index in 0..20 {
            let left = 8 + (index % 10) * 16;
            let top = 12 + (index / 10) * 55;
            for y in top..top + 2 + (index % 3) {
                for x in left..left + 2 + ((index + 1) % 3) {
                    source.set(x, y, 0);
                }
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                normalize_illumination: false,
                binarization: crate::BinarizationMode::Otsu,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.metadata.despeckle_fallback);
        assert!(serde_json::to_value(&output.metadata).unwrap()["despeckleFallback"] == true);
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
        assert!(
            (result.cutter_x.unwrap() - 160.0).abs() <= 3.0,
            "cutter={:?}",
            result.cutter_x
        );
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
    fn analysis_metadata_emits_per_side_content_confidence() {
        let result = analyze_page(
            &single_page_fixture(),
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
        )
        .unwrap();
        let metadata = serde_json::to_value(&result.outputs[0]).unwrap();
        let confidence = &metadata["contentDiagnostics"]["sideConfidence"];
        for side in ["left", "top", "right", "bottom"] {
            assert!(confidence[side].is_number(), "missing {side}: {metadata}");
        }
        assert!(metadata["contentDiagnostics"]["textMask"]["lineCount"].is_number());
    }

    #[test]
    fn classify_only_analysis_matches_full_pipeline_for_spread_and_single_fixtures() {
        let options = CleanupOptions {
            dpi: 150.0,
            normalize_illumination: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        for source in [spread_fixture(), single_page_fixture()] {
            let classification = classify_page(&source, &options).unwrap();
            let cleaned = clean_page(&source, &options, 0).unwrap();
            assert_eq!(classification.classification, cleaned.classification);
            assert_eq!(classification.confidence, cleaned.layout_confidence);
            assert_eq!(classification.cutter_x, cleaned.cutter_x);
        }
    }

    #[test]
    fn manual_content_box_replaces_detection_for_the_selected_half() {
        let source = spread_fixture();
        let manual = Rect::new(30.0, 42.0, 90.0, 100.0);
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                manual_content_boxes: crate::ManualContentBoxes {
                    left: Some(crate::NormalizedRect {
                        x: manual.x / source.width() as f64,
                        y: manual.y / source.height() as f64,
                        width: manual.width / source.width() as f64,
                        height: manual.height / source.height() as f64,
                        rotation: OrthogonalRotation::None,
                    }),
                    ..crate::ManualContentBoxes::default()
                },
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(result.outputs[0].metadata.content_box, Some(manual));
        assert_ne!(result.outputs[1].metadata.content_box, Some(manual));
        assert_eq!(
            (
                result.outputs[0].metadata.output_width,
                result.outputs[0].metadata.output_height
            ),
            (90, 100)
        );
    }

    #[test]
    fn normalized_manual_content_has_the_same_physical_rect_at_150_and_600_dpi() {
        let clean_at_dpi = |dpi: f64, width: usize, height: usize| {
            let source = GrayImage::new(width, height, 245);
            clean_page(
                &source,
                &CleanupOptions {
                    dpi,
                    normalize_illumination: false,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    layout: crate::LayoutMode::Single,
                    manual_content_boxes: crate::ManualContentBoxes {
                        full: Some(crate::NormalizedRect {
                            x: 0.1,
                            y: 0.2,
                            width: 0.5,
                            height: 0.6,
                            rotation: OrthogonalRotation::None,
                        }),
                        ..crate::ManualContentBoxes::default()
                    },
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0)
            .metadata
        };
        let low = clean_at_dpi(150.0, 300, 450);
        let high = clean_at_dpi(600.0, 1200, 1800);
        let physical = |metadata: &CleanupMetadata, dpi: f64| {
            let rect = metadata.content_box.unwrap();
            Rect::new(
                rect.x / dpi,
                rect.y / dpi,
                rect.width / dpi,
                rect.height / dpi,
            )
        };
        let low = physical(&low, 150.0);
        let high = physical(&high, 600.0);
        for delta in [
            low.x - high.x,
            low.y - high.y,
            low.width - high.width,
            low.height - high.height,
        ] {
            assert!(delta.abs() < 1e-9, "physical rectangle delta was {delta}");
        }
        let split_at_dpi = |dpi: f64, width: usize, height: usize| {
            classify_page(
                &GrayImage::new(width, height, 245),
                &CleanupOptions {
                    dpi,
                    layout: crate::LayoutMode::TwoPage,
                    normalize_illumination: false,
                    manual_split_x: Some(crate::NormalizedSplit {
                        x: 0.4,
                        rotation: OrthogonalRotation::None,
                    }),
                    ..CleanupOptions::default()
                },
            )
            .unwrap()
            .cutter_x
            .unwrap()
                / dpi
        };
        assert!((split_at_dpi(150.0, 300, 450) - split_at_dpi(600.0, 1200, 1800)).abs() < 1e-9);
    }

    #[test]
    fn automatic_preview_plan_replays_final_geometry_without_becoming_manual() {
        fn scaled(source: &GrayImage, factor: usize) -> GrayImage {
            let mut output = GrayImage::new(source.width() * factor, source.height() * factor, 255);
            for y in 0..output.height() {
                for x in 0..output.width() {
                    output.set(x, y, source.get(x / factor, y / factor));
                }
            }
            output
        }

        let preview_source = single_page_fixture();
        let base_options = CleanupOptions {
            dpi: 150.0,
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let preview = clean_page(&preview_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let content = preview.metadata.content_box.unwrap();
        let normalized_content = crate::NormalizedRect {
            x: content.x / preview.metadata.source_region.width,
            y: content.y / preview.metadata.source_region.height,
            width: content.width / preview.metadata.source_region.width,
            height: content.height / preview.metadata.source_region.height,
            rotation: OrthogonalRotation::None,
        };

        let final_source = scaled(&preview_source, 2);
        let final_options = CleanupOptions {
            dpi: 300.0,
            ..base_options.clone()
        };
        let automatic = clean_page(&final_source, &final_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let replayed = clean_page(
            &final_source,
            &CleanupOptions {
                automatic_content_boxes: crate::ManualContentBoxes {
                    full: Some(normalized_content),
                    ..crate::ManualContentBoxes::default()
                },
                automatic_skew_degrees: crate::AutomaticSkewDegrees {
                    full: Some(preview.metadata.detected_skew_degrees),
                    ..crate::AutomaticSkewDegrees::default()
                },
                ..final_options
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(!replayed.metadata.manual_skew);
        assert_eq!(
            replayed.metadata.detected_skew_degrees,
            preview.metadata.detected_skew_degrees
        );
        let automatic_content = automatic.metadata.content_box.unwrap();
        let replayed_content = replayed.metadata.content_box.unwrap();
        for delta in [
            automatic_content.x - replayed_content.x,
            automatic_content.y - replayed_content.y,
            automatic_content.width - replayed_content.width,
            automatic_content.height - replayed_content.height,
        ] {
            assert!(
                delta.abs() <= 1.0,
                "replayed cross-DPI content geometry drifted by {delta}px"
            );
        }
        assert_eq!(
            (automatic.image.width(), automatic.image.height()),
            (replayed.image.width(), replayed.image.height())
        );
        let mean_absolute_error = automatic
            .image
            .to_gray()
            .data()
            .iter()
            .zip(replayed.image.to_gray().data())
            .map(|(&left, &right)| f64::from(left.abs_diff(right)))
            .sum::<f64>()
            / (automatic.image.width() * automatic.image.height()) as f64;
        assert!(
            mean_absolute_error <= 0.1,
            "automatic-plan replay changed the final raster: MAE={mean_absolute_error:.6}"
        );
    }

    #[test]
    fn forward_transform_uses_rotated_analysis_space_for_every_rotation() {
        let source = GrayImage::new(320, 200, 245);
        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let output = clean_page(
                &source,
                &CleanupOptions {
                    rotation,
                    layout: crate::LayoutMode::Single,
                    normalize_illumination: false,
                    crop_content: false,
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0);
            let metadata = output.metadata;
            let point = Point::new(
                metadata.source_region.width * 0.3,
                metadata.source_region.height * 0.7,
            );
            let transformed = metadata.forward_transform.unwrap().apply(point);
            let restored = metadata.inverse_transform.unwrap().apply(transformed);
            assert!(
                (transformed.x - point.x).abs() < 1e-8,
                "rotation={rotation:?}"
            );
            assert!(
                (transformed.y - point.y).abs() < 1e-8,
                "rotation={rotation:?}"
            );
            assert!((restored.x - point.x).abs() < 1e-8, "rotation={rotation:?}");
            assert!((restored.y - point.y).abs() < 1e-8, "rotation={rotation:?}");
        }
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
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 280.0 / source.width() as f64,
                    rotation: OrthogonalRotation::None,
                }),
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
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 73.0 / source.height() as f64,
                    rotation: OrthogonalRotation::Clockwise90,
                }),
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

    #[test]
    fn blank_split_region_fails_closed_to_all_white_instead_of_all_black() {
        let mut source = GrayImage::new(320, 180, 255);
        for y in (30..150).step_by(14) {
            for x in 190..294 {
                source.set(x, y, 20);
                source.set(x, y + 1, 20);
                source.set(x, y + 2, 20);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Bw,
                crop_content: true,
                match_page_size: false,
                layout: crate::LayoutMode::TwoPage,
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 0.5,
                    rotation: OrthogonalRotation::None,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        let blank = &result.outputs[0];
        assert_eq!(blank.metadata.half, PageHalf::Left);
        assert!(blank.metadata.content_box.is_none());
        assert!(blank.effectively_blank);
        let blank_image = blank.image.to_gray();
        assert!(blank_image.data().iter().all(|&value| value == 255));
        assert!(!blank_image.data().iter().all(|&value| value == 0));
    }

    #[test]
    fn small_text_on_gray_paper_is_never_erased_as_a_blank_page() {
        let background = 152u8;
        let mut source = GrayImage::new(360, 510, background);
        for y in 0..source.height() {
            for x in 0..source.width() {
                let shading = (x * 24 / source.width()) as i16 - 12;
                let texture = ((x * 7 + y * 11) % 5) as i16 - 2;
                source.set(
                    x,
                    y,
                    (i16::from(background) + shading + texture).clamp(0, 255) as u8,
                );
            }
        }
        let ink = background.saturating_sub(64);
        // Six compact glyph-like components form one very short line and
        // occupy far below one percent of the page.
        for glyph in 0..6 {
            let left = 140 + glyph * 11;
            for y in 246..256 {
                source.set(left, y, ink);
                source.set(left + 5, y, ink);
            }
            for x in left..=left + 5 {
                source.set(x, 246, ink);
                source.set(x, 251, ink);
            }
        }

        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Bw,
                layout: crate::LayoutMode::Single,
                crop_content: false,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let black_pixels = output
            .image
            .to_gray()
            .data()
            .iter()
            .filter(|&&value| value == 0)
            .count();
        assert!(
            !output.effectively_blank && black_pixels >= 36,
            "small text was erased: effectively_blank={}, black_pixels={black_pixels}",
            output.effectively_blank,
        );
    }

    #[test]
    fn auto_mode_turns_dark_text_on_uniform_tinted_paper_into_black_on_white() {
        for paper in [
            [205, 225, 245],
            [225, 205, 215],
            [235, 220, 175],
            [190, 215, 195],
            [170, 170, 170],
        ] {
            let ink =
                paper.map(|channel| (f64::from(channel) * 0.18).round().clamp(8.0, 64.0) as u8);
            let mut color = RgbImage::new(420, 560, paper);
            for y in 0..color.height() {
                for x in 0..color.width() {
                    let shade = x as i16 * 12 / color.width() as i16 - 6;
                    let noise = ((x * 17 + y * 29 + x * y % 11) % 7) as i16 - 3;
                    color.set(
                        x,
                        y,
                        paper.map(|channel| {
                            (i16::from(channel) + shade + noise).clamp(0, 255) as u8
                        }),
                    );
                }
            }
            for line in 0..10 {
                let top = 55 + line * 42;
                for glyph in 0..22 {
                    let left = 46 + glyph * 15;
                    for y in top..top + 12 {
                        for x in left..left + 8 {
                            if x == left || y == top || y + 2 >= top + 12 {
                                color.set(x, y, ink);
                            }
                        }
                    }
                }
            }
            let mut gray = GrayImage::new(color.width(), color.height(), 255);
            for y in 0..color.height() {
                for x in 0..color.width() {
                    let pixel = color.get(x, y);
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
            let mut result = clean_page_with_color(
                &gray,
                Some(&color),
                &CleanupOptions {
                    dpi: 150.0,
                    output_mode: OutputMode::Auto,
                    crop_content: false,
                    match_page_size: false,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    layout: crate::LayoutMode::Single,
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap();
            let recommendation = result.output_mode_recommendation;
            let output = result.outputs.remove(0);
            assert!(
                matches!(
                    output.metadata.output_mode,
                    OutputMode::Bw | OutputMode::Grayscale
                ),
                "paper={paper:?}, recommendation={recommendation:?}",
            );
            assert!(output.color_image.is_none(), "paper={paper:?}");
            let rendered = output.image.to_gray();
            assert!(
                rendered
                    .data()
                    .iter()
                    .filter(|&&value| value >= 248)
                    .count()
                    > rendered.data().len() * 9 / 10,
                "paper={paper:?}, mode={:?}",
                output.metadata.output_mode,
            );
            assert!(
                rendered.data().iter().filter(|&&value| value <= 64).count() >= 2_000,
                "paper={paper:?} ink={ink:?}"
            );
        }
    }

    #[test]
    fn auto_mode_retains_small_faint_text_on_tinted_paper() {
        let paper = [185, 205, 220];
        let ink = [126, 139, 150];
        let mut color = RgbImage::new(420, 560, paper);
        for line in 0..13 {
            let top = 34 + line * 37;
            for glyph in 0..30 {
                let left = 24 + glyph * 12;
                for y in top..top + 9 {
                    for x in left..left + 6 {
                        if x == left || y == top || y + 1 >= top + 9 {
                            color.set(x, y, ink);
                        }
                    }
                }
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
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
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Auto,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let rendered = output.image.to_gray();

        assert!(matches!(
            output.metadata.output_mode,
            OutputMode::Bw | OutputMode::Grayscale
        ));
        assert!(output.color_image.is_none());
        assert!(
            rendered
                .data()
                .iter()
                .filter(|&&value| value >= 248)
                .count()
                > rendered.data().len() * 8 / 10
        );
        if output.metadata.output_mode == OutputMode::Grayscale {
            let diagnostics = output
                .metadata
                .text_tone_diagnostics
                .expect("grayscale text pages need an explicit tone decision");
            assert!(
                diagnostics.applied || diagnostics.ink_anchor.is_some(),
                "text tone must be derived even when no picture mask exists: {diagnostics:?}",
            );
        }
        let retained_strokes = rendered
            .data()
            .iter()
            // A preservation mask may keep faint glyphs from disappearing
            // during background normalization, but it must not exempt them
            // from the subsequent text-tone curve. Merely retaining the
            // original tinted-paper luminance (about 135 here) is not the
            // requested black-text-on-white result.
            .filter(|&&value| value <= 120)
            .count();
        assert!(
            retained_strokes >= 2_000,
            "small faint glyph strokes were lost: count={retained_strokes}, min={}, mode={:?}, tone={:?}",
            rendered.data().iter().copied().min().unwrap_or(255),
            output.metadata.output_mode,
            output.metadata.text_tone_diagnostics,
        );
    }

    #[test]
    fn mixed_mode_whitens_tinted_paper_but_preserves_independent_color() {
        let mut color = RgbImage::new(420, 560, [205, 225, 245]);
        for line in 0..10 {
            let top = 55 + line * 42;
            for glyph in 0..18 {
                let left = 42 + glyph * 15;
                for y in top..top + 12 {
                    for x in left..left + 8 {
                        if x == left || y == top || y + 2 >= top + 12 {
                            color.set(x, y, [26, 29, 34]);
                        }
                    }
                }
            }
        }
        for y in 210..350 {
            for x in 320..390 {
                color.set(x, y, [220, 45, 40]);
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
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
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Mixed,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                manual_zones: crate::ManualZones {
                    picture: vec![crate::PictureZone {
                        polygon: normalized_box_polygon(0.74, 0.35, 0.96, 0.67),
                        layer: crate::PictureZoneLayer::Painter2,
                    }],
                    fill: vec![],
                },
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let output_gray = output.image.to_gray();
        let output_color = output
            .color_image
            .expect("independent color produces a Mixed color plane");

        assert!(output_color
            .get(20, 20)
            .iter()
            .all(|&channel| channel >= 250));
        assert!(
            output_gray
                .data()
                .iter()
                .enumerate()
                .filter(|(index, value)| index % output_gray.width() < 300 && **value == 0)
                .count()
                >= 1_500
        );
        let protected_red = output_color.get(350, 280);
        assert!(protected_red[0] > protected_red[1].saturating_mul(2));
        assert!(protected_red[0] > protected_red[2].saturating_mul(2));
    }

    fn normalized_box_polygon(
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
    ) -> crate::NormalizedZonePolygon {
        crate::NormalizedZonePolygon {
            points: vec![
                crate::NormalizedZonePoint { x: left, y: top },
                crate::NormalizedZonePoint { x: right, y: top },
                crate::NormalizedZonePoint {
                    x: right,
                    y: bottom,
                },
                crate::NormalizedZonePoint { x: left, y: bottom },
            ],
            rotation: OrthogonalRotation::None,
        }
    }

    #[test]
    fn mixed_text_only_output_is_pixel_identical_to_bw() {
        let (source, _) = thin_stroke_fixture();
        let base = CleanupOptions {
            dpi: 300.0,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let bw = clean_page(&source, &base, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image;
        let mixed = clean_page(
            &source,
            &CleanupOptions {
                output_mode: OutputMode::Mixed,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert_eq!(mixed.image, bw);
        assert!(mixed.color_image.is_none());
        assert!(mixed.mixed_layers.is_none());
    }

    #[test]
    fn binarized_output_keeps_the_packed_bits_and_widens_losslessly() {
        let (source, _) = thin_stroke_fixture();
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let CleanupRaster::Bilevel(binary) = &output.image else {
            panic!("a black-and-white render must keep the binarizer's packed bits");
        };
        assert!(binary.count_black() > 0, "the fixture produced no ink");
        assert_eq!(
            (binary.width(), binary.height()),
            (output.image.width(), output.image.height())
        );
        let widened = output.image.to_gray();
        for y in 0..binary.height() {
            for x in 0..binary.width() {
                let expected = if binary.get(x, y) { 0 } else { 255 };
                assert_eq!(widened.get(x, y), expected, "widened sample at ({x}, {y})");
                assert_eq!(output.image.get(x, y), expected, "sample at ({x}, {y})");
            }
        }
    }

    #[test]
    fn mixed_picture_zone_preserves_tones_and_reserves_layer_endpoints() {
        let mut gray = GrayImage::new(180, 120, 255);
        let mut color = RgbImage::new(180, 120, [255; 3]);
        for y in 20..100 {
            for x in 85..165 {
                let value = if (x + y) % 17 == 0 {
                    0
                } else if (x + y) % 19 == 0 {
                    255
                } else {
                    30 + ((x * 7 + y * 11) % 190) as u8
                };
                gray.set(x, y, value);
                color.set(
                    x,
                    y,
                    if value == 0 {
                        [0; 3]
                    } else {
                        [value, value.saturating_add(13), value.saturating_add(29)]
                    },
                );
            }
        }
        let options = CleanupOptions {
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.45, 0.1, 0.95, 0.9),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        };
        let output = clean_page_with_color(&gray, Some(&color), &options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let mixed_color = output
            .color_image
            .as_ref()
            .expect("mixed color keeps source chroma");
        let layers = output
            .mixed_layers
            .as_ref()
            .expect("mixed picture output retains separable layers");
        let mut tonal_pixels = 0usize;
        for y in 20..100 {
            for x in 85..165 {
                let gray_value = output.image.get(x, y);
                let color_value = mixed_color.get(x, y);
                assert!(!matches!(gray_value, 0 | 255));
                assert_ne!(color_value, [0, 0, 0]);
                assert_ne!(color_value, [255, 255, 255]);
                if !matches!(gray_value, 1 | 254) {
                    tonal_pixels += 1;
                }
            }
        }
        assert!(tonal_pixels > 4_000, "picture tones were not retained");
        assert!(matches!(output.image.get(20, 20), 0 | 255));
        assert_eq!(
            layers.foreground_mask.get(20, 20),
            output.image.get(20, 20) == 0
        );
        assert_eq!(layers.background.get(20, 20), 255);
        assert!(layers.color_background.is_some());
    }

    #[test]
    fn auto_mixed_owns_independent_color_when_picture_detection_is_empty() {
        let mut color = RgbImage::new(360, 260, [205, 225, 245]);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            color.set(x, y, [12, 32, 76]);
                        }
                    }
                }
            }
        }
        for y in 202..222 {
            for x in 244..326 {
                color.set(x, y, [150, 22, 35]);
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
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

        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Auto,
                dpi: 150.0,
                normalize_illumination: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.output_mode, OutputMode::Mixed);
        let layers = output
            .mixed_layers
            .as_ref()
            .expect("Auto Mixed page must carry actual separable layers");
        let color_background = layers
            .color_background
            .as_ref()
            .expect("independent color must survive in the Mixed background");
        let retained_red = color_background.get(270, 210);
        assert!(
            retained_red[0] > retained_red[1].saturating_add(60)
                && retained_red[0] > retained_red[2].saturating_add(50),
            "red mark was lost: {retained_red:?}"
        );
        assert!(
            color_background
                .get(350, 250)
                .iter()
                .all(|value| *value >= 245),
            "uniform tinted paper was restored instead of whitened"
        );
    }

    #[test]
    fn mixed_automatic_detector_retains_synthetic_photo_tones() {
        let mut source = GrayImage::new(260, 180, 242);
        for row in 0..4 {
            for column in 0..9 {
                let left = 15 + column * 18;
                let top = 18 + row * 28;
                for y in top..top + 15 {
                    for x in left..left + 10 {
                        if x < left + 2 || y < top + 2 || y >= top + 13 {
                            source.set(x, y, 28);
                        }
                    }
                }
            }
        }
        for y in 35..155 {
            for x in 185..250 {
                source.set(x, y, 35 + ((x * 11 + y * 7 + x * y % 41) % 190) as u8);
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                output_mode: OutputMode::Mixed,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let output_image = &output.image;
        let retained_tones = (35..155)
            .flat_map(|y| (185..250).map(move |x| output_image.get(x, y)))
            .filter(|value| !matches!(value, 0 | 255))
            .count();
        assert!(
            retained_tones > 2_000,
            "retained only {retained_tones} photo tones"
        );
    }

    #[test]
    fn mixed_composite_feathers_light_mask_blocks_without_losing_dark_picture_edges() {
        let mut gray = GrayImage::new(120, 80, 255);
        let mut mask = BinaryImage::new(120, 80);
        let mut binary = BinaryImage::new(120, 80);
        for y in 35..39 {
            for x in 8..24 {
                binary.set(x, y, true);
            }
        }
        for y in 15..65 {
            for x in 30..90 {
                mask.set(x, y, true);
                gray.set(x, y, if y < 23 { 235 } else { 112 });
            }
        }
        for x in 30..90 {
            gray.set(x, 24, 54);
        }

        let (mixed, _, layers) = compose_mixed(
            &gray, None, None, &binary, &mask, None, None, None, None, 300.0, false, true, true,
        );
        let layers = layers.expect("final mixed render retains separable layers");

        assert!(
            (30..45).all(|x| mixed.get(x, 15) >= 248),
            "light block boundary next to the stencil was not feathered"
        );
        assert!(
            (30..90).all(|x| mixed.get(x, 24) <= 60),
            "dark engraving edge was washed out"
        );
        assert_eq!(mixed.get(60, 40), 112);
        assert_eq!(mixed.get(29, 40), 255);
        assert_eq!(mixed.get(12, 36), 0);
        assert!(layers.foreground_mask.get(12, 36));
        assert_eq!(
            layers.background.get(12, 36),
            255,
            "text pixels are filled from the normalized background instead of leaking into JPEG"
        );
    }

    #[test]
    fn soft_mixed_foreground_preserves_antialiased_coverage_and_leaves_photos_on_the_plate() {
        let mut gray = GrayImage::new(24, 12, 255);
        let mut picture_mask = BinaryImage::new(24, 12);
        let mut text_vicinity = BinaryImage::new(24, 12);
        let binary_fallback = BinaryImage::new(24, 12);
        let mut detected_text = BinaryImage::new(24, 12);
        for (x, value) in [0u8, 64, 128, 220].into_iter().enumerate() {
            gray.set(3 + x, 4, value);
            text_vicinity.set(3 + x, 4, true);
        }
        detected_text.set(3, 4, true);
        detected_text.set(4, 4, true);
        for y in 2..10 {
            for x in 14..22 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 80 + ((x + y) % 40) as u8);
            }
        }

        let (composite, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            Some(&detected_text),
            Some(&text_vicinity),
            300.0,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .as_ref()
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(
            (3..7).map(|x| alpha.get(x, 4)).collect::<Vec<_>>(),
            vec![255, 191, 127, 35]
        );
        assert!((3..7).all(|x| layers.background.get(x, 4) == 255));
        assert_eq!(alpha.get(17, 5), 0);
        assert_eq!(layers.background.get(17, 5), gray.get(17, 5));
        assert_eq!(
            (3..7).map(|x| composite.get(x, 4)).collect::<Vec<_>>(),
            vec![0, 64, 128, 220]
        );
        assert_eq!(composite.get(17, 5), gray.get(17, 5));
    }

    #[test]
    fn soft_mixed_foreground_keeps_binary_core_outside_text_vicinity() {
        let mut gray = GrayImage::new(16, 10, 255);
        let picture_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        let text_vicinity = BinaryImage::new(16, 10);
        gray.set(7, 5, 24);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            None,
            Some(&text_vicinity),
            300.0,
            true,
            true,
            true,
        );
        let alpha = layers
            .expect("soft mixed output retains separable layers")
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(alpha.get(7, 5), 231);
    }

    #[test]
    fn soft_mixed_foreground_recovers_raw_ink_absorbed_by_illumination_normalization() {
        let normalized = GrayImage::new(16, 10, 255);
        let mut raw = GrayImage::new(16, 10, 220);
        let picture_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        raw.set(7, 5, 30);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &normalized,
            Some(&raw),
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            None,
            None,
            200.0,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert!(alpha.get(7, 5) >= 200);
        assert_eq!(layers.background.get(7, 5), 255);
    }

    #[test]
    fn raw_ink_rescue_keeps_small_marks_but_rejects_broad_shadows() {
        let mut raw = GrayImage::new(200, 120, 220);
        let picture_mask = BinaryImage::new(200, 120);
        for y in 60..85 {
            for x in 0..200 {
                raw.set(x, y, 120);
            }
        }
        for x in 30..50 {
            raw.set(x, 20, 30);
            raw.set(x, 39, 30);
        }
        for y in 20..40 {
            raw.set(30, y, 30);
            raw.set(49, y, 30);
        }

        let rescued = rescue_isolated_raw_ink(&raw, &picture_mask, 200.0);

        assert!(rescued.get(30, 20));
        assert!(rescued.get(49, 39));
        assert!(!rescued.get(100, 72));
    }

    #[test]
    fn soft_mixed_foreground_keeps_trusted_text_even_when_picture_detection_overlaps_it() {
        let mut gray = GrayImage::new(16, 10, 220);
        let mut picture_mask = BinaryImage::new(16, 10);
        let mut text_mask = BinaryImage::new(16, 10);
        let binary_fallback = BinaryImage::new(16, 10);
        for y in 0..10 {
            for x in 0..16 {
                picture_mask.set(x, y, true);
            }
        }
        gray.set(7, 5, 48);
        text_mask.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            Some(&text_mask),
            Some(&text_mask),
            300.0,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert!(
            alpha.get(7, 5) >= 182,
            "trusted text must override an over-broad picture mask"
        );
        assert_eq!(layers.background.get(7, 5), 255);
    }

    #[test]
    fn soft_mixed_foreground_leaves_chromatic_picture_detail_on_the_plate() {
        let mut gray = GrayImage::new(16, 10, 220);
        let mut color = RgbImage::new(16, 10, [220; 3]);
        let mut picture_mask = BinaryImage::new(16, 10);
        let mut chroma_picture_mask = BinaryImage::new(16, 10);
        let mut text_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        gray.set(7, 5, 60);
        color.set(7, 5, [140, 20, 30]);
        picture_mask.set(7, 5, true);
        chroma_picture_mask.set(7, 5, true);
        text_mask.set(7, 5, true);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            Some(&color),
            &binary_fallback,
            &picture_mask,
            Some(&chroma_picture_mask),
            None,
            Some(&text_mask),
            Some(&text_mask),
            300.0,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(alpha.get(7, 5), 0);
        assert_eq!(layers.color_background.unwrap().get(7, 5), [140, 20, 30]);
    }

    #[test]
    fn mixed_composite_assigns_the_picture_protection_ring_to_paper_or_dark_edges() {
        let mut gray = GrayImage::new(120, 80, 255);
        let mut picture_mask = BinaryImage::new(120, 80);
        let stencil = BinaryImage::new(120, 80);
        for y in 15..65 {
            for x in 30..90 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 120);
            }
        }
        for y in 25..55 {
            gray.set(28, y, 220);
            gray.set(29, y, 80);
        }

        let (mixed, _, _) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            false,
            true,
        );

        assert!(
            (25..55).all(|y| mixed.get(28, y) >= 254),
            "light paper in the protected annulus must not retain a gray halo"
        );
        assert!(
            (25..55).all(|y| mixed.get(29, y) == 80),
            "a dark photo edge in the protected annulus must remain owned by the picture"
        );
    }

    #[test]
    fn mixed_composite_whitens_dense_scanner_bands_without_removing_thin_rules() {
        let mut gray = GrayImage::new(400, 600, 255);
        let mut stencil = BinaryImage::new(400, 600);
        let picture_mask = BinaryImage::new(400, 600);
        for y in 5..21 {
            for x in 18..382 {
                stencil.set(x, y, true);
                gray.set(x, y, 36);
            }
        }
        for x in 24..376 {
            stencil.set(x, 36, true);
            gray.set(x, 36, 24);
        }

        let (stencil, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);
        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            Some(&removed),
            None,
            None,
            100.0,
            false,
            true,
            true,
        );
        let layers = layers.expect("mixed output keeps separable layers");

        assert!((18..382).all(|x| mixed.get(x, 12) == 255));
        assert!((18..382).all(|x| !layers.foreground_mask.get(x, 12)));
        assert!(
            (24..376).all(|x| layers.foreground_mask.get(x, 36)),
            "a one-pixel printed rule must not be classified as a scanner band"
        );
    }

    #[test]
    fn scanner_band_suppression_does_not_erase_picture_owned_edges() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let mut picture_mask = BinaryImage::new(400, 600);
        for y in 5..21 {
            for x in 18..382 {
                stencil.set(x, y, true);
                picture_mask.set(x, y, true);
            }
        }

        let (cleaned, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);

        assert_eq!(cleaned.count_black(), stencil.count_black());
        assert_eq!(removed.count_black(), 0);
    }

    #[test]
    fn scanner_boundary_components_require_picture_or_text_ownership() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let mut picture_mask = BinaryImage::new(400, 600);
        let mut text_vicinity = BinaryImage::new(400, 600);

        for y in 100..500 {
            for x in 0..60 {
                stencil.set(x, y, true);
            }
        }
        for y in 550..590 {
            for x in 200..280 {
                stencil.set(x, y, true);
            }
        }
        for y in 150..450 {
            for x in 80..120 {
                stencil.set(x, y, true);
                picture_mask.set(x, y, true);
            }
        }
        for y in 10..16 {
            for x in 100..300 {
                stencil.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }

        let (cleaned, removed) = suppress_scanner_edge_bands(
            &stencil,
            &gray,
            &picture_mask,
            Some(&text_vicinity),
            100.0,
        );

        assert!(removed.get(5, 120));
        assert!(removed.get(220, 570));
        assert!(!cleaned.get(5, 120));
        assert!(!cleaned.get(220, 570));
        assert!(
            cleaned.get(80, 300),
            "picture-owned boundary content was removed"
        );
        assert!(
            cleaned.get(180, 12),
            "text-owned boundary content was removed"
        );
    }

    #[test]
    fn scanner_boundary_suppression_preserves_printable_line_art_inside_the_margin() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let picture_mask = BinaryImage::new(400, 600);
        for x in 150..175 {
            stencil.set(x, 75, true);
            stencil.set(x, 99, true);
        }
        for y in 75..100 {
            stencil.set(150, y, true);
            stencil.set(174, y, true);
        }

        let (cleaned, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);

        assert_eq!(cleaned.count_black(), stencil.count_black());
        assert_eq!(removed.count_black(), 0);
    }

    #[test]
    fn scanner_shadow_l_shape_is_removed_but_dark_printed_frame_survives() {
        let mut shadow = BinaryImage::new(400, 600);
        for y in 0..460 {
            for x in 0..145 {
                shadow.set(x, y, true);
            }
        }
        for y in 0..70 {
            for x in 0..400 {
                shadow.set(x, y, true);
            }
        }
        let picture_mask = BinaryImage::new(400, 600);
        let pale_shadow = GrayImage::new(400, 600, 150);
        let dark_print = GrayImage::new(400, 600, 30);

        let (cleaned_shadow, _) =
            suppress_scanner_edge_bands(&shadow, &pale_shadow, &picture_mask, None, 100.0);
        let (cleaned_print, _) =
            suppress_scanner_edge_bands(&shadow, &dark_print, &picture_mask, None, 100.0);

        assert_eq!(cleaned_shadow.count_black(), 0);
        assert_eq!(cleaned_print.count_black(), shadow.count_black());
    }

    #[test]
    fn mixed_composite_preserves_a_pale_vignette_away_from_the_stencil() {
        let mut gray = GrayImage::new(128, 96, 248);
        let mut picture_mask = BinaryImage::new(128, 96);
        let mut stencil = BinaryImage::new(128, 96);
        for y in 12..84 {
            for x in 24..112 {
                picture_mask.set(x, y, true);
                let edge_distance = (x - 24).min(111 - x).min((y - 12).min(83 - y));
                gray.set(x, y, 232 + edge_distance.min(14) as u8);
            }
        }
        for y in 40..56 {
            for x in 16..21 {
                gray.set(x, y, 20);
                stencil.set(x, y, true);
            }
        }
        let source_vignette = (12..27).map(|y| gray.get(80, y)).collect::<Vec<_>>();

        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            true,
            true,
        );
        let rendered_vignette = (12..27).map(|y| mixed.get(80, y)).collect::<Vec<_>>();

        assert_eq!(
            rendered_vignette, source_vignette,
            "a pale border gradient far from stencil ink must retain its source tones"
        );
        assert!(
            mixed.get(24, 48) > gray.get(24, 48),
            "the light picture boundary next to stencil ink still needs separation"
        );
        assert_eq!(
            layers.unwrap().background.get(18, 48),
            255,
            "stencil ink must remain reclaimed from the JPEG background"
        );
    }

    #[test]
    fn mixed_jpeg_ringing_is_bounded_for_every_picture_edge_block_phase() {
        const DPI: f64 = 300.0;
        let text_gap = (DPI * 0.5 / 25.4).round() as usize;
        let phase_amplitudes = (25..=32)
            .map(|picture_right| {
                let text_left = picture_right + text_gap;
                let mut gray = GrayImage::new(96, 64, 246);
                let mut picture_mask = BinaryImage::new(96, 64);
                let mut stencil = BinaryImage::new(96, 64);
                for y in 8..56 {
                    for x in 8..picture_right {
                        picture_mask.set(x, y, true);
                        gray.set(x, y, if x + 8 >= picture_right { 12 } else { 156 });
                    }
                }
                for y in 20..44 {
                    for x in text_left..text_left + 3 {
                        gray.set(x, y, 18);
                        stencil.set(x, y, true);
                    }
                }

                let (_, _, layers) = compose_mixed(
                    &gray,
                    None,
                    None,
                    &stencil,
                    &picture_mask,
                    None,
                    None,
                    None,
                    None,
                    DPI,
                    false,
                    true,
                    true,
                );
                let background = &layers.unwrap().background;
                assert!(
                    (20..44).all(|y| background.get(text_left, y) == 255),
                    "the layered background must reclaim the nearby stencil"
                );

                let decoded = jpeg_luma_roundtrip(background, 85);
                let decoded = &decoded;
                (20..44)
                    .flat_map(|y| {
                        (picture_right..text_left)
                            .map(move |x| background.get(x, y).abs_diff(decoded.get(x, y)))
                    })
                    .max()
                    .unwrap()
            })
            .collect::<Vec<_>>();

        assert!(
            phase_amplitudes.iter().all(|&amplitude| amplitude <= 3),
            "JPEG ringing by picture-edge block phase: {phase_amplitudes:?}"
        );
        assert!(
            phase_amplitudes.iter().any(|&amplitude| amplitude != 0),
            "fixture must exercise a lossy decoded reclaimed strip"
        );
        assert!(
            phase_amplitudes[7] <= 3,
            "the block-aligned edge exceeded the reclaimed-strip bound"
        );
    }

    #[test]
    fn mixed_caption_touching_picture_boundary_is_covered_by_at_least_one_layer() {
        let mut gray = GrayImage::new(96, 72, 242);
        let mut picture_mask = BinaryImage::new(96, 72);
        for y in 8..64 {
            for x in 48..88 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 176);
            }
        }
        let caption_pixels = (42..53)
            .flat_map(|x| (38..41).map(move |y| (x, y)))
            .collect::<Vec<_>>();
        for &(x, y) in &caption_pixels {
            gray.set(x, y, 24);
        }
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&gray, options.dpi, CalibrationConfig::default());
        let (stencil, _, _, _) = binarize_normalized_with_diagnostics_excluding(
            &gray,
            None,
            &options,
            calibration,
            &picture_mask,
        );
        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            options.dpi,
            false,
            true,
            true,
        );
        let layers = layers.expect("final mixed render retains separable layers");

        assert!(
            caption_pixels
                .iter()
                .all(|&(x, y)| { stencil.get(x, y) || layers.background.get(x, y) <= 64 }),
            "every source caption stroke must survive in the stencil/background union"
        );
        assert!(
            caption_pixels
                .iter()
                .any(|&(x, y)| !stencil.get(x, y) && layers.background.get(x, y) <= 64),
            "fixture must exercise caption pixels removed by picture-mask dilation"
        );
    }

    #[test]
    fn mixed_preview_builds_only_the_composite() {
        let mut gray = GrayImage::new(120, 80, 242);
        for y in 15..65 {
            for x in 60..105 {
                gray.set(x, y, 72 + ((x + y) % 100) as u8);
            }
        }
        for y in 30..34 {
            for x in 12..48 {
                gray.set(x, y, 28);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.5, 0.1, 0.9, 0.9),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &gray,
            None,
            None,
            None,
            None,
            None,
            &options,
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy {
                create_mixed_layers: false,
                create_mixed_composite: true,
                recommend_output_mode: true,
                analyze_layout: true,
            },
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.mixed_layers.is_none());
        let composite = output.image.to_gray();
        assert!(
            composite.data().contains(&0)
                && composite
                    .data()
                    .iter()
                    .any(|&value| !matches!(value, 0 | 255)),
            "preview keeps the mixed composite without retaining layer buffers"
        );
    }

    #[test]
    fn metadata_records_a_guardrail_limited_bw_supersample() {
        let source = GrayImage::new(120, 90, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 875.0,
                source_dpi: Some(600.0),
                requested_render_dpi: Some(1_200.0),
                output_mode: OutputMode::Bw,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.source_dpi, 600.0);
        assert_eq!(output.metadata.render_dpi, 875.0);
        assert_eq!(output.metadata.requested_render_dpi, 1_200.0);
        assert!(output.metadata.raster_scale_limited);
        assert!(output
            .metadata
            .warnings
            .iter()
            .any(|warning| warning.contains("limited to 875.000")));
    }

    #[test]
    fn render_crop_samples_only_the_true_dpi_region_after_every_geometry_stage() {
        let source = rotated_text_page(3.0);
        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let (rotated_width, rotated_height) = match rotation {
                OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => {
                    (source.width(), source.height())
                }
                OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => {
                    (source.height(), source.width())
                }
            };
            let crop = crate::NormalizedRect {
                x: 0.2,
                y: 0.15,
                width: 0.45,
                height: 0.4,
                rotation,
            };
            let base = CleanupOptions {
                dpi: 1_200.0,
                source_dpi: Some(600.0),
                requested_render_dpi: Some(1_200.0),
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                crop_content: true,
                margins_mm: None,
                margins_pixels: Some([7.0, 9.0, 11.0, 13.0]),
                layout: crate::LayoutMode::Single,
                manual_skew_degrees: Some(2.0),
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![
                        Point::new(0.0, 0.0),
                        Point::new(rotated_width as f64 / 2.0, 8.0),
                        Point::new(rotated_width as f64, 0.0),
                    ],
                    bottom_curve: vec![
                        Point::new(0.0, rotated_height as f64),
                        Point::new(rotated_width as f64 / 2.0, rotated_height as f64 - 8.0),
                        Point::new(rotated_width as f64, rotated_height as f64),
                    ],
                    depth: 0.08,
                }),
                rotation,
                match_page_size: false,
                ..CleanupOptions::default()
            };
            let full = clean_page(&source, &base, 0).unwrap().outputs.remove(0);
            let tile = clean_page(
                &source,
                &CleanupOptions {
                    render_crop: Some(crop),
                    ..base
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0);
            let region = tile.metadata.render_region.unwrap();

            assert_eq!(tile.metadata.output_width, full.metadata.output_width);
            assert_eq!(tile.metadata.output_height, full.metadata.output_height);
            assert_eq!(tile.metadata.crop_rect, full.metadata.crop_rect);
            assert_eq!(tile.metadata.render_dpi, 1_200.0);
            assert_eq!(tile.metadata.requested_render_dpi, 1_200.0);
            assert!(!tile.metadata.raster_scale_limited);
            assert_eq!(tile.image.width(), region.width as usize);
            assert_eq!(tile.image.height(), region.height as usize);
            assert!(tile.image.width() * tile.image.height() <= 4_000_000);
            let serialized_metadata = serde_json::to_value(&tile.metadata).unwrap();
            assert_eq!(
                serialized_metadata["renderRegion"]["xPx"],
                serde_json::json!(region.x),
            );
            assert!(serialized_metadata.get("render_region").is_none());

            for y in 0..tile.image.height() {
                for x in 0..tile.image.width() {
                    assert_eq!(
                        tile.image.get(x, y),
                        full.image.get(region.x as usize + x, region.y as usize + y),
                        "rotation={rotation:?}, x={x}, y={y}",
                    );
                }
            }
            let tile_grid = tile.metadata.dewarp_mapping.unwrap();
            assert_eq!(
                tile_grid.output_origin,
                Point::new(
                    full.metadata.crop_rect.x + region.x,
                    full.metadata.crop_rect.y + region.y,
                ),
            );
            assert_eq!(
                (tile_grid.output_width, tile_grid.output_height),
                (tile.image.width(), tile.image.height()),
            );
        }

        let crop = crate::NormalizedRect {
            x: 0.2,
            y: 0.15,
            width: 0.45,
            height: 0.4,
            rotation: OrthogonalRotation::None,
        };
        let bw_options = CleanupOptions {
            dpi: 600.0,
            source_dpi: Some(300.0),
            requested_render_dpi: Some(600.0),
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let full_bw = clean_page(&source, &bw_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let tile_bw = clean_page(
            &source,
            &CleanupOptions {
                render_crop: Some(crop),
                ..bw_options.clone()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let region = tile_bw.metadata.render_region.unwrap();
        for y in 0..tile_bw.image.height() {
            for x in 0..tile_bw.image.width() {
                assert_eq!(
                    tile_bw.image.get(x, y),
                    full_bw
                        .image
                        .get(region.x as usize + x, region.y as usize + y),
                    "BW processing apron must make crop and full-page interiors identical",
                );
            }
        }

        let affine_options = CleanupOptions {
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let full_affine = clean_page(&source, &affine_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let tile_affine = clean_page(
            &source,
            &CleanupOptions {
                render_crop: Some(crop),
                ..affine_options
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let tile_forward = tile_affine.metadata.forward_transform.unwrap();
        let full_forward = full_affine.metadata.forward_transform.unwrap();
        for row in 0..3 {
            for column in 0..3 {
                assert!(
                    (tile_forward.matrix[row][column] - full_forward.matrix[row][column]).abs()
                        < 1e-9,
                    "crop metadata keeps the canonical intrinsic-output affine",
                );
            }
        }

        let blank = GrayImage::new(800, 1_000, 255);
        let blank_crop = clean_page(
            &blank,
            &CleanupOptions {
                render_crop: Some(crop),
                skip_blank_pages: true,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(blank_crop.outputs.len(), 1);
        assert_eq!(blank_crop.blank_outputs_skipped, 0);
    }

    #[test]
    fn detail_source_crop_replays_base_geometry_without_rendering_the_full_raster() {
        let mut base_source = GrayImage::new(120, 90, 245);
        for y in 0..base_source.height() {
            for x in 0..base_source.width() {
                base_source.set(x, y, ((x * 5 + y * 3) % 220 + 20) as u8);
            }
        }
        let mut detail_source = GrayImage::new(240, 180, 255);
        for y in 0..detail_source.height() {
            for x in 0..detail_source.width() {
                detail_source.set(x, y, base_source.get(x / 2, y / 2));
            }
        }
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Grayscale,
            normalize_illumination: true,
            manual_skew_degrees: Some(2.0),
            crop_content: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let base = clean_page(&base_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let base_cleaned = base.image.to_gray().into_owned();
        let base_metadata = base.metadata;
        let detail_options = CleanupOptions {
            dpi: 300.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(300.0),
            ..base_options.clone()
        };
        let source_crop = Rect::new(46.0, 24.0, 148.0, 120.0);
        let cropped_source = crop_gray(&detail_source, source_crop);
        let render_region = Rect::new(60.0, 40.0, 100.0, 70.0);
        let sampled_region = Rect::new(46.0, 24.0, 148.0, 120.0);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: source_crop.x,
                y_px: source_crop.y,
                width_px: source_crop.width,
                height_px: source_crop.height,
            },
            full_source_width_px: detail_source.width(),
            full_source_height_px: detail_source.height(),
            scale: 2.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: render_region.x,
                y_px: render_region.y,
                width_px: render_region.width,
                height_px: render_region.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
        };
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: Some((&base_cleaned, None)),
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        let full = clean_page(&detail_source, &detail_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let expected = crop_gray(&full.image.to_gray(), render_region);
        let detail_image = detail.image.to_gray();
        let mean_error = detail_image
            .data()
            .iter()
            .zip(expected.data())
            .map(|(&actual, &expected)| f64::from(actual.abs_diff(expected)))
            .sum::<f64>()
            / detail_image.data().len() as f64;
        assert!(
            mean_error <= 2.0,
            "detail source crop must preserve normalized non-identity geometry, mean error={mean_error:.3}",
        );
        assert_eq!(detail.metadata.render_region, Some(render_region));
        assert_eq!(detail.metadata.input_width, detail_source.width());
        assert_eq!(detail.metadata.input_height, detail_source.height());
        assert_eq!(detail.metadata.output_width, full.metadata.output_width);
        assert_eq!(detail.metadata.output_height, full.metadata.output_height);

        let manual_zone_options = CleanupOptions {
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.25, 0.25, 0.75, 0.75),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..detail_options.clone()
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &manual_zone_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("detail rendering with manual zones must fail closed")
        .contains("manual zones requires the full-page source"));
        let mixed_options = CleanupOptions {
            output_mode: OutputMode::Mixed,
            ..detail_options.clone()
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &mixed_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("mixed detail must fail closed")
        .contains("full-page picture mask"));
        let auto_options = CleanupOptions {
            output_mode: OutputMode::Auto,
            ..detail_options
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &auto_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("an unresolved output mode must fail closed rather than be chosen per tile")
        .contains("resolved from the full page"));
    }

    #[test]
    fn grayscale_detail_applies_pinned_text_tone_exactly_once() {
        let mut source = GrayImage::new(120, 90, 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (115 + (x * 75 / source.width()) + (y % 9)) as u8);
            }
        }
        for y in 18..72 {
            for x in (12..108).step_by(13) {
                source.set(x, y, 96);
            }
        }
        let diagnostics = TextToneDiagnostics {
            applied: true,
            rule: crate::text_tone::TextToneRule::Applied,
            text_line_count: 12,
            text_ink_pixels: 2_000,
            picture_fraction: 0.0,
            outside_midtone_fraction: 0.0,
            outside_midtone_largest_component_fraction: 0.0,
            outside_midtone_largest_component_width_fraction: 0.0,
            outside_midtone_largest_component_height_fraction: 0.0,
            ink_anchor: Some(133),
            black_point: Some(96.052_631_578_947_37),
            slope: Some(1.623_931_623_931_624),
        };
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let mut base_metadata = clean_page(&source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .metadata;
        base_metadata.text_tone_diagnostics = Some(diagnostics);
        let detail_options = CleanupOptions {
            resolved_text_tone_diagnostics: crate::domain::options::ResolvedTextToneDiagnostics {
                full: Some(diagnostics),
                ..Default::default()
            },
            ..base_options.clone()
        };
        let full_rect = Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
            full_source_width_px: source.width(),
            full_source_height_px: source.height(),
            scale: 1.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
        };
        let mut expected = clean_page(&source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .to_gray()
            .into_owned();
        apply_text_tone(&mut expected, diagnostics);
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &source,
                color_source_crop: None,
                base_source: &source,
                base_color_source: None,
                base_cleaned: Some((&expected, None)),
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        assert_eq!(detail.image.to_gray().as_ref(), &expected);
        assert_eq!(detail.metadata.text_tone_diagnostics, Some(diagnostics));
    }

    #[test]
    fn detail_tile_policy_skips_layout_analysis_and_keeps_calibration() {
        let source = illustrated_text_page();
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let prepare = |policy| {
            let mut timings = PageStageTimings::default();
            let prepared = prepare_analysis_page(
                &source,
                None,
                &options,
                true,
                policy,
                None,
                CalibrationConfig::default(),
                None,
                &mut timings,
            );
            (prepared, timings)
        };
        let (complete, complete_timings) = prepare(PageRenderPolicy::COMPLETE);
        let (tile, tile_timings) = prepare(PageRenderPolicy::DETAIL_TILE);

        assert!(
            complete
                .picture_mask
                .as_deref()
                .expect("the complete policy detects a picture mask")
                .count_black()
                > 0,
            "the fixture must exercise the layout stack the tile policy skips",
        );
        assert!(
            complete.content_picture_mask.is_none(),
            "content-mask extension is unnecessary when content cropping is disabled",
        );
        assert!(complete.text_axis.is_some());

        assert!(tile.picture_mask.is_none());
        assert!(tile.content_picture_mask.is_none());
        assert!(tile.text_axis.is_none());
        assert!(tile.output_mode_recommendation.is_none());
        assert_eq!(
            tile.split.classification,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(tile.split.cutter_x, None);
        assert_eq!(tile.split.pages.len(), 1);

        // Calibration and the raster the tile binarizes are exactly what the
        // complete policy produced; only the discarded layout work is gone.
        assert_eq!(tile.normalized.data(), complete.normalized.data());
        assert_eq!(tile.full_width, complete.full_width);
        assert_eq!(tile.full_height, complete.full_height);
        assert_eq!(
            tile.calibration.stroke_width_px,
            complete.calibration.stroke_width_px
        );
        assert_eq!(
            tile.calibration.x_height_px,
            complete.calibration.x_height_px
        );
        assert_eq!(tile.calibration.valid, complete.calibration.valid);
        assert!(
            tile_timings.normalization_ms < complete_timings.normalization_ms,
            "skipping the layout stack must cost less, not more: {tile_timings:?} vs {complete_timings:?}",
        );
    }

    #[test]
    fn bw_detail_tile_reproduces_the_full_page_render_it_replaces() {
        let base_source = illustrated_text_page();
        let mut detail_source =
            GrayImage::new(base_source.width() * 2, base_source.height() * 2, 255);
        for y in 0..detail_source.height() {
            for x in 0..detail_source.width() {
                detail_source.set(x, y, base_source.get(x / 2, y / 2));
            }
        }
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let base_metadata = clean_page(&base_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .metadata;
        let detail_options = CleanupOptions {
            dpi: 300.0,
            requested_render_dpi: Some(300.0),
            ..base_options
        };
        // The apron the preview service samples around the visible viewport.
        let sampled_region = Rect::new(24.0, 40.0, 220.0, 200.0);
        let render_region = Rect::new(80.0, 96.0, 108.0, 88.0);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
            full_source_width_px: detail_source.width(),
            full_source_height_px: detail_source.height(),
            scale: 2.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: render_region.x,
                y_px: render_region.y,
                width_px: render_region.width,
                height_px: render_region.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
        };
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &crop_gray(&detail_source, sampled_region),
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        let full = clean_page(&detail_source, &detail_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let expected = crop_gray(&full.image.to_gray(), render_region);
        assert_eq!(detail.image.width(), expected.width());
        assert_eq!(detail.image.height(), expected.height());
        assert!(
            expected.data().contains(&0) && expected.data().contains(&255),
            "the compared region must carry both ink and paper",
        );
        let detail_image = detail.image.to_gray();
        let mismatched = detail_image
            .data()
            .iter()
            .zip(expected.data())
            .filter(|(actual, expected)| actual != expected)
            .count();
        let mismatch_ratio = mismatched as f64 / expected.data().len() as f64;
        assert!(
            mismatch_ratio < 0.005,
            "a binarized detail tile must reproduce the full-page render, mismatch={mismatch_ratio:.4}",
        );
    }

    fn illustrated_text_page() -> GrayImage {
        let mut source = GrayImage::new(420, 560, 248);
        for y in 0..source.height() {
            for x in 0..source.width() {
                let shade = 248 - (x * 6 / source.width()) - (y * 4 / source.height());
                source.set(x, y, shade as u8);
            }
        }
        for line in 0..14 {
            let top = 40 + line * 18;
            for y in top..top + 8 {
                for x in 40..380 {
                    if (x / 34 + line) % 5 != 4 && (x * 5 + y * 3) % 7 > 1 {
                        source.set(x, y, 28);
                    }
                }
            }
        }
        for y in 330..520 {
            for x in 70..350 {
                let halftone = ((x % 4) + (y % 4)) * 14;
                source.set(x, y, (52 + halftone) as u8);
            }
        }
        source
    }

    fn gradient_page(width: usize, height: usize) -> GrayImage {
        let mut page = GrayImage::new(width, height, 255);
        for y in 0..height {
            for x in 0..width {
                page.set(x, y, ((x * 7 + y * 13) % 251) as u8);
            }
        }
        page
    }

    fn rotate_gray_reference(source: &GrayImage, rotation: OrthogonalRotation) -> GrayImage {
        let (width, height) = (source.width(), source.height());
        let (output_width, output_height) = match rotation {
            OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => (width, height),
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => (height, width),
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
        output
    }

    #[test]
    fn orthogonal_rotation_places_every_pixel_where_the_quarter_turn_says() {
        let gray = gradient_page(37, 23);
        let mut color = RgbImage::new(37, 23, [0; 3]);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let value = gray.get(x, y);
                color.set(x, y, [value, value.wrapping_add(61), value.wrapping_mul(3)]);
            }
        }

        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let rotated_gray = rotate_orthogonal(&gray, rotation);
            assert_eq!(
                rotated_gray,
                rotate_gray_reference(&gray, rotation),
                "gray rotation {rotation:?}"
            );

            let rotated_color = rotate_rgb_orthogonal(&color, rotation);
            assert_eq!(
                (rotated_color.width(), rotated_color.height()),
                (rotated_gray.width(), rotated_gray.height()),
                "colour rotation {rotation:?} geometry"
            );
            for y in 0..rotated_color.height() {
                for x in 0..rotated_color.width() {
                    let value = rotated_gray.get(x, y);
                    assert_eq!(
                        rotated_color.get(x, y),
                        [value, value.wrapping_add(61), value.wrapping_mul(3)],
                        "colour rotation {rotation:?} at {x},{y}"
                    );
                }
            }
        }
    }

    #[test]
    fn crop_gray_keeps_the_requested_geometry_and_pads_past_the_source_edge() {
        let page = gradient_page(40, 30);

        let inside = crop_gray(&page, Rect::new(6.0, 4.0, 12.0, 9.0));
        assert_eq!((inside.width(), inside.height()), (12, 9));
        for y in 0..inside.height() {
            for x in 0..inside.width() {
                assert_eq!(inside.get(x, y), page.get(6 + x, 4 + y), "at {x},{y}");
            }
        }

        // clean_region derives its working geometry from the region alone, so a
        // region that runs past the source must still report the requested size
        // and pad the overhang with white.
        let overhanging = Rect::new(34.0, 26.0, 12.0, 9.0);
        let past_edge = crop_gray(&page, overhanging);
        assert_eq!(
            (past_edge.width(), past_edge.height()),
            (
                overhanging.width.round().max(1.0) as usize,
                overhanging.height.round().max(1.0) as usize
            )
        );
        assert_eq!(past_edge.get(0, 0), page.get(34, 26));
        assert_eq!(past_edge.get(11, 8), 255);
    }

    #[test]
    fn preparing_an_unrotated_page_borrows_the_source_instead_of_copying_it() {
        let source = gradient_page(320, 240);
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Grayscale,
            ..CleanupOptions::default()
        };

        let prepared = prepare_page(
            &source,
            None,
            None,
            None,
            None,
            None,
            &options,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy {
                create_mixed_layers: false,
                create_mixed_composite: true,
                recommend_output_mode: false,
                analyze_layout: true,
            },
            &mut PageStageTimings::default(),
        );

        match prepared.rotated_source {
            Some(Cow::Borrowed(borrowed)) => assert!(
                std::ptr::eq(borrowed, &source),
                "an unrotated page must borrow the caller's buffer"
            ),
            _ => panic!("an unrotated page must not allocate a rotated copy"),
        }
    }

    #[test]
    fn a_page_prepared_without_illumination_normalization_keeps_one_full_size_buffer() {
        let source = gradient_page(320, 240);
        for rotation in [OrthogonalRotation::None, OrthogonalRotation::Clockwise90] {
            let options = CleanupOptions {
                dpi: 300.0,
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                rotation,
                ..CleanupOptions::default()
            };

            let prepared = prepare_page(
                &source,
                None,
                None,
                None,
                None,
                None,
                &options,
                CalibrationConfig::default(),
                None,
                None,
                PageRenderPolicy {
                    create_mixed_layers: false,
                    create_mixed_composite: true,
                    recommend_output_mode: false,
                    analyze_layout: true,
                },
                &mut PageStageTimings::default(),
            );

            assert!(
                prepared.rotated_source.is_none(),
                "rotation {rotation:?}: the rotated page and the normalized page must be one buffer"
            );
            assert_eq!(
                *prepared.normalized,
                rotate_gray_reference(&source, rotation),
                "rotation {rotation:?}: the shared buffer must hold the rotated page"
            );
        }
    }

    #[test]
    fn colour_pages_publish_rgb_without_rendering_the_gray_twin_nobody_writes() {
        let mut gray = GrayImage::new(220, 160, 238);
        let mut color = RgbImage::new(220, 160, [238, 232, 224]);
        for y in 40..96 {
            for x in 36..184 {
                gray.set(x, y, 74);
                color.set(x, y, [196, 48, 52]);
            }
        }
        let base = CleanupOptions {
            dpi: 300.0,
            manual_skew_degrees: Some(1.6),
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base.clone()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let published = colored
            .color_image
            .as_ref()
            .expect("a colour page publishes an RGB raster");
        assert!(
            published.data().iter().any(|&value| value < 160),
            "the published colour raster must carry the page"
        );
        let twin = colored.image.into_gray();
        assert_eq!(
            (twin.width(), twin.height()),
            (published.width(), published.height())
        );
        assert!(
            twin.data().iter().all(|&value| value == 255),
            "a colour page must not pay for a full-resolution gray render nobody encodes"
        );

        let grayscale = clean_page(
            &gray,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0)
        .image
        .into_gray();
        assert_eq!(
            (grayscale.width(), grayscale.height()),
            (twin.width(), twin.height())
        );
        assert!(
            grayscale.data().iter().any(|&value| value < 160),
            "the same page in grayscale mode still resamples its ink at full resolution"
        );
    }

    #[test]
    fn a_rotated_resample_keeps_the_per_sample_transform_result_on_every_pixel() {
        let (source, _) = thin_stroke_fixture();
        let width = source.width();
        let height = source.height();
        let cx = width as f64 * 0.5;
        let cy = height as f64 * 0.5;
        let inverse = Affine::translation(-cx, -cy)
            .then(Affine::rotation_radians(1.4_f64.to_radians()))
            .then(Affine::translation(cx, cy));
        let offsets = adaptive_sample_offsets(inverse);
        assert_eq!(
            offsets.len(),
            4,
            "a rotation mixes the axes, so it must still supersample 2x2"
        );

        let matrix = inverse.matrix;
        let row = height / 2;
        let starts = offsets
            .iter()
            .map(|&(offset_x, offset_y)| {
                let source_y = row as f64 + offset_y;
                (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                )
            })
            .collect::<Vec<_>>();
        let (interior_start, interior_end) = interior_column_span(
            &starts,
            matrix[0][0],
            matrix[1][0],
            width,
            source.width(),
            source.height(),
        );
        assert!(
            interior_end.saturating_sub(interior_start) * 10 >= width * 9,
            "the unchecked interior must carry the row, not a sliver: {interior_start}..{interior_end} of {width}"
        );
        assert!(
            interior_start > 0 && interior_end < width,
            "a rotated row must keep bounds-checked borders: {interior_start}..{interior_end} of {width}"
        );

        let color = {
            let mut image = RgbImage::new(width, height, [255; 3]);
            for y in 0..height {
                for x in 0..width {
                    let value = source.get(x, y);
                    image.set(
                        x,
                        y,
                        [value, value.saturating_sub(9), value.saturating_add(6)],
                    );
                }
            }
            image
        };
        let gray_actual = render_affine_gray(&source, width, height, inverse);
        let color_actual = render_affine_rgb(&color, width, height, inverse);

        let mut off_by_one = 0usize;
        for y in 0..height {
            for x in 0..width {
                let mapped = offsets
                    .iter()
                    .map(|&(offset_x, offset_y)| {
                        inverse.apply(Point::new(x as f64 + offset_x, y as f64 + offset_y))
                    })
                    .collect::<Vec<_>>();
                let gray_expected = (mapped
                    .iter()
                    .map(|point| u32::from(sample_bilinear_white(&source, point.x, point.y)))
                    .sum::<u32>()
                    / offsets.len() as u32) as u8;
                let difference = gray_actual.get(x, y).abs_diff(gray_expected);
                assert!(
                    difference <= 1,
                    "gray pixel ({x},{y}) drifted from the per-sample transform: {} vs {gray_expected}",
                    gray_actual.get(x, y)
                );
                off_by_one += usize::from(difference);

                let mut color_expected = [0u32; 3];
                for point in &mapped {
                    let sample = sample_bilinear_rgb_white(&color, point.x, point.y);
                    for (total, value) in color_expected.iter_mut().zip(sample) {
                        *total += u32::from(value);
                    }
                }
                let actual = color_actual.get(x, y);
                for (channel, total) in color_expected.iter().enumerate() {
                    let expected = (total / offsets.len() as u32) as u8;
                    assert!(
                        actual[channel].abs_diff(expected) <= 1,
                        "colour pixel ({x},{y}) channel {channel} drifted: {} vs {expected}",
                        actual[channel]
                    );
                }
            }
        }
        assert!(
            off_by_one * 1_000 <= width * height,
            "the f32 interior accumulation must round with the f64 sampler on all but a handful of pixels: {off_by_one} of {}",
            width * height
        );
    }

    #[test]
    fn routing_crop_area_averages_thin_strokes_instead_of_aliasing_them() {
        let mut source = GrayImage::new(1_024, 1_024, 255);
        for y in 0..source.height() {
            source.set(2, y, 0);
        }

        let sample = crop_gray_to_fit(
            &source,
            Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
            256,
            256,
        );

        assert_eq!((sample.width(), sample.height()), (256, 256));
        assert!(
            sample
                .row(128)
                .iter()
                .any(|&value| (180..=200).contains(&value)),
            "a one-pixel stem must contribute its area to the routing sample: {:?}",
            &sample.row(128)[..4]
        );
        assert!(
            sample.row(128).iter().all(|&value| value > 0),
            "area sampling must not turn a narrow stem into an arbitrary full-black column"
        );
    }

    #[test]
    fn coherent_photo_field_excludes_rules_scanner_bands_and_text() {
        let mut alpha = GrayImage::new(400, 600, 0);
        let mut source = GrayImage::new(400, 600, 210);
        for y in 100..430 {
            for x in 120..350 {
                alpha.set(x, y, 255);
                source.set(x, y, 70 + ((x + y) % 80) as u8);
            }
        }
        for y in 88..94 {
            for x in 0..400 {
                alpha.set(x, y, 255);
                source.set(x, y, 40);
            }
        }
        for band in 0..22 {
            let top = 105 + band * 12;
            for y in top..(top + 4) {
                for x in 0..100 {
                    alpha.set(x, y, 220);
                    source.set(x, y, 80);
                }
            }
        }
        for line in 0..8 {
            let top = 460 + line * 14;
            for y in top..(top + 3) {
                for x in 35..365 {
                    alpha.set(x, y, 255);
                    source.set(x, y, 30);
                }
            }
        }

        let field = coherent_photo_field(&alpha, &source).expect("photo field");
        assert!(field.get(200, 250));
        assert!(field.get(349, 429));
        assert!(!field.get(40, 250), "scanner bands are paper, not photo");
        assert!(!field.get(200, 90), "page rules are not photo");
        assert!(!field.get(200, 470), "text lines are not photo");
    }

    #[test]
    fn trusted_mrc_background_whitens_paper_outside_semantic_tone() {
        let mut gray = GrayImage::new(40, 24, 192);
        let mut color = RgbImage::new(40, 24, [184, 192, 188]);
        let mut mask = BinaryImage::new(40, 24);
        for y in 6..18 {
            for x in 12..28 {
                let value = 45 + ((x + y) % 100) as u8;
                gray.set(x, y, value);
                color.set(x, y, [value, value.saturating_add(8), value]);
                mask.set(x, y, true);
            }
        }
        let (retained, retained_color) =
            white_outside_tonal_plate(&gray, Some(&color), &mask, 25.4);
        for y in 0..24 {
            for x in 0..40 {
                if mask.get(x, y) {
                    assert_eq!(retained.get(x, y), gray.get(x, y));
                    assert_eq!(
                        retained_color.as_ref().unwrap().get(x, y),
                        color.get(x, y)
                    );
                } else if x < 10 || x >= 30 || y < 4 || y >= 20 {
                    assert_eq!(retained.get(x, y), 255);
                    assert_eq!(retained_color.as_ref().unwrap().get(x, y), [255; 3]);
                }
            }
        }
        assert!(
            (193..255).contains(&retained.get(11, 12)),
            "paper immediately outside a tonal plate should feather toward white"
        );
    }

    #[test]
    fn trusted_mrc_background_becomes_neutral_white_without_authored_tone() {
        for paper in [72u8, 112, 152, 192, 232] {
            let gray = GrayImage::new(5, 1, paper);
            let color = RgbImage::new(5, 1, [paper, paper.saturating_add(8), paper]);
            let mask = BinaryImage::new(5, 1);
            let (retained, retained_color) =
                white_outside_tonal_plate(&gray, Some(&color), &mask, 120.0);
            assert_eq!(retained, GrayImage::new(5, 1, 255));
            assert_eq!(
                retained_color,
                Some(RgbImage::new(5, 1, [255; 3])),
                "tinted paper must become neutral rather than retain a color cast"
            );
        }
    }

    #[test]
    fn trusted_mrc_background_is_preserved_only_when_tone_dominates() {
        let mut dominant = BinaryImage::new(100, 100);
        for y in 0..60 {
            for x in 0..100 {
                dominant.set(x, y, true);
            }
        }
        assert!(should_preserve_trusted_background(&dominant));

        let mut minority = BinaryImage::new(100, 100);
        for y in 0..30 {
            for x in 0..100 {
                minority.set(x, y, true);
            }
        }
        assert!(!should_preserve_trusted_background(&minority));
        assert!(!should_preserve_trusted_background(&BinaryImage::new(0, 0)));
    }

    #[test]
    fn trusted_mrc_preview_matches_the_recomposed_final_layers() {
        let background = GrayImage::new(3, 1, 192);
        let mut source_composite = background.clone();
        source_composite.set(0, 0, 24);
        source_composite.set(1, 0, 96);
        source_composite.set(2, 0, 144);
        let mut selection = BinaryImage::new(3, 1);
        selection.set(0, 0, true);

        let (preview, _, layers) = compose_trusted_mrc(
            &background,
            None,
            &source_composite,
            None,
            &selection,
            false,
            false,
            true,
        );

        assert_eq!(preview.get(0, 0), 24);
        assert_eq!(preview.get(1, 0), 192);
        assert_eq!(preview.get(2, 0), 192);
        assert!(layers.is_none());
    }
}
