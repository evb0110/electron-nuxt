mod tests {
    use super::*;
    use crate::bw::binarize_normalized;

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
            .image;
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
        let prepared = prepare_analysis_page(
            &source,
            &options,
            true,
            None,
            CalibrationConfig::default(),
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
            .image;
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
    fn color_normalization_flattens_gutter_shadow_and_preserves_chroma() {
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
                gray.set(x, y, 54);
                color.set(x, y, [96, 42, 24]);
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
        assert!(shadow_paper[0] > shadow_paper[1] && shadow_paper[1] > shadow_paper[2]);
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
            ink_bounds(&grayscale.image, 220)
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
        let (left, top, right, bottom) = ink_bounds(&output.image, 128).unwrap();
        let right_margin = output.image.width() - 1 - right;
        let bottom_margin = output.image.height() - 1 - bottom;
        assert!(left >= 12 && top >= 12 && right_margin >= 12 && bottom_margin >= 12);
        assert!(
            left.abs_diff(right_margin) <= 2,
            "left={left} right={right_margin}"
        );
        assert!(
            top.abs_diff(bottom_margin) <= 2,
            "top={top} bottom={bottom_margin}"
        );
        assert!(output.image.data()[..output.image.width()]
            .iter()
            .all(|&value| value == 255));
        assert!(
            output.image.data()[output.image.data().len() - output.image.width()..]
                .iter()
                .all(|&value| value == 255)
        );
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
        assert_eq!(grid.output_width, output.metadata.crop_rect.width.ceil() as usize);
        assert_eq!(grid.output_height, output.metadata.crop_rect.height.ceil() as usize);
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
        assert_eq!(analysis.outputs[0].crop_rect, Rect::new(0.0, 0.0, 3_000.0, 2_000.0));
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
        assert!(blank.image.data().iter().all(|&value| value == 255));
        assert!(!blank.image.data().iter().all(|&value| value == 0));
    }
}
