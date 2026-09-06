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
