use super::*;

#[test]
fn analysis_stage_preserves_synthetic_page_dimensions() {
    let source = GrayImage::new(24, 16, 255);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        ..CleanupOptions::default()
    };
    let prepared = run(Input {
        source: &source,
        color_source: None,
        options: &options,
        prepare_quality_raster: true,
        render_policy: PageRenderPolicy::COMPLETE,
        document_prior: None,
        calibration_config: CalibrationConfig::default(),
        cache: None,
        trusted_mrc_background: None,
        timings: &mut PageStageTimings::default(),
    });
    assert_eq!((prepared.full_width, prepared.full_height), (24, 16));
    assert_eq!(
        prepared.split.classification,
        LayoutClassification::SingleUncutPage
    );
}

#[test]
fn final_picture_ownership_applies_manual_zones_before_crop_extension() {
    let rotated = GrayImage::from_vec(
        128,
        128,
        128,
        (0..128)
            .flat_map(|y| {
                (0..128).map(move |x| {
                    if (40..88).contains(&x) && (40..88).contains(&y) {
                        0
                    } else {
                        255
                    }
                })
            })
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let automatic = BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (40..88).contains(&x) && (40..88).contains(&y)
    });
    let options = CleanupOptions {
        crop_content: true,
        manual_zones: crate::ManualZones {
            picture: vec![crate::PictureZone {
                polygon: crate::NormalizedZonePolygon {
                    points: vec![
                        crate::NormalizedZonePoint { x: 0.0, y: 0.0 },
                        crate::NormalizedZonePoint { x: 0.25, y: 0.0 },
                        crate::NormalizedZonePoint { x: 0.25, y: 0.25 },
                        crate::NormalizedZonePoint { x: 0.0, y: 0.25 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: crate::PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let output = finalize_picture_ownership(FinalPictureOwnershipInput {
        rotated: &rotated,
        automatic_picture_mask: Some(&automatic),
        trusted_mrc_owned_tone_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        picture_mask: None,
        content_picture_mask: None,
        options: &options,
        effective_dpi: 300.0,
        calibration: PageCalibration::estimate(&rotated, 300.0, CalibrationConfig::default()),
        content_evidence_complete: false,
    });
    let picture = output.picture_mask.expect("manual owner must be returned");
    let content = output
        .content_picture_mask
        .expect("crop extension must return the updated mask");
    assert!(picture.get(2, 2));
    assert!(picture.get(60, 60));
    assert_eq!(picture, content);
}

#[test]
fn tonal_evidence_fallback_keeps_tone_separate_without_text_vicinity() {
    let image = GrayImage::new(16, 12, 255);
    let output = prepare_tonal_evidence(TonalEvidenceInput {
        rotated: &image,
        layout_normalized: &image,
        text_vicinity_mask: None,
        picture_mask: None,
        automatic_picture_mask: None,
        trusted_mrc_owned_tone_mask: None,
        continuous_tone_mask: None,
        options: &CleanupOptions::default(),
        effective_dpi: 300.0,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        text_line_count: 0,
        blank_scan_candidate: false,
        content_evidence_complete: true,
        content_picture_mask: None,
    });
    assert_eq!(output.tonal_seed_mask.count_black(), 0);
    assert_eq!(output.outside_tone, OutsideTonalEvidence::default());
    assert!(output.tonal_protection_mask.is_none());
    assert!(output.semantic_preservation_alpha.is_none());
    assert!(output.text_soft_edge_ratio.is_none());
}

#[test]
fn mode_stage_pins_mixed_line_art_soft_foreground_override() {
    let image = GrayImage::new(128, 128, 255);
    let owner = Arc::new(BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (32..96).contains(&x) && (32..96).contains(&y)
    }));
    let options = CleanupOptions {
        output_mode: crate::OutputMode::Mixed,
        prefer_soft_alpha_foreground: Some(true),
        ..CleanupOptions::default()
    };
    let output = resolve_mode_and_preservation(ModePreservationInput {
        rotated: &image,
        layout_normalized: &image,
        analysis_rgb: None,
        picture_mask: Some(Arc::clone(&owner)),
        outside_tone: OutsideTonalEvidence::default(),
        picture_tone_evidence: true,
        text_line_count: 2,
        protected_text_blocks: vec![],
        independent_picture_evidence: false,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        options: &options,
        render_policy: PageRenderPolicy::DETAIL_TILE,
        tonal_protection_mask: None,
        tone_semantic_preservation_alpha: None,
        semantic_preservation_alpha: None,
        text_soft_edge_ratio: None,
    });
    assert_eq!(output.resolved_output_mode, crate::OutputMode::Mixed);
    assert!(output.use_soft_alpha_foreground);
    assert_eq!(output.output_picture_mask, Some(owner));
}

#[test]
fn mode_stage_pins_coherent_photo_preservation_and_mask_replacement() {
    let image = GrayImage::new(128, 128, 160);
    let owner = Arc::new(BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (16..112).contains(&x) && (16..112).contains(&y)
    }));
    let options = CleanupOptions {
        output_mode: crate::OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let output = resolve_mode_and_preservation(ModePreservationInput {
        rotated: &image,
        layout_normalized: &image,
        analysis_rgb: None,
        picture_mask: Some(Arc::clone(&owner)),
        outside_tone: OutsideTonalEvidence::default(),
        picture_tone_evidence: true,
        text_line_count: 0,
        protected_text_blocks: vec![],
        independent_picture_evidence: true,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        options: &options,
        render_policy: PageRenderPolicy::COMPLETE,
        tonal_protection_mask: Some(Arc::clone(&owner)),
        tone_semantic_preservation_alpha: None,
        semantic_preservation_alpha: None,
        text_soft_edge_ratio: None,
    });
    assert!(output.preserve_confirmed_photo_tones);
    assert!(output.photographic_picture_mask.is_some());
    assert!(output.output_picture_mask.is_some());
}
