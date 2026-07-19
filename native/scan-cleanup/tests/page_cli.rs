use evb_scan_cleanup::png::{decode_gray, encode_gray};
use scan_primitives::GrayImage;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn temp_path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "evb-scan-cleanup-{label}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

#[test]
fn per_page_ocr_mode_writes_atomic_png_and_metadata() {
    let input = temp_path("input", "png");
    let output = temp_path("output", "png");
    let metadata = temp_path("metadata", "json");
    let mut image = GrayImage::new(100, 80, 240);
    for y in (15..65).step_by(10) {
        for x in 12..88 {
            image.set(x, y, 20);
            image.set(x, y + 1, 20);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--metadata",
            metadata.to_str().unwrap(),
            "--ocr-mode",
            "--options",
            r#"{"dpi":300,"normalizeIllumination":false}"#,
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let cleaned = decode_gray(&fs::read(&output).unwrap(), 10_000, 200).unwrap();
    assert_eq!((cleaned.width(), cleaned.height()), (100, 80));
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["inputWidth"], 100);
    assert_eq!(metadata_json["outputWidth"], 100);
    assert!(metadata_json["forwardTransform"]["matrix"].is_array());
    let _ = fs::remove_file(input);
    let _ = fs::remove_file(output);
    let _ = fs::remove_file(metadata);
}

#[test]
fn batch_spread_png_writes_two_output_images_and_per_half_metadata() {
    let input = temp_path("spread-input", "png");
    let output_left = temp_path("spread-left", "png");
    let output_right = temp_path("spread-right", "png");
    let metadata_left = temp_path("spread-left", "json");
    let metadata_right = temp_path("spread-right", "json");
    let manifest = temp_path("spread-manifest", "json");
    let mut image = GrayImage::new(320, 200, 245);
    for y in (35..165).step_by(14) {
        for word in 0..7 {
            for x in 24 + word * 18..(36 + word * 18).min(142) {
                image.set(x, y, 18);
                image.set(x, y + 1, 18);
                image.set(x, y + 2, 18);
            }
            for x in 178 + word * 18..(190 + word * 18).min(296) {
                image.set(x, y, 22);
                image.set(x, y + 1, 22);
                image.set(x, y + 2, 22);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "sharedOptions": {
            "dpi": 150,
            "layout": "force-two-page",
            "normalizeIllumination": false,
            "marginsPixels": [0, 0, 0, 0]
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 7,
            "outputs": [
                {"outputPath": output_left, "metadataPath": metadata_left},
                {"outputPath": output_right, "metadataPath": metadata_right}
            ]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    for (path, metadata_path, expected_half) in [
        (&output_left, &metadata_left, "left"),
        (&output_right, &metadata_right, "right"),
    ] {
        let output = decode_gray(&fs::read(path).unwrap(), 100_000, 400).unwrap();
        assert!(output.width() < image.width());
        let metadata_json: Value =
            serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        assert_eq!(metadata_json["sourcePageIndex"], 7);
        assert_eq!(metadata_json["half"], expected_half);
        assert_eq!(metadata_json["layoutClassification"], "two-page-spread");
        assert!(metadata_json["forwardTransform"]["matrix"].is_array());
        assert!(metadata_json["inverseTransform"]["matrix"].is_array());
    }
    for path in [
        input,
        output_left,
        output_right,
        metadata_left,
        metadata_right,
        manifest,
    ] {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn batch_matches_final_page_canvases_with_bottom_right_alignment() {
    let input_small = temp_path("uniform-small-input", "png");
    let input_large = temp_path("uniform-large-input", "png");
    let output_small = temp_path("uniform-small-output", "png");
    let output_large = temp_path("uniform-large-output", "png");
    let metadata_small = temp_path("uniform-small-metadata", "json");
    let metadata_large = temp_path("uniform-large-metadata", "json");
    let manifest = temp_path("uniform-manifest", "json");
    let mut small = GrayImage::new(80, 60, 255);
    small.set(5, 7, 0);
    let mut large = GrayImage::new(100, 90, 255);
    large.set(8, 9, 0);
    fs::write(&input_small, encode_gray(&small).unwrap()).unwrap();
    fs::write(&input_large, encode_gray(&large).unwrap()).unwrap();
    let payload = serde_json::json!({
        "sharedOptions": {
            "dpi": 300,
            "layout": "force-single",
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "pageAlignment": "bottom-right"
        },
        "pages": [
            {
                "inputPath": input_small,
                "outputPath": output_small,
                "metadataPath": metadata_small
            },
            {
                "inputPath": input_large,
                "outputPath": output_large,
                "metadataPath": metadata_large
            }
        ]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let matched_small = decode_gray(&fs::read(&output_small).unwrap(), 20_000, 200).unwrap();
    let matched_large = decode_gray(&fs::read(&output_large).unwrap(), 20_000, 200).unwrap();
    assert_eq!((matched_small.width(), matched_small.height()), (100, 90));
    assert_eq!((matched_large.width(), matched_large.height()), (100, 90));
    assert!(matched_small.get(25, 37) < 200);
    assert_eq!(matched_small.get(5, 7), 255);

    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata_small).unwrap()).unwrap();
    assert_eq!(
        metadata_json["softMarginsPixels"],
        serde_json::json!([20, 30, 0, 0])
    );
    assert_eq!(metadata_json["uniformCanvas"], true);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][0][2], 20.0);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][1][2], 30.0);
    assert_eq!(metadata_json["inverseTransform"]["matrix"][0][2], -20.0);
    assert_eq!(metadata_json["inverseTransform"]["matrix"][1][2], -30.0);

    for path in [
        input_small,
        input_large,
        output_small,
        output_large,
        metadata_small,
        metadata_large,
        manifest,
    ] {
        let _ = fs::remove_file(path);
    }
}
