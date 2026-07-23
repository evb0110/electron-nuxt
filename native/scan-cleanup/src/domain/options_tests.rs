use super::{
    CleanupOptions, DespeckleLevel, MarginsMm, NormalizedRect, OrthogonalRotation, OutputMode,
    PageAlignment, PictureZoneLayer, PlacementOverrides,
};
use crate::domain::geometry::PageHalf;
use scan_primitives::Rect;

#[test]
fn page_alignment_covers_all_nine_anchor_positions() {
    let width = 20;
    let height = 30;
    assert_eq!(PageAlignment::TopLeft.offset(width, height), (0, 0));
    assert_eq!(PageAlignment::TopCenter.offset(width, height), (10, 0));
    assert_eq!(PageAlignment::TopRight.offset(width, height), (20, 0));
    assert_eq!(PageAlignment::CenterLeft.offset(width, height), (0, 15));
    assert_eq!(PageAlignment::Center.offset(width, height), (10, 15));
    assert_eq!(PageAlignment::CenterRight.offset(width, height), (20, 15));
    assert_eq!(PageAlignment::BottomLeft.offset(width, height), (0, 30));
    assert_eq!(PageAlignment::BottomCenter.offset(width, height), (10, 30));
    assert_eq!(PageAlignment::BottomRight.offset(width, height), (20, 30));
}

#[test]
fn per_output_placement_overrides_the_document_default() {
    let options = CleanupOptions {
        page_alignment: PageAlignment::TopLeft,
        placement_overrides: PlacementOverrides {
            right: Some(PageAlignment::BottomRight),
            ..PlacementOverrides::default()
        },
        ..CleanupOptions::default()
    };
    assert_eq!(
        options.placement_for(PageHalf::Left),
        PageAlignment::TopLeft
    );
    assert_eq!(
        options.placement_for(PageHalf::Right),
        PageAlignment::BottomRight
    );
}

#[test]
fn normalized_content_rect_round_trips_with_named_units() {
    let json = r#"{
        "manualContentBoxes": {
            "left": {
                "xNormalized": 0.1,
                "yNormalized": 0.2,
                "widthNormalized": 0.5,
                "heightNormalized": 0.6,
                "rotationDegrees": 90
            }
        },
        "rotationDegrees": 90
    }"#;
    let options: CleanupOptions = serde_json::from_str(json).unwrap();
    let encoded = serde_json::to_value(&options).unwrap();
    assert_eq!(encoded["manualContentBoxes"]["left"]["xNormalized"], 0.1);
    assert_eq!(
        options.resolved_manual_content_for(PageHalf::Left, 1000, 500),
        Some(Rect::new(100.0, 100.0, 500.0, 300.0))
    );
    assert_eq!(
        options.manual_content_boxes.left,
        Some(NormalizedRect {
            x: 0.1,
            y: 0.2,
            width: 0.5,
            height: 0.6,
            rotation: OrthogonalRotation::Clockwise90,
        })
    );
}

#[test]
fn rotation_uses_the_numeric_contract_and_accepts_legacy_scalar_strings() {
    assert_eq!(
        serde_json::from_str::<OrthogonalRotation>("90").unwrap(),
        OrthogonalRotation::Clockwise90
    );
    assert_eq!(
        serde_json::from_str::<OrthogonalRotation>(r#""270""#).unwrap(),
        OrthogonalRotation::Clockwise270
    );
    assert_eq!(
        serde_json::to_string(&OrthogonalRotation::Clockwise180).unwrap(),
        "180"
    );
    assert!(serde_json::from_str::<OrthogonalRotation>("45").is_err());
}

#[test]
fn validation_rejects_nonfinite_dpi_and_margins() {
    for dpi in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -300.0] {
        assert!(CleanupOptions {
            dpi,
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }
    assert!(CleanupOptions {
        margins_mm: Some(MarginsMm {
            left_mm: -1.0,
            ..MarginsMm::default()
        }),
        ..CleanupOptions::default()
    }
    .validate()
    .is_err());
}

#[test]
fn advanced_control_ranges_are_validated_and_serialize_additively() {
    for angle in [f64::NEG_INFINITY, -15.1, 15.1, f64::INFINITY, f64::NAN] {
        assert!(CleanupOptions {
            manual_skew_degrees: Some(angle),
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }
    for depth in [f64::NEG_INFINITY, 0.49, 4.01, f64::INFINITY, f64::NAN] {
        assert!(CleanupOptions {
            experimental: super::ExperimentalOptions {
                auto_dewarp: true,
                auto_dewarp_depth: Some(depth),
            },
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }

    let defaults = serde_json::to_value(CleanupOptions::default()).unwrap();
    assert!(defaults.get("manualSkewDegrees").is_none());
    assert!(defaults["experimental"].get("autoDewarpDepth").is_none());

    let options = CleanupOptions {
        manual_skew_degrees: Some(-2.4),
        experimental: super::ExperimentalOptions {
            auto_dewarp: true,
            auto_dewarp_depth: Some(1.7),
        },
        ..CleanupOptions::default()
    };
    options.validate().unwrap();
    let encoded = serde_json::to_value(options).unwrap();
    assert_eq!(encoded["manualSkewDegrees"], -2.4);
    assert_eq!(encoded["experimental"]["autoDewarpDepth"], 1.7);
}

#[test]
fn option_objects_reject_unknown_fields() {
    assert!(serde_json::from_str::<CleanupOptions>(r#"{"unknown":true}"#).is_err());
    assert!(serde_json::from_str::<CleanupOptions>(
        r#"{"margins":{"leftMm":5,"topMm":5,"rightMm":5,"bottomMm":5,"unknown":true}}"#
    )
    .is_err());
}

#[test]
fn legacy_despeckle_boolean_maps_to_a_default_normal_level() {
    let enabled: CleanupOptions = serde_json::from_str(r#"{"despeckle":true}"#).unwrap();
    assert_eq!(enabled.despeckle_level, DespeckleLevel::Normal);
    assert_eq!(enabled.effective_despeckle_level(), DespeckleLevel::Normal);

    let disabled: CleanupOptions = serde_json::from_str(r#"{"despeckle":false}"#).unwrap();
    assert_eq!(disabled.effective_despeckle_level(), DespeckleLevel::Off);
}

#[test]
fn mixed_mode_and_zone_schema_are_additive_and_rotation_checked() {
    let json = r#"{
        "outputMode":"mixed",
        "manualZones":{
            "picture":[{
                "polygon":{
                    "points":[
                        {"xNormalized":0.1,"yNormalized":0.2},
                        {"xNormalized":0.8,"yNormalized":0.2},
                        {"xNormalized":0.8,"yNormalized":0.9}
                    ],
                    "rotationDegrees":90
                },
                "layer":"eraser3"
            }],
            "fill":[]
        },
        "rotationDegrees":90
    }"#;
    let options: CleanupOptions = serde_json::from_str(json).unwrap();
    assert_eq!(options.output_mode, OutputMode::Mixed);
    assert_eq!(
        options.manual_zones.picture[0].layer,
        PictureZoneLayer::Eraser3
    );
    options.validate().unwrap();

    let old: CleanupOptions = serde_json::from_str(r#"{"outputMode":"bw"}"#).unwrap();
    assert!(old.manual_zones.picture.is_empty());
    assert!(old.manual_zones.fill.is_empty());

    let wrong_rotation = json.replace(
        "\"rotationDegrees\":90\n    }",
        "\"rotationDegrees\":0\n    }",
    );
    let invalid: CleanupOptions = serde_json::from_str(&wrong_rotation).unwrap();
    assert!(invalid.validate().is_err());
}
