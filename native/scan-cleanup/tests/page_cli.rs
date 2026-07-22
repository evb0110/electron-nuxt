use evb_scan_cleanup::{
    png::{decode_gray, encode_gray},
    CleanupOptions,
};
use scan_primitives::GrayImage;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
fn manifest_v2_emits_typed_progress_and_terminal_result() {
    let input = temp_path("v2-input", "png");
    let page_metadata = temp_path("v2-page", "json");
    let manifest = temp_path("v2-manifest", "json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 2,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": CleanupOptions::default(),
            "outputs": [],
        }],
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
    assert!(!String::from_utf8_lossy(&result.stderr).contains("DEPRECATED"));
    let envelopes = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(envelopes.first().unwrap()["type"], "progress");
    assert_eq!(envelopes.first().unwrap()["progress"]["stage"], "started");
    assert_eq!(envelopes.last().unwrap()["type"], "result");
    assert_eq!(envelopes.last().unwrap()["result"]["status"], "success");
    assert!(page_metadata.exists());

    let _ = fs::remove_file(input);
    let _ = fs::remove_file(page_metadata);
    let _ = fs::remove_file(manifest);
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
    assert_eq!(metadata_json["inputWidthPx"], 100);
    assert_eq!(metadata_json["outputWidthPx"], 100);
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
            "rotation": 90,
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
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("DEPRECATED: accepting scan-cleanup manifest v1"));
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
        assert_eq!(metadata_json["rotationDegrees"], 90);
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
fn classify_only_batch_writes_metadata_and_ndjson_but_no_output_images() {
    let spread_input = temp_path("classify-spread-input", "png");
    let single_input = temp_path("classify-single-input", "png");
    let spread_output = temp_path("classify-spread-output", "png");
    let single_output = temp_path("classify-single-output", "png");
    let spread_output_metadata = temp_path("classify-spread-output", "json");
    let single_output_metadata = temp_path("classify-single-output", "json");
    let spread_page_metadata = temp_path("classify-spread-page", "json");
    let single_page_metadata = temp_path("classify-single-page", "json");
    let manifest = temp_path("classify-manifest", "json");

    let mut spread = GrayImage::new(320, 200, 245);
    for y in (35..165).step_by(14) {
        for x in 24..142 {
            spread.set(x, y, 18);
            spread.set(x, y + 1, 18);
        }
        for x in 178..296 {
            spread.set(x, y, 22);
            spread.set(x, y + 1, 22);
        }
    }
    for y in 4..196 {
        spread.set(159, y, 105);
        spread.set(160, y, 175);
    }
    let mut single = GrayImage::new(180, 280, 245);
    for y in (32..248).step_by(16) {
        for x in 22..158 {
            single.set(x, y, 20);
            single.set(x, y + 1, 20);
        }
    }
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();
    let payload = serde_json::json!({
        "classifyOnly": true,
        "sharedOptions": {
            "dpi": 150,
            "normalizeIllumination": false
        },
        "pages": [
            {
                "inputPath": spread_input,
                "sourcePageIndex": 0,
                "classifyOnly": true,
                "pageMetadataPath": spread_page_metadata,
                "outputPath": spread_output,
                "metadataPath": spread_output_metadata
            },
            {
                "inputPath": single_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": single_page_metadata,
                "outputPath": single_output,
                "metadataPath": single_output_metadata,
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "normalizeIllumination": false
                }
            }
        ]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let progress = String::from_utf8(result.stdout).unwrap();
    let lines = progress
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines[1]["progress"]["classification"], "two-page-spread");
    assert!(lines[1]["progress"]["confidence"].as_f64().is_some());
    assert!(lines[1]["progress"]["cutterXPx"].as_f64().is_some());
    assert_eq!(lines[2]["progress"]["classification"], "single-uncut-page");
    assert_eq!(lines[2]["progress"]["confidence"], 1.0);
    assert!(lines[2]["progress"].get("cutterXPx").is_none());

    let spread_metadata: Value =
        serde_json::from_slice(&fs::read(&spread_page_metadata).unwrap()).unwrap();
    let single_metadata: Value =
        serde_json::from_slice(&fs::read(&single_page_metadata).unwrap()).unwrap();
    assert_eq!(spread_metadata["layoutClassification"], "two-page-spread");
    assert_eq!(single_metadata["layoutClassification"], "single-uncut-page");
    for output in [
        &spread_output,
        &single_output,
        &spread_output_metadata,
        &single_output_metadata,
    ] {
        assert!(!output.exists(), "classify-only wrote {}", output.display());
    }

    for path in [
        spread_input,
        single_input,
        spread_page_metadata,
        single_page_metadata,
        manifest,
    ] {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn classify_only_inside_page_options_with_declared_outputs_writes_no_images() {
    let input = temp_path("nested-classify-input", "png");
    let output_first = temp_path("nested-classify-first", "png");
    let output_second = temp_path("nested-classify-second", "png");
    let metadata_first = temp_path("nested-classify-first", "json");
    let metadata_second = temp_path("nested-classify-second", "json");
    let manifest = temp_path("nested-classify-manifest", "json");

    let mut image = GrayImage::new(180, 280, 245);
    for y in (32..248).step_by(16) {
        for x in 22..158 {
            image.set(x, y, 20);
            image.set(x, y + 1, 20);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "sharedOptions": {},
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 40,
            "options": {
                "dpi": 150.0,
                "layout": "auto",
                "classifyOnly": true,
                "normalizeIllumination": false
            },
            "outputs": [
                {"outputPath": output_first, "metadataPath": metadata_first},
                {"outputPath": output_second, "metadataPath": metadata_second}
            ]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout).unwrap();
    let lines = progress
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(lines[1]["progress"]["classification"].as_str().is_some());
    assert_eq!(lines[1]["progress"]["outputPaths"], serde_json::json!([]));

    let metadata: Value = serde_json::from_slice(&fs::read(&metadata_first).unwrap()).unwrap();
    assert_eq!(metadata["sourcePageIndex"], 40);
    assert!(metadata["layoutClassification"].as_str().is_some());
    assert_eq!(metadata["outputCount"], 1);
    for output in [&output_first, &output_second] {
        assert!(!output.exists(), "classify-only wrote {}", output.display());
    }
    assert!(
        !metadata_second.exists(),
        "classify-only wrote per-output metadata instead of one page sidecar"
    );

    for path in [input, metadata_first, manifest] {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn parallel_batch_outputs_and_progress_are_deterministic() {
    let input = temp_path("parallel-determinism-input", "png");
    let manifest = temp_path("parallel-determinism-manifest", "json");
    let mut image = GrayImage::new(620, 440, 242);
    let mut state = 0xd37e_4a91_u64;
    for y in 0..image.height() {
        for x in 0..image.width() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            image.set(x, y, 232 + ((state >> 61) as u8));
        }
    }
    for y in (48..392).step_by(17) {
        for x in 52..568 {
            if x % 29 < 21 {
                image.set(x, y, 28);
                image.set(x, y + 1, 28);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let artifacts = (0..4)
        .map(|index| {
            (
                temp_path(&format!("parallel-determinism-{index}"), "png"),
                temp_path(&format!("parallel-determinism-{index}"), "json"),
            )
        })
        .collect::<Vec<_>>();
    let pages = artifacts
        .iter()
        .enumerate()
        .map(|(index, (output, metadata))| {
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "cropContent": false,
                    "outputMode": "bw"
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({"pages": pages})).unwrap(),
    )
    .unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args([
                "--allow-manifest-v1",
                "--manifest",
                manifest.to_str().unwrap(),
            ])
            .output()
            .unwrap()
    };
    let first = run();
    assert!(
        first.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_artifacts = artifacts
        .iter()
        .map(|(output, metadata)| (fs::read(output).unwrap(), fs::read(metadata).unwrap()))
        .collect::<Vec<_>>();
    let second = run();
    assert!(
        second.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(first.stdout, second.stdout);
    let progress = String::from_utf8(second.stdout).unwrap();
    let completed_pages = progress
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["progress"]["stage"] == "page-complete")
        .map(|event| event["progress"]["pageNumber"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(completed_pages, vec![1, 2, 3, 4]);
    for ((output, metadata), (expected_output, expected_metadata)) in
        artifacts.iter().zip(first_artifacts)
    {
        assert_eq!(fs::read(output).unwrap(), expected_output);
        assert_eq!(fs::read(metadata).unwrap(), expected_metadata);
    }

    let _ = fs::remove_file(input);
    let _ = fs::remove_file(manifest);
    for (output, metadata) in artifacts {
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(metadata);
    }
}

#[cfg(unix)]
#[test]
fn sigterm_terminates_parallel_batch_promptly() {
    let input = temp_path("sigterm-input", "png");
    let manifest = temp_path("sigterm-manifest", "json");
    let image = GrayImage::new(2_400, 1_800, 238);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let metadata_paths = (0..12)
        .map(|index| temp_path(&format!("sigterm-page-{index}"), "json"))
        .collect::<Vec<_>>();
    let pages = metadata_paths
        .iter()
        .enumerate()
        .map(|(index, metadata)| {
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": metadata,
                "classifyOnly": true,
                "options": {
                    "dpi": 150,
                    "layout": "auto"
                }
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({"pages": pages})).unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut started_line = String::new();
    stdout.read_line(&mut started_line).unwrap();
    let started_event: Value = serde_json::from_str(&started_line).unwrap();
    assert_eq!(started_event["progress"]["stage"], "started");
    assert!(
        child.try_wait().unwrap().is_none(),
        "fixture finished before SIGTERM"
    );
    let started = Instant::now();
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = loop {
        if let Some(exit) = child.try_wait().unwrap() {
            break exit;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "SIGTERM was not prompt"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!exit.success());

    let _ = fs::remove_file(input);
    let _ = fs::remove_file(manifest);
    for path in metadata_paths {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn batch_applies_per_output_placement_over_document_default() {
    let input_small = temp_path("uniform-small-input", "png");
    let input_large = temp_path("uniform-large-input", "png");
    let output_small = temp_path("uniform-small-output", "png");
    let output_large = temp_path("uniform-large-output", "png");
    let metadata_small = temp_path("uniform-small-metadata", "json");
    let metadata_large = temp_path("uniform-large-metadata", "json");
    let manifest = temp_path("uniform-manifest", "json");
    let mut small = GrayImage::new(80, 60, 255);
    for y in [7, 18, 29] {
        for x in 5..25 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
            small.set(x, y + 2, 0);
        }
        for x in 31..51 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
            small.set(x, y + 2, 0);
        }
    }
    let mut large = GrayImage::new(100, 90, 255);
    for y in [9, 22, 35, 48] {
        for x in 8..34 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
            large.set(x, y + 2, 0);
        }
        for x in 42..68 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
            large.set(x, y + 2, 0);
        }
    }
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
            "pageAlignment": "top-left"
        },
        "pages": [
            {
                "inputPath": input_small,
                "outputPath": output_small,
                "metadataPath": metadata_small,
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-left",
                    "placementOverrides": {"full": "bottom-right"}
                }
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
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
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
        metadata_json["softMarginsPx"],
        serde_json::json!([20, 30, 0, 0])
    );
    assert_eq!(metadata_json["uniformCanvas"], true);
    assert_eq!(metadata_json["outputWidthPx"], 80);
    assert_eq!(metadata_json["outputHeightPx"], 60);
    assert_eq!(metadata_json["canvasWidthPx"], 100);
    assert_eq!(metadata_json["canvasHeightPx"], 90);
    assert_eq!(metadata_json["placementOffsetXPx"], 20);
    assert_eq!(metadata_json["placementOffsetYPx"], 30);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][0][2], 0.0);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][1][2], 0.0);

    let mut preview_payload = payload;
    preview_payload["previewMode"] = Value::Bool(true);
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let preview_result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        preview_result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&preview_result.stderr)
    );
    let intrinsic_small = decode_gray(&fs::read(&output_small).unwrap(), 20_000, 200).unwrap();
    let intrinsic_large = decode_gray(&fs::read(&output_large).unwrap(), 20_000, 200).unwrap();
    assert_eq!(
        (intrinsic_small.width(), intrinsic_small.height()),
        (80, 60)
    );
    assert_eq!(
        (intrinsic_large.width(), intrinsic_large.height()),
        (100, 90)
    );
    let preview_metadata: Value =
        serde_json::from_slice(&fs::read(&metadata_small).unwrap()).unwrap();
    assert_eq!(preview_metadata["canvasWidthPx"], 100);
    assert_eq!(preview_metadata["canvasHeightPx"], 90);
    assert_eq!(preview_metadata["placementOffsetXPx"], 20);
    assert_eq!(preview_metadata["placementOffsetYPx"], 30);
    for metadata_path in [&metadata_small, &metadata_large] {
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        let intrinsic_width = metadata["outputWidthPx"].as_u64().unwrap();
        let intrinsic_height = metadata["outputHeightPx"].as_u64().unwrap();
        let canvas_width = metadata["canvasWidthPx"].as_u64().unwrap();
        let canvas_height = metadata["canvasHeightPx"].as_u64().unwrap();
        let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap();
        let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap();
        assert!(canvas_width >= intrinsic_width);
        assert!(canvas_height >= intrinsic_height);
        assert!(offset_x + intrinsic_width <= canvas_width);
        assert!(offset_y + intrinsic_height <= canvas_height);
    }

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

#[test]
fn matched_canvas_uses_robust_quantile_and_reports_intrinsic_overflow() {
    let manifest = temp_path("matched-quantile-manifest", "json");
    let mut cleanup_paths = vec![manifest.clone()];
    let mut pages = Vec::new();
    let mut output_paths = Vec::new();
    let mut metadata_paths = Vec::new();
    for index in 0..10 {
        let input = temp_path(&format!("matched-quantile-input-{index}"), "png");
        let output = temp_path(&format!("matched-quantile-output-{index}"), "png");
        let metadata = temp_path(&format!("matched-quantile-metadata-{index}"), "json");
        let (width, height) = if index == 9 { (140, 100) } else { (80, 60) };
        let mut image = GrayImage::new(width, height, 255);
        for y in 15..height.min(45) {
            for x in 18..width.min(62) {
                if y % 7 < 3 {
                    image.set(x, y, 20);
                }
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "outputPath": output,
            "metadataPath": metadata,
        }));
        cleanup_paths.push(input);
        cleanup_paths.push(output.clone());
        cleanup_paths.push(metadata.clone());
        output_paths.push(output);
        metadata_paths.push(metadata);
    }
    let payload = serde_json::json!({
        "sharedOptions": {
            "dpi": 300,
            "layout": "force-single",
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "pageAlignment": "center"
        },
        "pages": pages
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    for index in 0..10 {
        let image = decode_gray(&fs::read(&output_paths[index]).unwrap(), 20_000, 200).unwrap();
        let metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_paths[index]).unwrap()).unwrap();
        assert_eq!(metadata["matchedCanvasTargetWidthPx"], 80);
        assert_eq!(metadata["matchedCanvasTargetHeightPx"], 60);
        if index == 9 {
            assert_eq!((image.width(), image.height()), (140, 100));
            assert_eq!(metadata["canvasPolicy"], "overflow-intrinsic");
            assert_eq!(metadata["canvasOverflow"], true);
            assert_eq!(metadata["uniformCanvas"], false);
            assert_eq!(metadata["canvasWidthPx"], 140);
            assert_eq!(metadata["canvasHeightPx"], 100);
            assert!(metadata["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning.as_str().unwrap().contains("would clip")));
        } else {
            assert_eq!((image.width(), image.height()), (80, 60));
            assert_eq!(metadata["canvasPolicy"], "robust-quantile");
            assert_eq!(metadata["canvasOverflow"], false);
            assert_eq!(metadata["uniformCanvas"], true);
        }
    }

    for path in cleanup_paths {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn batch_preserves_asymmetric_margin_order_in_named_metadata() {
    let input = temp_path("asymmetric-margins-input", "png");
    let output = temp_path("asymmetric-margins-output", "png");
    let metadata = temp_path("asymmetric-margins-metadata", "json");
    let manifest = temp_path("asymmetric-margins-manifest", "json");
    let mut image = GrayImage::new(180, 140, 255);
    for y in (35..105).step_by(12) {
        for word in 0..5 {
            for x in 42 + word * 20..58 + word * 20 {
                image.set(x, y, 20);
                image.set(x, y + 1, 20);
                image.set(x, y + 2, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "sharedOptions": {
            "dpi": 150,
            "layout": "force-single",
            "normalizeIllumination": false,
            "outputMode": "grayscale",
            "cropContent": true,
            "matchPageSize": false,
            "marginsPixels": [7, 11, 17, 23]
        },
        "pages": [{
            "inputPath": input,
            "outputPath": output,
            "metadataPath": metadata
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--allow-manifest-v1",
            "--manifest",
            manifest.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(
        metadata_json["appliedMargins"],
        serde_json::json!({
            "leftPx": 7.0,
            "topPx": 11.0,
            "rightPx": 17.0,
            "bottomPx": 23.0
        })
    );
    let content = &metadata_json["contentBox"];
    assert_eq!(
        metadata_json["outputWidthPx"].as_f64().unwrap(),
        (content["widthPx"].as_f64().unwrap() + 24.0).ceil()
    );
    assert_eq!(
        metadata_json["outputHeightPx"].as_f64().unwrap(),
        (content["heightPx"].as_f64().unwrap() + 34.0).ceil()
    );

    for path in [input, output, metadata, manifest] {
        let _ = fs::remove_file(path);
    }
}
