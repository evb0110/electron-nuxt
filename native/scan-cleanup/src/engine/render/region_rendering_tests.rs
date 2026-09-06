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
