use super::*;

#[test]
fn blank_single_region_has_pinned_raster_and_blankness() {
    let source = GrayImage::new(12, 10, 255);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        output_mode: OutputMode::Bw,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(source.width(), source.height());
    let result = run(Input {
        source: &source,
        routing_source: &source,
        normalized: &source,
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        canonical_routing_sample: &source,
        canonical_leaf_source: &source,
        canonical_routing_dpi: options.dpi,
        calibration: PageCalibration::estimate(&source, options.dpi, CalibrationConfig::default()),
        color_source: None,
        analysis_picture_mask: None,
        source_picture_mask: None,
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        tone_preservation_alpha: None,
        text_mask: None,
        text_vicinity_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        source_page_index: 0,
        split: &split,
        spread_plan: None,
        region: Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
        half: PageHalf::Full,
        cache: None,
        split_cache_key: None,
        source_effectively_blank: true,
        create_mixed_layers: false,
        create_mixed_composite: false,
        timings: &mut PageStageTimings::default(),
    })
    .expect("blank synthetic region should render");
    assert_eq!(result.metadata.output_width, source.width());
    assert_eq!(result.metadata.output_height, source.height());
    assert!(result.effectively_blank);
}

#[test]
fn geometry_stage_keeps_full_page_canvas_and_region_origin() {
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        ..CleanupOptions::default()
    };
    let output = plan_render_geometry(RenderGeometryInput {
        detected: CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        },
        source_effectively_blank: false,
        options: &options,
        region: Rect::new(0.0, 0.0, 32.0, 24.0),
        working_width: 32,
        working_height: 24,
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
    })
    .expect("full-page geometry should be valid");

    assert_eq!(output.output_rect, Rect::new(0.0, 0.0, 32.0, 24.0));
    assert_eq!((output.output_width, output.output_height), (32, 24));
    assert!(output.render_region.is_none());
    assert_eq!((output.rendered_width, output.rendered_height), (32, 24));
    assert_eq!(
        output.render_plan.output_to_source(Point::new(0.0, 0.0)),
        Some(Point::new(0.0, 0.0))
    );
}

#[test]
fn geometry_stage_pins_split_region_crop_coordinates_and_scale() {
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        render_crop: Some(crate::NormalizedRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            rotation: OrthogonalRotation::None,
        }),
        ..CleanupOptions::default()
    };
    let output = plan_render_geometry(RenderGeometryInput {
        detected: CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        },
        source_effectively_blank: false,
        options: &options,
        region: Rect::new(10.0, 4.0, 20.0, 12.0),
        working_width: 20,
        working_height: 12,
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
    })
    .expect("split-page crop geometry should be valid");

    assert_eq!(output.render_region, Some(Rect::new(5.0, 3.0, 10.0, 6.0)));
    assert_eq!(output.sampled_region, output.render_region);
    assert_eq!(
        output.render_plan.output_rect(),
        Rect::new(5.0, 3.0, 10.0, 6.0)
    );
    assert_eq!((output.rendered_width, output.rendered_height), (10, 6));
    assert_eq!(
        output.render_plan.output_to_source(Point::new(0.0, 0.0)),
        Some(Point::new(15.0, 7.0))
    );
}

#[test]
fn raster_stage_preserves_grayscale_source_pixels_on_identity_plan() {
    let source = GrayImage::from_vec(4, 3, 4, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        .expect("synthetic grayscale raster dimensions must be valid");
    let options = CleanupOptions {
        output_mode: OutputMode::Bw,
        ..CleanupOptions::default()
    };
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 4.0, 3.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        4,
        3,
        Rect::new(0.0, 0.0, 4.0, 3.0),
    );
    let output = prepare_render_planes(RasterPlaneInput {
        normalized: &source,
        routing_source: &source,
        color_source: None,
        source_picture_mask: None,
        tone_preservation_alpha: None,
        text_tone_diagnostics: None,
        options: &options,
        preserve_confirmed_photo_tones: false,
        working_width: 4,
        working_height: 3,
        render_region: None,
        sampled_region: None,
        output_rect: Rect::new(0.0, 0.0, 4.0, 3.0),
        render_plan: &plan,
        rendered_width: 4,
        rendered_height: 3,
        region: Rect::new(0.0, 0.0, 4.0, 3.0),
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("identity raster plan should be valid");

    assert_eq!(output.rendered_gray.data(), source.data());
    assert_eq!(output.rendered_source_gray.data(), source.data());
    assert!(output.rendered_color.is_none());
    assert!(output.rendered_tone_alpha.is_none());
}

#[test]
fn raster_stage_keeps_optional_color_and_alpha_planes_aligned() {
    let source = GrayImage::new(3, 2, 80);
    let color = RgbImage::from_vec(
        3,
        2,
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        ],
    )
    .expect("synthetic RGB raster dimensions must be valid");
    let alpha = GrayImage::from_vec(3, 2, 3, vec![20, 40, 60, 80, 100, 120])
        .expect("synthetic alpha dimensions must be valid");
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        ..CleanupOptions::default()
    };
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 3.0, 2.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        3,
        2,
        Rect::new(0.0, 0.0, 3.0, 2.0),
    );
    let output = prepare_render_planes(RasterPlaneInput {
        normalized: &source,
        routing_source: &source,
        color_source: Some(&color),
        source_picture_mask: None,
        tone_preservation_alpha: Some(&alpha),
        text_tone_diagnostics: None,
        options: &options,
        preserve_confirmed_photo_tones: false,
        working_width: 3,
        working_height: 2,
        render_region: None,
        sampled_region: None,
        output_rect: Rect::new(0.0, 0.0, 3.0, 2.0),
        render_plan: &plan,
        rendered_width: 3,
        rendered_height: 2,
        region: Rect::new(0.0, 0.0, 3.0, 2.0),
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("identity color plan should be valid");

    assert_eq!(
        output.rendered_color.expect("color plane is present"),
        color
    );
    let rendered_alpha = output.rendered_tone_alpha.expect("alpha plane is present");
    assert_eq!((rendered_alpha.width(), rendered_alpha.height()), (3, 2));
    assert_eq!(output.rendered_gray, GrayImage::new(3, 2, 255));
}

#[test]
fn mask_stage_keeps_absent_optional_masks_absent() {
    let normalized = GrayImage::new(4, 3, 255);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 4.0, 3.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        4,
        3,
        Rect::new(0.0, 0.0, 4.0, 3.0),
    );
    let output = prepare_region_masks(MaskPreparationInput {
        normalized: &normalized,
        render_plan: &plan,
        rendered_width: 4,
        rendered_height: 3,
        source_picture_mask: None,
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        text_vicinity_mask: None,
        text_mask: None,
        trusted_foreground_mask: None,
        options: &CleanupOptions::default(),
        preserve_confirmed_photo_tones: false,
        text_line_count: 0,
        timings: &mut PageStageTimings::default(),
    });

    assert!(output.rendered_picture_mask.is_none());
    assert!(output.rendered_chroma_picture_mask.is_none());
    assert!(output.rendered_text_mask.is_none());
    assert!(output.rendered_trusted_foreground_mask.is_none());
}

#[test]
fn mask_stage_preserves_overlapping_confirmed_ownership_pixels() {
    let normalized = GrayImage::new(8, 4, 255);
    let mut picture = BinaryImage::new(8, 4);
    picture.set(2, 1, true);
    let mut spatial = BinaryImage::new(8, 4);
    spatial.set(5, 1, true);
    let mut text_vicinity = BinaryImage::new(8, 4);
    text_vicinity.set(2, 1, true);
    text_vicinity.set(5, 1, true);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 4.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        4,
        Rect::new(0.0, 0.0, 8.0, 4.0),
    );
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let output = prepare_region_masks(MaskPreparationInput {
        normalized: &normalized,
        render_plan: &plan,
        rendered_width: 8,
        rendered_height: 4,
        source_picture_mask: Some(&picture),
        halftone_zone_mask: None,
        spatial_tone_mask: Some(&spatial),
        chroma_picture_mask: None,
        tone_picture_mask: None,
        text_vicinity_mask: Some(&text_vicinity),
        text_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        preserve_confirmed_photo_tones: true,
        text_line_count: 2,
        timings: &mut PageStageTimings::default(),
    });

    let picture = output
        .rendered_picture_mask
        .expect("confirmed ownership must produce a mask");
    assert_eq!(picture.count_black(), 2);
    assert!(picture.get(2, 1));
    assert!(picture.get(5, 1));
}
