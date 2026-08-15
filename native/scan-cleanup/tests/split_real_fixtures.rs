use evb_scan_cleanup::{
    png::decode_gray,
    split::{detect_split, FoldBand, LayoutClassification},
    LayoutMode,
};
use scan_primitives::GrayImage;
use serde::Deserialize;
use std::{fs, path::Path};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    id: String,
    file: String,
    expected: LayoutClassification,
    family: String,
    effective_dpi: f64,
    max_dimension: usize,
    #[serde(default)]
    expected_cutter_ratio: Option<f64>,
    #[serde(default)]
    cutter_tolerance_ratio: Option<f64>,
}

fn measured_fold_edges(gray: &GrayImage, cutter_x: f64) -> (f64, f64) {
    let result = detect_split(gray, 150.0, LayoutMode::Auto, Some(cutter_x));
    assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
    match result.diagnostics.fold_band {
        FoldBand::Measured {
            left_x_px,
            right_x_px,
        } => (left_x_px, right_x_px),
        other => panic!("expected a measured fold band, got {other:?}"),
    }
}

#[test]
fn carried_cutter_finds_a_distant_same_side_fold_shadow() {
    let mut page = GrayImage::new(2_200, 900, 255);
    for y in 0..page.height() {
        for x in 0..900 {
            page.set(x, y, 174);
        }
    }
    for y in (28..page.height() - 28).step_by(18) {
        for x in 1_240..2_100 {
            page.set(x, y, 20);
            page.set(x, y + 1, 20);
        }
    }
    for y in 45..855 {
        for x in 1_120..1_172 {
            page.set(x, y, 231);
        }
        for x in 1_130..1_150 {
            page.set(x, y, 184);
        }
    }

    let (left, right) = measured_fold_edges(&page, 1_003.0);
    assert_eq!(left, 1_003.0, "only the right leaf owns this shadow");
    assert!(
        right >= 1_172.0,
        "offset shadow survived at {left}..{right}"
    );
}

#[test]
fn carried_cutter_preserves_a_legacy_one_column_fold_band() {
    let mut page = GrayImage::new(1_000, 600, 245);
    for y in 0..page.height() {
        page.set(500, y, 185);
    }

    assert_eq!(measured_fold_edges(&page, 500.0), (500.0, 501.0));
}

#[test]
fn real_hard_cases_and_spread_controls_follow_stage_b_policy() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split");
    let fixtures: Vec<Fixture> =
        serde_json::from_slice(&fs::read(root.join("fixtures.json")).unwrap()).unwrap();
    assert_eq!(
        fixtures
            .iter()
            .filter(|item| item.family == "hard-case")
            .count(),
        10
    );
    assert_eq!(
        fixtures
            .iter()
            .filter(|item| item.family == "spread-control")
            .count(),
        19
    );
    assert_eq!(
        fixtures
            .iter()
            .filter(|item| item.family == "luther-soft-gutter")
            .count(),
        5
    );

    let mut failures = Vec::new();
    for fixture in fixtures {
        if let Ok(filter) = std::env::var("EVB_SPLIT_FIXTURE_FILTER") {
            if !fixture.id.contains(&filter) {
                continue;
            }
        }
        let image = decode_gray(
            &fs::read(root.join(&fixture.file)).unwrap(),
            (fixture.max_dimension * fixture.max_dimension) as u64,
            fixture.max_dimension as u32,
        )
        .unwrap();
        assert!(
            image.width().max(image.height()) <= fixture.max_dimension,
            "{} is not compact",
            fixture.id
        );
        let result = detect_split(&image, fixture.effective_dpi, LayoutMode::Auto, None);
        if result.classification != fixture.expected {
            failures.push(format!("{}: {result:?}", fixture.id));
            continue;
        }
        if let Some(expected_ratio) = fixture.expected_cutter_ratio {
            let actual_ratio = result.cutter_x.unwrap_or_default() / image.width() as f64;
            let tolerance = fixture.cutter_tolerance_ratio.unwrap_or(0.03);
            if (actual_ratio - expected_ratio).abs() > tolerance {
                failures.push(format!(
                    "{}: cutter ratio {actual_ratio:.4} is outside {expected_ratio:.4} ± {tolerance:.4}; {result:?}",
                    fixture.id
                ));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
