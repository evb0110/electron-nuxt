use evb_scan_cleanup::{
    io::pbm::decode_p4,
    png::{decode_gray, decode_image, encode_gray, encode_rgb, RgbImage},
    CleanupOptions, LayoutMode, ManualZones, NormalizedZonePoint, NormalizedZonePolygon,
    OrthogonalRotation, OutputMode, PictureZone, PictureZoneLayer,
};
use scan_primitives::GrayImage;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(test: &str) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-cli-{test}-{}-{nonce}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn manifest_v3_emits_typed_progress_and_terminal_result() {
    let scratch = Scratch::new("v3");
    let input = scratch.path("v3-input.png");
    let page_metadata = scratch.path("v3-page.json");
    let manifest = scratch.path("v3-manifest.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
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
}

#[cfg(unix)]
#[test]
fn gated_multi_page_analysis_reports_progress_before_reconciliation_completes() {
    let scratch = Scratch::new("gated");
    let input = scratch.path("analysis-progress-input.png");
    let gated_input = scratch.path("analysis-progress-gate.fifo");
    let manifest = scratch.path("analysis-progress-manifest.json");
    let metadata_paths = [
        scratch.path("analysis-progress-page-1.json"),
        scratch.path("analysis-progress-page-2.json"),
    ];
    let encoded = encode_gray(&GrayImage::new(320, 240, 245)).unwrap();
    fs::write(&input, &encoded).unwrap();
    assert!(Command::new("mkfifo")
        .arg(&gated_input)
        .status()
        .unwrap()
        .success());
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": metadata_paths[0],
                "options": CleanupOptions::default(),
                "outputs": [],
            },
            {
                "inputPath": gated_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": metadata_paths[1],
                "options": CleanupOptions::default(),
                "outputs": [],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut events = Vec::new();
        for line in BufReader::new(stdout).lines() {
            let event = serde_json::from_str::<Value>(&line.unwrap()).unwrap();
            sender.send(event.clone()).unwrap();
            events.push(event);
        }
        events
    });

    let first_analyzed = loop {
        match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(event) if event["progress"]["stage"] == "page-analyzed" => break event,
            Ok(event) => assert_ne!(event["progress"]["stage"], "page-complete"),
            Err(error) => {
                let _ = child.kill();
                panic!("analysis progress did not arrive while the second page was gated: {error}");
            }
        }
    };
    assert_eq!(first_analyzed["progress"]["completedPages"], 1);
    assert_eq!(first_analyzed["progress"]["pageNumber"], 1);
    assert!(first_analyzed["progress"].get("classification").is_none());
    assert!(
        child.try_wait().unwrap().is_none(),
        "the gated second page should keep batch reconciliation pending"
    );

    fs::write(&gated_input, encoded).unwrap();
    let status = child.wait().unwrap();
    let events = reader.join().unwrap();
    assert!(status.success());
    let first_analysis_index = events
        .iter()
        .position(|event| event["progress"]["stage"] == "page-analyzed")
        .unwrap();
    let last_page_index = events
        .iter()
        .rposition(|event| event["progress"]["stage"] == "page-complete")
        .unwrap();
    assert!(first_analysis_index < last_page_index);
}

#[test]
fn final_manifest_writes_pbm_only_for_binary_outputs_and_marks_metadata() {
    let scratch = Scratch::new("bilevel");
    let input = scratch.path("bilevel-input.png");
    let manifest = scratch.path("bilevel-manifest.json");
    let bw_output = scratch.path("bilevel-bw.png");
    let bw_metadata = scratch.path("bilevel-bw.json");
    let bw_pbm = scratch.path("bilevel-bw.pbm");
    let gray_output = scratch.path("bilevel-gray.png");
    let gray_metadata = scratch.path("bilevel-gray.json");
    let gray_pbm = scratch.path("bilevel-gray.pbm");
    let bw_page_metadata = scratch.path("bilevel-bw-page.json");
    let gray_page_metadata = scratch.path("bilevel-gray-page.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    let grayscale_options = CleanupOptions {
        output_mode: evb_scan_cleanup::OutputMode::Grayscale,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": bw_page_metadata,
                "options": CleanupOptions::default(),
                "outputs": [{
                    "outputPath": bw_output,
                    "metadataPath": bw_metadata,
                    "bilevelOutputPath": bw_pbm,
                }],
            },
            {
                "inputPath": input,
                "sourcePageIndex": 1,
                "pageMetadataPath": gray_page_metadata,
                "options": grayscale_options,
                "outputs": [{
                    "outputPath": gray_output,
                    "metadataPath": gray_metadata,
                    "bilevelOutputPath": gray_pbm,
                }],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        progress
            .iter()
            .filter(|event| event["progress"]["stage"] == "page-analyzed")
            .count(),
        2
    );
    let analyzed_index = progress
        .iter()
        .rposition(|event| event["progress"]["stage"] == "page-analyzed")
        .unwrap();
    let completed_index = progress
        .iter()
        .position(|event| event["progress"]["stage"] == "page-complete")
        .unwrap();
    assert!(analyzed_index < completed_index);
    assert!(progress
        .iter()
        .filter(|event| event["progress"]["stage"] == "page-complete")
        .all(|event| event["progress"]["recommendedOutputMode"].is_null()));
    for page_metadata in [&bw_page_metadata, &gray_page_metadata] {
        let page: Value = serde_json::from_slice(&fs::read(page_metadata).unwrap()).unwrap();
        assert!(page["recommendedOutputMode"].is_null());
    }
    assert!(fs::read(&bw_pbm).unwrap().starts_with(b"P4\n"));
    assert!(
        !bw_output.exists(),
        "a published PBM must not be shadowed by a full-resolution composite"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&bw_metadata).unwrap()).unwrap()
            ["bilevelWritten"],
        true
    );
    assert!(gray_output.exists());
    assert!(!gray_pbm.exists());
    assert!(
        serde_json::from_slice::<Value>(&fs::read(&gray_metadata).unwrap())
            .unwrap()
            .get("bilevelWritten")
            .is_none()
    );
}

#[test]
fn final_mixed_manifest_writes_inpainted_background_and_full_resolution_mask() {
    let scratch = Scratch::new("mixed-layers");
    let input = scratch.path("mixed-input.png");
    let output = scratch.path("mixed-output.png");
    let output_metadata = scratch.path("mixed-output.json");
    let page_metadata = scratch.path("mixed-page.json");
    let bilevel_output = scratch.path("mixed-bilevel.pbm");
    let background_output = scratch.path("mixed-background.png");
    let foreground_mask_output = scratch.path("mixed-mask.pbm");
    let manifest = scratch.path("mixed-manifest.json");
    let mut image = RgbImage::new(180, 120, [248; 3]);
    for y in 24..94 {
        for x in 96..168 {
            image.set(
                x,
                y,
                [
                    30 + ((x * 7 + y * 11) % 180) as u8,
                    45 + ((x * 13 + y * 3) % 150) as u8,
                    70 + ((x * 5 + y * 17) % 150) as u8,
                ],
            );
        }
    }
    for y in [22, 42, 62, 82] {
        for x in 16..78 {
            image.set(x, y, [18; 3]);
            image.set(x, y + 1, [18; 3]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: false,
        dpi: 600.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.5, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.85 },
                        NormalizedZonePoint { x: 0.5, y: 0.85 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "bilevelOutputPath": bilevel_output,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(&output_metadata).unwrap()).unwrap();
    assert_eq!(metadata["layeredWritten"], true);
    assert_eq!(metadata["layeredBackgroundDpi"], 300.0);
    assert!(
        !output.exists(),
        "a published layer pair must not be shadowed by a full-resolution composite"
    );
    assert!(!bilevel_output.exists());
    let mask = decode_p4(&fs::read(&foreground_mask_output).unwrap(), 180 * 120, 200).unwrap();
    assert_eq!((mask.width(), mask.height()), (180, 120));
    assert_eq!(mask.get(30, 22), 0);
    let background = decode_image(&fs::read(&background_output).unwrap(), 180 * 120, 200).unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (90, 60)
    );
    assert!(
        background.gray.get(15, 11) >= 240,
        "foreground ink leaked into the downsampled JPEG background source"
    );
    let picture = background.rgb.get(65, 30);
    assert!(
        picture[0] != picture[1] || picture[1] != picture[2],
        "color plate chroma was lost from the mixed background"
    );
}

#[test]
fn matched_canvas_repads_the_published_pbm_without_a_composite() {
    let scratch = Scratch::new("matched");
    let small_input = scratch.path("matched-bilevel-small-input.png");
    let large_input = scratch.path("matched-bilevel-large-input.png");
    let small_output = scratch.path("matched-bilevel-small-output.png");
    let large_output = scratch.path("matched-bilevel-large-output.png");
    let small_metadata = scratch.path("matched-bilevel-small-output.json");
    let large_metadata = scratch.path("matched-bilevel-large-output.json");
    let small_pbm = scratch.path("matched-bilevel-small-output.pbm");
    let large_pbm = scratch.path("matched-bilevel-large-output.pbm");
    let small_page_metadata = scratch.path("matched-bilevel-small-page.json");
    let large_page_metadata = scratch.path("matched-bilevel-large-page.json");
    let manifest = scratch.path("matched-bilevel-manifest.json");
    let mut small = GrayImage::new(80, 60, 255);
    for y in [10, 24, 38] {
        for x in 12..58 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
        }
    }
    let mut large = GrayImage::new(100, 90, 255);
    for y in [12, 30, 48, 66] {
        for x in 16..76 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
        }
    }
    fs::write(&small_input, encode_gray(&small).unwrap()).unwrap();
    fs::write(&large_input, encode_gray(&large).unwrap()).unwrap();
    let cleanup_options = CleanupOptions {
        output_mode: OutputMode::Bw,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: true,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": small_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": small_page_metadata,
                "options": cleanup_options,
                "outputs": [{
                    "outputPath": small_output,
                    "metadataPath": small_metadata,
                    "bilevelOutputPath": small_pbm,
                }],
            },
            {
                "inputPath": large_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": large_page_metadata,
                "options": cleanup_options,
                "outputs": [{
                    "outputPath": large_output,
                    "metadataPath": large_metadata,
                    "bilevelOutputPath": large_pbm,
                }],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    for composite in [&small_output, &large_output] {
        assert!(
            !composite.exists(),
            "matched-canvas repadding must operate on the PBM the combiner reads"
        );
    }
    let small_padded = decode_p4(&fs::read(&small_pbm).unwrap(), 20_000, 200).unwrap();
    let large_padded = decode_p4(&fs::read(&large_pbm).unwrap(), 20_000, 200).unwrap();
    assert_eq!(
        (small_padded.width(), small_padded.height()),
        (large_padded.width(), large_padded.height()),
        "both pages must land on the same uniform canvas"
    );
    let metadata: Value = serde_json::from_slice(&fs::read(&small_metadata).unwrap()).unwrap();
    assert_eq!(metadata["uniformCanvas"], true);
    assert_eq!(
        metadata["canvasWidthPx"].as_u64().unwrap() as usize,
        small_padded.width()
    );
    assert_eq!(
        metadata["canvasHeightPx"].as_u64().unwrap() as usize,
        small_padded.height()
    );
    let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap() as usize;
    let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap() as usize;
    let intrinsic_width = metadata["outputWidthPx"].as_u64().unwrap() as usize;
    let intrinsic_height = metadata["outputHeightPx"].as_u64().unwrap() as usize;
    assert!(offset_x + intrinsic_width <= small_padded.width());
    assert!(offset_y + intrinsic_height <= small_padded.height());
    let mut ink_inside_payload = 0usize;
    for y in 0..small_padded.height() {
        for x in 0..small_padded.width() {
            let inside = x >= offset_x
                && x < offset_x + intrinsic_width
                && y >= offset_y
                && y < offset_y + intrinsic_height;
            if small_padded.get(x, y) == 0 {
                assert!(inside, "repadding must leave the added margin white");
                ink_inside_payload += 1;
            }
        }
    }
    assert!(
        ink_inside_payload > 0,
        "repadding must preserve the page's ink"
    );
}

#[test]
fn failed_bilevel_publication_falls_back_to_the_composite() {
    let scratch = Scratch::new("failed-bilevel");
    let input = scratch.path("failed-bilevel-input.png");
    let output = scratch.path("failed-bilevel-output.png");
    let metadata = scratch.path("failed-bilevel-output.json");
    let bilevel_output = scratch.path("failed-bilevel-output.pbm");
    let page_metadata = scratch.path("failed-bilevel-page.json");
    let manifest = scratch.path("failed-bilevel-manifest.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    fs::create_dir(&bilevel_output).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": CleanupOptions::default(),
            "outputs": [{
                "outputPath": output,
                "metadataPath": metadata,
                "bilevelOutputPath": bilevel_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        output.exists(),
        "the composite is the fallback an unpublishable PBM falls back to"
    );
    assert!(page_metadata.exists());
    assert!(bilevel_output.is_dir());
    let published: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert!(published
        .get("bilevelWritten")
        .is_none_or(|written| written == false));
    assert!(
        published["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .unwrap()
                .contains("the composite fallback was published instead")),
        "the fallback must be reported: {published}"
    );
}

#[test]
fn auto_resolved_bw_writes_bilevel_output_and_reports_recommendation() {
    let scratch = Scratch::new("auto-bw");
    let input = scratch.path("auto-bw-input.png");
    let manifest = scratch.path("auto-bw-manifest.json");
    let output = scratch.path("auto-bw-output.png");
    let output_metadata = scratch.path("auto-bw-output.json");
    let bilevel_output = scratch.path("auto-bw-output.pbm");
    let page_metadata = scratch.path("auto-bw-page.json");
    let mut image = GrayImage::new(360, 260, 245);
    for row in 0..8 {
        for column in 0..14 {
            let left = 18 + column * 22;
            let top = 18 + row * 28;
            for y in top..top + 14 {
                for x in left..left + 12 {
                    if x < left + 2 || y < top + 2 || y >= top + 12 {
                        image.set(x, y, 28);
                    }
                }
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Auto,
        dpi: 150.0,
        normalize_illumination: false,
        crop_content: false,
        layout: evb_scan_cleanup::LayoutMode::Single,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "bilevelOutputPath": bilevel_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let envelopes = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let completed = envelopes
        .iter()
        .find(|envelope| envelope["progress"]["stage"] == "page-complete")
        .unwrap();
    assert_eq!(completed["progress"]["recommendedOutputMode"], "bw");
    assert!(completed["progress"]["recommendedOutputModeConfidence"]
        .as_f64()
        .is_some_and(|confidence| confidence >= 0.75));
    let page: Value = serde_json::from_slice(&fs::read(&page_metadata).unwrap()).unwrap();
    assert_eq!(page["recommendedOutputMode"], "bw");
    assert_eq!(page["recommendedOutputModeReason"], "bimodal-text");
    let metadata: Value = serde_json::from_slice(&fs::read(&output_metadata).unwrap()).unwrap();
    assert_eq!(metadata["outputMode"], "bw");
    assert_eq!(metadata["bilevelWritten"], true);
    assert!(fs::read(&bilevel_output).unwrap().starts_with(b"P4\n"));
}

#[test]
fn analyze_keeps_colored_recommendations_mode_independent() {
    let scratch = Scratch::new("auto-analyze");
    let input = scratch.path("auto-analyze-input.png");
    let auto_metadata = scratch.path("auto-analyze-page.json");
    let concrete_metadata = scratch.path("concrete-analyze-page.json");
    let manifest = scratch.path("auto-analyze-manifest.json");
    let mut image = RgbImage::new(360, 260, [28, 74, 132]);
    for y in 0..image.height() {
        for x in 0..image.width() {
            image.set(
                x,
                y,
                [
                    20 + ((x * 5 + y * 3) % 210) as u8,
                    35 + ((x * 7 + y * 11) % 180) as u8,
                    45 + ((x * 13 + y * 17) % 170) as u8,
                ],
            );
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let auto = CleanupOptions {
        output_mode: OutputMode::Auto,
        dpi: 150.0,
        normalize_illumination: false,
        crop_content: false,
        ..CleanupOptions::default()
    };
    let concrete = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        ..auto.clone()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": auto_metadata,
                "options": auto,
                "outputs": [],
            },
            {
                "inputPath": input,
                "sourcePageIndex": 1,
                "pageMetadataPath": concrete_metadata,
                "options": concrete,
                "outputs": [],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|envelope| envelope["progress"]["stage"] == "page-complete")
        .collect::<Vec<_>>();
    assert!(progress[0]["progress"]["recommendedOutputMode"].is_string());
    assert!(progress[0]["progress"]["recommendedOutputModeConfidence"].is_number());
    assert!(progress[1]["progress"]["recommendedOutputMode"].is_string());
    assert!(progress[1]["progress"]["recommendedOutputModeConfidence"].is_number());
    let auto_page: Value = serde_json::from_slice(&fs::read(&auto_metadata).unwrap()).unwrap();
    let concrete_page: Value =
        serde_json::from_slice(&fs::read(&concrete_metadata).unwrap()).unwrap();
    assert!(auto_page["recommendedOutputMode"].is_string());
    assert!(concrete_page["recommendedOutputMode"].is_string());
    assert_eq!(auto_page["recommendedOutputMode"], "color");
    assert_eq!(
        concrete_page["recommendedOutputMode"],
        auto_page["recommendedOutputMode"]
    );
}

#[test]
fn per_page_ocr_mode_writes_atomic_png_and_metadata() {
    let scratch = Scratch::new("ocr");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let metadata = scratch.path("metadata.json");
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
}

#[test]
fn batch_spread_png_writes_two_output_images_and_per_half_metadata() {
    let scratch = Scratch::new("spread");
    let input = scratch.path("spread-input.png");
    let output_left = scratch.path("spread-left.png");
    let output_right = scratch.path("spread-right.png");
    let metadata_left = scratch.path("spread-left.json");
    let metadata_right = scratch.path("spread-right.json");
    let manifest = scratch.path("spread-manifest.json");
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
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 7,
            "pageMetadataPath": scratch.path("spread-page.json"),
            "options": {
                "dpi": 150,
                "layout": "force-two-page",
                "rotationDegrees": 90,
                "normalizeIllumination": false,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
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
    assert_eq!(String::from_utf8_lossy(&result.stderr), "");
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
}

#[test]
fn classify_only_batch_writes_metadata_and_ndjson_but_no_output_images() {
    let scratch = Scratch::new("classify");
    let spread_input = scratch.path("classify-spread-input.png");
    let single_input = scratch.path("classify-single-input.png");
    let spread_output = scratch.path("classify-spread-output.png");
    let single_output = scratch.path("classify-single-output.png");
    let spread_output_metadata = scratch.path("classify-spread-output.json");
    let single_output_metadata = scratch.path("classify-single-output.json");
    let spread_page_metadata = scratch.path("classify-spread-page.json");
    let single_page_metadata = scratch.path("classify-single-page.json");
    let manifest = scratch.path("classify-manifest.json");

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
        "version": 3,
        "operation": "analyze",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": spread_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": spread_page_metadata,
                "options": {
                    "dpi": 150,
                    "normalizeIllumination": false
                },
                "outputs": [{
                    "outputPath": spread_output,
                    "metadataPath": spread_output_metadata
                }]
            },
            {
                "inputPath": single_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": single_page_metadata,
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "normalizeIllumination": false
                },
                "outputs": [{
                    "outputPath": single_output,
                    "metadataPath": single_output_metadata
                }]
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

    let progress = String::from_utf8(result.stdout).unwrap();
    let lines = progress
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|line| line["progress"]["stage"] == "page-complete")
        .collect::<Vec<_>>();
    assert_eq!(lines[0]["progress"]["classification"], "two-page-spread");
    assert!(lines[0]["progress"]["confidence"].as_f64().is_some());
    assert!(lines[0]["progress"]["cutterXPx"].as_f64().is_some());
    assert_eq!(lines[1]["progress"]["classification"], "single-uncut-page");
    assert_eq!(lines[1]["progress"]["confidence"], 1.0);
    assert!(lines[1]["progress"].get("cutterXPx").is_none());
    assert_eq!(lines[1]["progress"]["textAxis"]["sideways"], false);
    assert!(lines[1]["progress"]["textAxis"]["confidence"]
        .as_f64()
        .is_some_and(|confidence| (0.0..=1.0).contains(&confidence)));

    let spread_metadata: Value =
        serde_json::from_slice(&fs::read(&spread_page_metadata).unwrap()).unwrap();
    let single_metadata: Value =
        serde_json::from_slice(&fs::read(&single_page_metadata).unwrap()).unwrap();
    assert_eq!(spread_metadata["layoutClassification"], "two-page-spread");
    assert_eq!(single_metadata["layoutClassification"], "single-uncut-page");
    assert_eq!(
        single_metadata["textAxis"],
        lines[1]["progress"]["textAxis"]
    );
    for output in [
        &spread_output,
        &single_output,
        &spread_output_metadata,
        &single_output_metadata,
    ] {
        assert!(!output.exists(), "classify-only wrote {}", output.display());
    }
}

#[test]
fn classify_only_inside_page_options_with_declared_outputs_writes_no_images() {
    let scratch = Scratch::new("nested-classify");
    let input = scratch.path("nested-classify-input.png");
    let output_first = scratch.path("nested-classify-first.png");
    let output_second = scratch.path("nested-classify-second.png");
    let metadata_first = scratch.path("nested-classify-first.json");
    let metadata_second = scratch.path("nested-classify-second.json");
    let manifest = scratch.path("nested-classify-manifest.json");

    let mut image = GrayImage::new(180, 280, 245);
    for y in (32..248).step_by(16) {
        for x in 22..158 {
            image.set(x, y, 20);
            image.set(x, y + 1, 20);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 40,
            "pageMetadataPath": metadata_first,
            "options": {
                "dpi": 150.0,
                "layout": "auto",
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
        .args(["--manifest", manifest.to_str().unwrap()])
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
    let completed = lines
        .iter()
        .find(|line| line["progress"]["stage"] == "page-complete")
        .unwrap();
    assert!(completed["progress"]["classification"].as_str().is_some());
    assert_eq!(completed["progress"]["outputPaths"], serde_json::json!([]));

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
}

#[test]
fn parallel_batch_outputs_and_progress_are_deterministic() {
    let scratch = Scratch::new("parallel-determinism");
    let input = scratch.path("parallel-determinism-input.png");
    let manifest = scratch.path("parallel-determinism-manifest.json");
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
                scratch.path(&format!("parallel-determinism-{index}.png")),
                scratch.path(&format!("parallel-determinism-{index}.json")),
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
                "pageMetadataPath": scratch.path(&format!("parallel-determinism-page-{index}.json")),
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
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
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
    let stable_progress = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(|line| {
                let mut value = serde_json::from_str::<Value>(line).unwrap();
                value
                    .get_mut("progress")
                    .and_then(Value::as_object_mut)
                    .map(|progress| progress.remove("stageTimings"));
                value
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        stable_progress(&first.stdout),
        stable_progress(&second.stdout)
    );
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
}

#[cfg(unix)]
#[test]
fn sigterm_terminates_parallel_batch_promptly() {
    let scratch = Scratch::new("sigterm");
    let input = scratch.path("sigterm-input.png");
    let manifest = scratch.path("sigterm-manifest.json");
    let image = GrayImage::new(2_400, 1_800, 238);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let metadata_paths = (0..12)
        .map(|index| scratch.path(&format!("sigterm-page-{index}.json")))
        .collect::<Vec<_>>();
    let pages = metadata_paths
        .iter()
        .enumerate()
        .map(|(index, metadata)| {
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": metadata,
                "options": {
                    "dpi": 150,
                    "layout": "auto"
                },
                "outputs": []
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
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
}

#[test]
fn batch_applies_per_output_placement_over_document_default() {
    let scratch = Scratch::new("uniform");
    let input_small = scratch.path("uniform-small-input.png");
    let input_large = scratch.path("uniform-large-input.png");
    let output_small = scratch.path("uniform-small-output.png");
    let output_large = scratch.path("uniform-large-output.png");
    let metadata_small = scratch.path("uniform-small-metadata.json");
    let metadata_large = scratch.path("uniform-large-metadata.json");
    let manifest = scratch.path("uniform-manifest.json");
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
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": input_small,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("uniform-small-page.json"),
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-left",
                    "placementOverrides": {"full": "bottom-right"}
                },
                "outputs": [{"outputPath": output_small, "metadataPath": metadata_small}]
            },
            {
                "inputPath": input_large,
                "sourcePageIndex": 1,
                "pageMetadataPath": scratch.path("uniform-large-page.json"),
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-left"
                },
                "outputs": [{"outputPath": output_large, "metadataPath": metadata_large}]
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
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let preview_result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
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
}

#[test]
fn matched_canvas_strictly_uses_the_largest_outlier() {
    let scratch = Scratch::new("matched-quantile");
    let manifest = scratch.path("matched-quantile-manifest.json");
    let mut pages = Vec::new();
    let mut output_paths = Vec::new();
    let mut metadata_paths = Vec::new();
    for index in 0..10 {
        let input = scratch.path(&format!("matched-quantile-input-{index}.png"));
        let output = scratch.path(&format!("matched-quantile-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-quantile-metadata-{index}.json"));
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
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-quantile-page-{index}.json")),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center"
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }));
        output_paths.push(output);
        metadata_paths.push(metadata);
    }
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": pages
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

    for index in 0..10 {
        let image = decode_gray(&fs::read(&output_paths[index]).unwrap(), 20_000, 200).unwrap();
        let metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_paths[index]).unwrap()).unwrap();
        assert_eq!((image.width(), image.height()), (140, 100));
        assert_eq!(metadata["matchedCanvasTargetWidthPx"], 140);
        assert_eq!(metadata["matchedCanvasTargetHeightPx"], 100);
        assert_eq!(metadata["canvasPolicy"], "strict-maximum");
        assert_eq!(metadata["canvasOverflow"], false);
        assert_eq!(metadata["uniformCanvas"], true);
        assert_eq!(metadata["canvasWidthPx"], 140);
        assert_eq!(metadata["canvasHeightPx"], 100);
    }
}

#[test]
fn matched_canvas_normalizes_equal_physical_pages_by_per_page_dpi() {
    let scratch = Scratch::new("matched-physical");
    let manifest = scratch.path("matched-physical-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    for (index, (dimension, dpi)) in [(100, 100), (200, 200)].into_iter().enumerate() {
        let input = scratch.path(&format!("matched-physical-input-{index}.png"));
        let output = scratch.path(&format!("matched-physical-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-physical-metadata-{index}.json"));
        let mut image = GrayImage::new(dimension, dimension, 255);
        for coordinate in 10..dimension.saturating_sub(10) {
            image.set(coordinate, dimension / 2, 0);
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-physical-page-{index}.json")),
            "options": {
                "dpi": dpi,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }));
        outputs.push(output);
        metadata_paths.push(metadata);
    }
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    for (index, expected_dimension) in [100, 200].into_iter().enumerate() {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 50_000, 300).unwrap();
        let metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_paths[index]).unwrap()).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (expected_dimension, expected_dimension)
        );
        assert_eq!(metadata["canvasPolicy"], "strict-maximum");
        assert_eq!(metadata["canvasOverflow"], false);
    }
}

#[test]
fn batch_preserves_asymmetric_margin_order_in_named_metadata() {
    let scratch = Scratch::new("asymmetric-margins");
    let input = scratch.path("asymmetric-margins-input.png");
    let output = scratch.path("asymmetric-margins-output.png");
    let metadata = scratch.path("asymmetric-margins-metadata.json");
    let manifest = scratch.path("asymmetric-margins-manifest.json");
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
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("asymmetric-margins-page.json"),
            "options": {
                "dpi": 150,
                "layout": "force-single",
                "normalizeIllumination": false,
                "outputMode": "grayscale",
                "cropContent": true,
                "matchPageSize": false,
                "margins": {
                    "leftMm": 7.0 * 25.4 / 150.0,
                    "topMm": 11.0 * 25.4 / 150.0,
                    "rightMm": 17.0 * 25.4 / 150.0,
                    "bottomMm": 23.0 * 25.4 / 150.0
                }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
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
}
