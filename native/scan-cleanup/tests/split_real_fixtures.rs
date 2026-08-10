use evb_scan_cleanup::{
    png::decode_gray,
    split::{detect_split, LayoutClassification},
    LayoutMode,
};
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
