use evb_raster_io::{decode_ppm, DecodeLimits};
use evb_scan_cleanup::{
    io::pbm::decode_p4,
    png::{decode_gray, encode_gray, encode_rgb, RgbImage},
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

/// Matched page size is on by default, and it now requires the document canvas
/// its owner measured. A test that is not about matching says so.
fn unmatched_options() -> CleanupOptions {
    CleanupOptions {
        match_page_size: false,
        ..CleanupOptions::default()
    }
}

fn assert_pdf_image_placement_matches_canvas(metadata: &Value) {
    let placement = &metadata["pdfImagePlacement"];
    assert!(
        placement.is_object(),
        "missing PDF image placement: {metadata}"
    );
    let canvas_width = metadata["canvasWidthPx"].as_f64().unwrap();
    let canvas_height = metadata["canvasHeightPx"].as_f64().unwrap();
    let page_width = metadata["matchedCanvasTargetWidthPoints"].as_f64().unwrap();
    let page_height = metadata["matchedCanvasTargetHeightPoints"]
        .as_f64()
        .unwrap();
    let content_width = metadata["matchedCanvasContentWidthPx"].as_f64().unwrap();
    let content_height = metadata["matchedCanvasContentHeightPx"].as_f64().unwrap();
    let offset_x = metadata["placementOffsetXPx"].as_f64().unwrap();
    let offset_y = metadata["placementOffsetYPx"].as_f64().unwrap();
    let expected = [
        offset_x / canvas_width * page_width,
        page_height - (offset_y + content_height) / canvas_height * page_height,
        content_width / canvas_width * page_width,
        content_height / canvas_height * page_height,
    ];
    for (field, expected) in ["xPoints", "yPoints", "widthPoints", "heightPoints"]
        .into_iter()
        .zip(expected)
    {
        let actual = placement[field].as_f64().unwrap();
        assert!(
            (actual - expected).abs() <= 1e-9,
            "{field}={actual} expected {expected}"
        );
    }
}

#[test]
fn real_gray_flyleaf_is_white_and_consistent_in_preview_and_final_cli_renders() {
    let scratch = Scratch::new("gray-flyleaf");
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blank");
    let cases = [
        (
            1,
            "preview",
            150.0,
            "rome-flyleaf-p00002-150dpi.png",
            (884, 1335),
        ),
        (
            1,
            "final",
            360.0,
            "rome-flyleaf-p00002-360dpi.png",
            (2120, 3202),
        ),
        (
            2,
            "preview",
            150.0,
            "rome-flyleaf-p00003-150dpi.png",
            (884, 1335),
        ),
        (
            2,
            "final",
            360.0,
            "rome-flyleaf-p00003-360dpi.png",
            (2120, 3202),
        ),
        (
            3,
            "preview",
            150.0,
            "rome-flyleaf-p00004-150dpi.png",
            (884, 1335),
        ),
        (
            3,
            "final",
            360.0,
            "rome-flyleaf-p00004-360dpi.png",
            (2120, 3202),
        ),
    ];

    for (source_page_index, render_mode, dpi, fixture, expected_dimensions) in cases {
        let case_name = format!("p{}-{render_mode}", source_page_index + 1);
        let output = scratch.path(&format!("flyleaf-{case_name}.png"));
        let metadata = scratch.path(&format!("flyleaf-{case_name}.json"));
        let page_metadata = scratch.path(&format!("flyleaf-{case_name}-page.json"));
        let manifest = scratch.path(&format!("flyleaf-{case_name}-manifest.json"));
        let options = CleanupOptions {
            dpi,
            source_dpi: Some(360.0),
            requested_render_dpi: Some(dpi),
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: true,
            crop_content: true,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let payload = serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": render_mode,
            "canvasScope": if render_mode == "preview" { "page" } else { "document" },
            "pages": [{
                "inputPath": fixtures.join(fixture),
                "sourcePageIndex": source_page_index,
                "pageMetadataPath": page_metadata,
                "options": options,
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": metadata,
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
            "{render_mode} stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        let cleaned = decode_gray(&fs::read(&output).unwrap(), 8_000_000, 4_000).unwrap();
        assert_eq!(
            (cleaned.width(), cleaned.height()),
            expected_dimensions,
            "{render_mode} changed the intrinsic blank-page geometry",
        );
        assert!(
            cleaned.data().iter().all(|&value| value == 255),
            "{render_mode} amplified gray paper texture into artificial ink",
        );
        let cleanup_metadata: Value =
            serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(cleanup_metadata["sourcePageIndex"], source_page_index);
        assert_eq!(cleanup_metadata["outputMode"], "bw");
        assert!(cleanup_metadata["contentBox"].is_null());
        assert!(cleanup_metadata["binarizationMode"].is_null());
    }
}

#[test]
fn real_gray_flyleaf_stays_white_when_auto_was_pre_resolved_to_grayscale() {
    let scratch = Scratch::new("gray-flyleaf-resolved-grayscale");
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blank");
    let cases = [
        ("preview", 150.0, "rome-flyleaf-p00002-150dpi.png"),
        ("preview", 150.0, "rome-flyleaf-p00003-150dpi.png"),
        ("preview", 150.0, "rome-flyleaf-p00004-150dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00002-360dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00003-360dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00004-360dpi.png"),
    ];

    for (index, (render_mode, dpi, fixture)) in cases.into_iter().enumerate() {
        let output = scratch.path(&format!("flyleaf-{index}.png"));
        let metadata = scratch.path(&format!("flyleaf-{index}.json"));
        let page_metadata = scratch.path(&format!("flyleaf-{index}-page.json"));
        let manifest = scratch.path(&format!("flyleaf-{index}-manifest.json"));
        let options = CleanupOptions {
            dpi,
            source_dpi: Some(360.0),
            requested_render_dpi: Some(dpi),
            // This reproduces the application path: detection may recommend
            // grayscale before the final renderer sees the page.
            output_mode: OutputMode::Grayscale,
            layout: LayoutMode::Single,
            normalize_illumination: true,
            crop_content: true,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let payload = serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": render_mode,
            "canvasScope": if render_mode == "preview" { "page" } else { "document" },
            "pages": [{
                "inputPath": fixtures.join(fixture),
                "sourcePageIndex": index % 3 + 1,
                "pageMetadataPath": page_metadata,
                "options": options,
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": metadata,
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
            "{render_mode} stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        let cleaned = decode_gray(&fs::read(&output).unwrap(), 8_000_000, 4_000).unwrap();
        assert!(
            cleaned.data().iter().all(|&value| value == 255),
            "{render_mode} grayscale output amplified {fixture} into false content",
        );
        let cleanup_metadata: Value =
            serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(cleanup_metadata["outputMode"], "grayscale");
        assert!(cleanup_metadata["contentBox"].is_null());
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
    assert_eq!(
        first_analyzed["progress"]["classification"],
        "single-uncut-page"
    );
    assert!(first_analyzed["progress"]["confidence"].is_number());
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
        ..unmatched_options()
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
                "options": unmatched_options(),
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
    assert!(
        !progress
            .iter()
            .any(|event| event["progress"]["stage"] == "page-analyzed"),
        "a final render must not run a separate classification pass"
    );
    assert_eq!(
        progress
            .iter()
            .filter(|event| event["progress"]["stage"] == "page-complete")
            .count(),
        2
    );
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
fn final_mixed_manifest_writes_inpainted_background_and_native_resolution_foreground() {
    let scratch = Scratch::new("mixed-layers");
    let input = scratch.path("mixed-input.png");
    let output = scratch.path("mixed-output.png");
    let output_metadata = scratch.path("mixed-output.json");
    let page_metadata = scratch.path("mixed-page.json");
    let bilevel_output = scratch.path("mixed-bilevel.pbm");
    let background_output = scratch.path("mixed-background.ppm");
    let foreground_mask_output = scratch.path("mixed-mask.pbm");
    let foreground_alpha_output = scratch.path("mixed-alpha.pgm");
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
                "foregroundAlphaOutputPath": foreground_alpha_output,
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
    // Final layered handoffs publish a compact 1-bit stencil: an 8-bit
    // alpha plane would defeat the JBIG2 foreground representation. Soft
    // alpha remains a preview/composite feature.
    assert_eq!(metadata["layeredForegroundKind"], "stencil");
    assert_eq!(metadata["layeredBackgroundDpi"], 200.0);
    // A fresh stencil lives on the rendered page grid; it carries no
    // separate foreground DPI (that was soft-alpha metadata).
    assert!(metadata["layeredForegroundDpi"].is_null());
    assert!(
        !output.exists(),
        "a published layer pair must not be shadowed by a full-resolution composite"
    );
    assert!(!bilevel_output.exists());
    assert!(!foreground_alpha_output.exists());
    let mask = fs::read(&foreground_mask_output).unwrap();
    let mask_header = b"P4\n180 120\n";
    assert!(
        mask.starts_with(mask_header),
        "unexpected mask header: {:?}",
        String::from_utf8_lossy(&mask[..mask.len().min(16)])
    );
    let mask_bits = &mask[mask_header.len()..];
    let set_bits: u32 = mask_bits.iter().map(|byte| byte.count_ones()).sum();
    assert!(
        set_bits > 40,
        "dark text did not reach the published stencil, set bits = {set_bits}"
    );
    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (60, 40)
    );
    assert!(
        background.gray.get(10, 7) >= 240,
        "foreground ink leaked into the downsampled JPEG background source"
    );
    let picture = background.rgb.get(43, 20);
    assert!(
        picture[0] != picture[1] || picture[1] != picture[2],
        "color plate chroma was lost from the mixed background: {picture:?}"
    );
}

#[test]
fn normalized_mixed_picture_does_not_pull_the_paper_surface_through_a_dark_photo() {
    let scratch = Scratch::new("normalized-picture-surface");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let manifest = scratch.path("manifest.json");
    let mut image = RgbImage::new(180, 120, [214; 3]);
    for y in 0..image.height() {
        for x in 0..image.width() {
            let paper = 214 + x * 16 / (image.width() - 1);
            image.set(x, y, [paper as u8, paper as u8, paper as u8]);
        }
    }
    for y in 30..90 {
        for x in 64..116 {
            let tone = if y < 60 {
                36 + ((x * 7 + y * 11) % 24) as u8
            } else {
                190 + ((x * 5 + y * 3) % 18) as u8
            };
            image.set(x, y, [tone, tone, tone]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: true,
        crop_content: false,
        match_page_size: false,
        dpi: 300.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.35, y: 0.25 },
                        NormalizedZonePoint { x: 0.65, y: 0.25 },
                        NormalizedZonePoint { x: 0.65, y: 0.75 },
                        NormalizedZonePoint { x: 0.35, y: 0.75 },
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

    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    let dark_photo = background.gray.get(43, 24);
    let light_photo = background.gray.get(43, 36);
    let paper = background.gray.get(20, 30);
    let outside_picture = background.gray.get(39, 30);
    assert!(
        dark_photo < 120,
        "dark photo tone was brightened: {dark_photo}"
    );
    assert!(
        light_photo <= 250,
        "light photo tone was driven to white: {light_photo}"
    );
    assert!(paper >= 245, "paper was not normalized: {paper}");
    assert!(
        outside_picture.abs_diff(paper) <= 8,
        "paper endpoint changed beside the picture: outside={outside_picture}, paper={paper}"
    );
}

#[test]
fn confirmed_mixed_photo_keeps_pale_interior_tone_near_a_caption() {
    let scratch = Scratch::new("confirmed-photo-tone");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let picture_mask_output = scratch.path("picture-mask.pbm");
    let manifest = scratch.path("manifest.json");
    let mut image = RgbImage::new(180, 120, [245; 3]);
    for y in 24..94 {
        for x in 96..168 {
            let tone = 150 + ((x * 7 + y * 11) % 40) as u8;
            image.set(
                x,
                y,
                [tone, tone.saturating_add(20), tone.saturating_add(40)],
            );
        }
    }
    // A nearby caption used to trigger the broad stencil-adjacency ramp and
    // wash pale picture pixels even though the caption is outside the photo.
    for y in 60..63 {
        for x in 20..56 {
            image.set(x, y, [18; 3]);
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
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
                "pictureMaskOutputPath": picture_mask_output,
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

    let picture_mask = decode_p4(&fs::read(&picture_mask_output).unwrap(), 180 * 120, 200)
        .expect("the confirmed photo test must publish its picture mask");
    let picture_pixels = picture_mask
        .data()
        .iter()
        .filter(|&&value| value == 0)
        .count();
    assert!(
        picture_pixels > 1_000,
        "manual confirmed photo zone was not retained: {picture_pixels} pixels"
    );
    let owned_photo_pixels = (24..94)
        .flat_map(|y| (96..168).map(move |x| (x, y)))
        .filter(|&(x, y)| picture_mask.get(x, y) == 0)
        .count();
    assert!(
        owned_photo_pixels > 1_000,
        "the sampled photo interior must be owned by the picture mask: {owned_photo_pixels}"
    );
    assert_eq!(
        picture_mask.get(132, 60),
        0,
        "the sampled photo interior must be owned by the picture mask"
    );
    assert!(
        background_output.exists(),
        "mixed layer background was not published; metadata={} page_metadata={}",
        String::from_utf8_lossy(&fs::read(&output_metadata).unwrap()),
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (60, 40)
    );
    let photo_interior = background.gray.get(44, 20);
    let mut expected_photo_sum = 0u64;
    for y in 60..63 {
        for x in 132..135 {
            let pixel = image.get(x, y);
            expected_photo_sum += ((u32::from(pixel[0]) * 77
                + u32::from(pixel[1]) * 150
                + u32::from(pixel[2]) * 29
                + 128)
                >> 8) as u64;
        }
    }
    let expected_photo_interior = expected_photo_sum / 9;
    assert!(
        u64::from(photo_interior).abs_diff(expected_photo_interior) <= 1,
        "caption-adjacent photo interior was whitened: {photo_interior}, source average={expected_photo_interior}; page_metadata={}",
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
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
        "documentCanvas": {
            "widthPoints": 24.0,
            "heightPoints": 21.6,
            "widthPx": 100,
            "heightPx": 90
        },
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
    let intrinsic_width = metadata["matchedCanvasContentWidthPx"].as_u64().unwrap() as usize;
    let intrinsic_height = metadata["matchedCanvasContentHeightPx"].as_u64().unwrap() as usize;
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
fn matched_canvas_places_an_automatic_crop_at_its_paper_origin() {
    let scratch = Scratch::new("matched-crop-origin");
    let input = scratch.path("matched-crop-origin-input.png");
    let output = scratch.path("matched-crop-origin-output.png");
    let metadata = scratch.path("matched-crop-origin-output.json");
    let page_metadata = scratch.path("matched-crop-origin-page.json");
    let manifest = scratch.path("matched-crop-origin-manifest.json");
    let mut image = GrayImage::new(100, 100, 255);
    for y in 20..70 {
        for x in 30..70 {
            if y % 9 < 3 {
                image.set(x, y, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 72.0,
            "heightPoints": 72.0,
            "widthPx": 100,
            "heightPx": 100
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 100.0,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": true,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "top-left",
                "automaticContentBoxes": {
                    "full": {
                        "xNormalized": 0.2,
                        "yNormalized": 0.1,
                        "widthNormalized": 0.6,
                        "heightNormalized": 0.7,
                        "rotationDegrees": 0
                    }
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
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(metadata).unwrap()).unwrap();
    assert_eq!(metadata["cropRect"]["xPx"], 20.0);
    assert_eq!(metadata["cropRect"]["yPx"], 10.0);
    assert_eq!(metadata["matchedCanvasContentWidthPx"], 60);
    assert_eq!(metadata["matchedCanvasContentHeightPx"], 70);
    assert_eq!(metadata["placementOffsetXPx"], 20);
    assert_eq!(metadata["placementOffsetYPx"], 10);
    assert_pdf_image_placement_matches_canvas(&metadata);
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
            "options": unmatched_options(),
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
fn failed_second_page_rolls_back_every_manifest_destination() {
    let scratch = Scratch::new("transaction-rollback");
    let good_input = scratch.path("transaction-good.png");
    let bad_input = scratch.path("transaction-truncated.ppm");
    let manifest = scratch.path("transaction-manifest.json");
    fs::write(
        &good_input,
        encode_gray(&GrayImage::new(80, 60, 220)).unwrap(),
    )
    .unwrap();
    // The dimension probe accepts this header, so page one really enters and
    // completes processing before page two fails its bounded payload decode.
    fs::write(&bad_input, b"P6\n80 60\n255\n").unwrap();
    let page = |index: usize, input: &PathBuf| {
        let page_metadata = scratch.path(&format!("transaction-{index}-page.json"));
        let output = scratch.path(&format!("transaction-{index}.png"));
        let output_metadata = scratch.path(&format!("transaction-{index}-output.json"));
        let bilevel = scratch.path(&format!("transaction-{index}.pbm"));
        let background = scratch.path(&format!("transaction-{index}-background.png"));
        let foreground_mask = scratch.path(&format!("transaction-{index}-foreground.pbm"));
        let foreground_alpha = scratch.path(&format!("transaction-{index}-foreground.png"));
        let picture = scratch.path(&format!("transaction-{index}-picture.pbm"));
        let tone = scratch.path(&format!("transaction-{index}-tone.png"));
        let destinations = vec![
            page_metadata.clone(),
            output.clone(),
            output_metadata.clone(),
            bilevel.clone(),
            background.clone(),
            foreground_mask.clone(),
            foreground_alpha.clone(),
            picture.clone(),
            tone.clone(),
        ];
        (
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    layout: LayoutMode::Single,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": output_metadata,
                    "bilevelOutputPath": bilevel,
                    "backgroundOutputPath": background,
                    "foregroundMaskOutputPath": foreground_mask,
                    "foregroundAlphaOutputPath": foreground_alpha,
                    "pictureMaskOutputPath": picture,
                    "tonePreservationAlphaOutputPath": tone,
                }],
            }),
            destinations,
        )
    };
    let (good_page, mut destinations) = page(0, &good_input);
    let (bad_page, bad_destinations) = page(1, &bad_input);
    destinations.extend(bad_destinations);
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "hostMemoryBytes": 4_u64 * 1024 * 1024 * 1024,
        "pages": [good_page, bad_page],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&result.stdout);

    assert!(!result.status.success(), "stdout={stdout}");
    assert!(
        stdout.contains("\"stage\":\"page-complete\"") && stdout.contains("\"pageNumber\":1"),
        "page one must really publish before page two fails: {stdout}"
    );
    assert!(good_input.exists());
    assert!(bad_input.exists());
    for destination in destinations {
        assert!(
            !destination.exists(),
            "failed batch left declared destination {}",
            destination.display()
        );
    }
}

#[test]
fn failed_batch_restores_a_preexisting_file_destination() {
    let scratch = Scratch::new("preexisting-destination-rollback");
    let good_input = scratch.path("preexisting-good.png");
    let bad_input = scratch.path("preexisting-truncated.ppm");
    let output = scratch.path("preexisting-output.png");
    let metadata = scratch.path("preexisting-output.json");
    let page_metadata = scratch.path("preexisting-page.json");
    let bad_output = scratch.path("preexisting-bad-output.png");
    let bad_metadata = scratch.path("preexisting-bad-output.json");
    let bad_page_metadata = scratch.path("preexisting-bad-page.json");
    let manifest = scratch.path("preexisting-manifest.json");
    fs::write(
        &good_input,
        encode_gray(&GrayImage::new(80, 60, 220)).unwrap(),
    )
    .unwrap();
    fs::write(&bad_input, b"P6\n80 60\n255\n").unwrap();
    let original = b"unrelated preexisting output\0with exact bytes";
    fs::write(&output, original).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": good_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}],
            },
            {
                "inputPath": bad_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": bad_page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{"outputPath": bad_output, "metadataPath": bad_metadata}],
            }
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&result.stdout);

    assert!(!result.status.success(), "stdout={stdout}");
    assert!(
        stdout.contains("\"stage\":\"page-complete\"") && stdout.contains("\"pageNumber\":1"),
        "the first page must overwrite the destination before rollback: {stdout}"
    );
    assert_eq!(fs::read(&output).unwrap(), original);
    assert!(good_input.exists());
    assert!(bad_input.exists());
    assert!(!metadata.exists());
    assert!(!page_metadata.exists());
    assert!(!bad_output.exists());
    assert!(!bad_metadata.exists());
    assert!(!bad_page_metadata.exists());
    assert!(fs::read_dir(&scratch.dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".evb-tmp-")));
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
        ..unmatched_options()
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
        // The document of this spread: each half is 100 x 320 of the rotated
        // sheet, which is the paper a reader ends up holding.
        "documentCanvas": {
            "widthPoints": 48.0,
            "heightPoints": 153.6,
            "widthPx": 100,
            "heightPx": 320
        },
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
    let mut content_sizes = Vec::new();
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
        // Matched page size is on, as it is by default: both halves carry the
        // document's half-sheet canvas rather than the sheet they were cut from,
        // so neither is a page with an empty half beside it.
        assert_eq!(
            (output.width(), output.height()),
            (100, 320),
            "{expected_half} half is not the document canvas"
        );
        assert_eq!(metadata_json["canvasWidthPx"], 100);
        assert_eq!(metadata_json["canvasHeightPx"], 320);
        assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
        content_sizes.push((
            metadata_json["matchedCanvasContentWidthPx"]
                .as_u64()
                .unwrap(),
            metadata_json["matchedCanvasContentHeightPx"]
                .as_u64()
                .unwrap(),
        ));
    }
    // Each half fills the sheet it was normalized onto rather than half of it.
    for (content_width, content_height) in content_sizes {
        assert!(
            content_width * 2 > 100 && content_height * 2 > 320,
            "a half was padded into the canvas instead of filling it ({content_width}x{content_height})"
        );
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
                    "matchPageSize": false,
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
        "documentCanvas": {
            "widthPoints": 24.0,
            "heightPoints": 21.6,
            "widthPx": 100,
            "heightPx": 90
        },
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
    assert_eq!((matched_small.width(), matched_small.height()), (80, 60));
    assert_eq!((matched_large.width(), matched_large.height()), (100, 90));
    assert!(matched_small.get(5, 7) < 200);
    // The smaller page stays at source resolution; its metadata scales it to
    // the document width and places it at the bottom per its override.

    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata_small).unwrap()).unwrap();
    assert_eq!(
        metadata_json["softMarginsPx"],
        serde_json::json!([0, 15, 0, 0])
    );
    assert_eq!(metadata_json["uniformCanvas"], true);
    assert_eq!(metadata_json["outputWidthPx"], 80);
    assert_eq!(metadata_json["outputHeightPx"], 60);
    assert_eq!(metadata_json["matchedCanvasContentWidthPx"], 100);
    assert_eq!(metadata_json["matchedCanvasContentHeightPx"], 75);
    assert_eq!(metadata_json["canvasWidthPx"], 100);
    assert_eq!(metadata_json["canvasHeightPx"], 90);
    assert_eq!(metadata_json["placementOffsetXPx"], 0);
    assert_eq!(metadata_json["placementOffsetYPx"], 15);
    assert_pdf_image_placement_matches_canvas(&metadata_json);
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
    assert_eq!(preview_metadata["placementOffsetXPx"], 0);
    assert_eq!(preview_metadata["placementOffsetYPx"], 15);
    // A preview keeps the raster it rendered and reports the box it belongs
    // in, which is the box the final run resampled its own raster into.
    assert_eq!(preview_metadata["outputWidthPx"], 80);
    assert_eq!(preview_metadata["matchedCanvasContentWidthPx"], 100);
    assert_eq!(preview_metadata["matchedCanvasContentHeightPx"], 75);
    for metadata_path in [&metadata_small, &metadata_large] {
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        let content_width = metadata["matchedCanvasContentWidthPx"].as_u64().unwrap();
        let content_height = metadata["matchedCanvasContentHeightPx"].as_u64().unwrap();
        let canvas_width = metadata["canvasWidthPx"].as_u64().unwrap();
        let canvas_height = metadata["canvasHeightPx"].as_u64().unwrap();
        let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap();
        let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap();
        assert!(canvas_width >= content_width);
        assert!(canvas_height >= content_height);
        assert!(offset_x + content_width <= canvas_width);
        assert!(offset_y + content_height <= canvas_height);
    }
}

#[test]
fn matched_canvas_keeps_source_grids_and_reports_one_physical_rectangle() {
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
        // The largest page the document carries, at its own resolution.
        "documentCanvas": {
            "widthPoints": 33.6,
            "heightPoints": 24.0,
            "widthPx": 140,
            "heightPx": 100
        },
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
        let expected_dimensions = if index == 9 { (140, 100) } else { (80, 60) };
        assert_eq!((image.width(), image.height()), expected_dimensions);
        assert_eq!(metadata["matchedCanvasTargetWidthPx"], 140);
        assert_eq!(metadata["matchedCanvasTargetHeightPx"], 100);
        assert_eq!(metadata["matchedCanvasTargetWidthPoints"], 33.6);
        assert_eq!(metadata["matchedCanvasTargetHeightPoints"], 24.0);
        assert_eq!(metadata["canvasPolicy"], "strict-maximum");
        assert_eq!(metadata["canvasOverflow"], false);
        assert_eq!(metadata["uniformCanvas"], true);
        assert_eq!(metadata["canvasWidthPx"], 140);
        assert_eq!(metadata["canvasHeightPx"], 100);
        let content_width = metadata["matchedCanvasContentWidthPx"].as_f64().unwrap();
        let content_height = metadata["matchedCanvasContentHeightPx"].as_f64().unwrap();
        assert_eq!(metadata["outputWidthPx"], expected_dimensions.0);
        assert_eq!(metadata["outputHeightPx"], expected_dimensions.1);
        if index == 9 {
            assert_eq!((content_width, content_height), (140.0, 100.0));
            assert!(metadata["pdfImagePlacement"].is_null());
            continue;
        }
        // The smaller page is scaled up to the canvas, not padded into a
        // corner of it: it fills the axis that constrains it, and keeps the
        // 4:3 shape it arrived with.
        assert_eq!(content_height, 100.0);
        assert!(
            (content_width / content_height - 80.0 / 60.0).abs() < 0.02,
            "page {index} lost its aspect ratio ({content_width}x{content_height})"
        );
        assert_pdf_image_placement_matches_canvas(&metadata);
    }
}

#[test]
fn matched_canvas_keeps_lower_resolution_continuous_tone_at_its_native_grid() {
    let scratch = Scratch::new("matched-physical");
    let manifest = scratch.path("matched-physical-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    // The same one-inch-square page scanned at 100 and at 200 DPI. Their PDF
    // rectangles agree; only the pixels the scanner produced differ.
    for (index, (dimension, dpi)) in [(100usize, 100), (200usize, 200)].into_iter().enumerate() {
        let input = scratch.path(&format!("matched-physical-input-{index}.png"));
        let output = scratch.path(&format!("matched-physical-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-physical-metadata-{index}.json"));
        let mut image = GrayImage::new(dimension, dimension, 255);
        // A bar covering the middle fifth of the page, in page-relative terms,
        // so a normalized document puts it at the same place on every page.
        for y in (dimension * 2 / 5)..(dimension * 3 / 5) {
            for x in (dimension / 10)..(dimension * 9 / 10) {
                image.set(x, y, 0);
            }
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
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 200,
                "heightPx": 200
            },
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

    let mut normalized_ink_extents = Vec::new();
    for index in 0..2 {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 50_000, 300).unwrap();
        let metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_paths[index]).unwrap()).unwrap();
        let expected_dimension = if index == 0 { 100 } else { 200 };
        assert_eq!(
            (image.width(), image.height()),
            (expected_dimension, expected_dimension),
            "continuous-tone pages must retain their source density"
        );
        assert_eq!(metadata["canvasPolicy"], "strict-maximum");
        assert_eq!(metadata["canvasOverflow"], false);
        assert_eq!(metadata["matchedCanvasContentWidthPx"], expected_dimension);
        assert_eq!(metadata["matchedCanvasContentHeightPx"], expected_dimension);
        let ink_rows = (0..image.height())
            .filter(|&y| (0..image.width()).any(|x| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!ink_rows.is_empty(), "the bar was lost");
        normalized_ink_extents.push((
            *ink_rows.first().unwrap() as f64 / image.height() as f64,
            *ink_rows.last().unwrap() as f64 / image.height() as f64,
        ));
    }
    let first = normalized_ink_extents[0];
    let second = normalized_ink_extents[1];
    for (low, high) in [(first.0, second.0), (first.1, second.1)] {
        let difference = low - high;
        assert!(
            difference.abs() <= 0.02,
            "physical bar placement disagrees by {difference:.4}"
        );
    }
}

#[test]
fn matched_canvas_keeps_color_at_source_resolution_and_emits_pdf_placement() {
    let scratch = Scratch::new("matched-color-placement");
    let manifest = scratch.path("manifest.json");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let metadata_path = scratch.path("output.json");
    let mut image = RgbImage::new(80, 60, [248; 3]);
    for y in 10..50 {
        for x in 15..65 {
            image.set(x, y, [30, 90, 180]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 28.8,
                "heightPoints": 24.0,
                "widthPx": 120,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("page.json"),
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "color",
                    "matchPageSize": true,
                    "pageAlignment": "center"
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata_path}]
            }]
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
    let raster = decode_gray(&fs::read(&output).unwrap(), 20_000, 200).unwrap();
    assert_eq!((raster.width(), raster.height()), (80, 60));
    let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
    assert_eq!(metadata["outputWidthPx"], 80);
    assert_eq!(metadata["outputHeightPx"], 60);
    assert_pdf_image_placement_matches_canvas(&metadata);
}

#[test]
fn matched_canvas_fits_an_oversized_page_instead_of_growing_the_document() {
    let scratch = Scratch::new("matched-oversized");
    let manifest = scratch.path("matched-oversized-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    // A portrait canvas page and a landscape page half again as wide as the
    // canvas: neither may resize the document.
    for (index, (width, height)) in [(100usize, 140usize), (210usize, 100usize)]
        .into_iter()
        .enumerate()
    {
        let input = scratch.path(&format!("matched-oversized-input-{index}.png"));
        let output = scratch.path(&format!("matched-oversized-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-oversized-metadata-{index}.json"));
        let mut image = GrayImage::new(width, height, 255);
        for y in (height / 4)..(height / 2) {
            for x in (width / 4)..(width / 2) {
                image.set(x, y, 0);
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-oversized-page-{index}.json")),
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
            "documentCanvas": {
                "widthPoints": 24.0,
                "heightPoints": 33.6,
                "widthPx": 100,
                "heightPx": 140
            },
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

    for (index, metadata_path) in metadata_paths.iter().enumerate() {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 50_000, 300).unwrap();
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        let expected_dimensions = if index == 0 { (100, 140) } else { (210, 100) };
        assert_eq!((image.width(), image.height()), expected_dimensions);
        assert_eq!(metadata["canvasWidthPx"], 100);
        assert_eq!(metadata["canvasHeightPx"], 140);
        let content_width = metadata["matchedCanvasContentWidthPx"].as_f64().unwrap();
        let content_height = metadata["matchedCanvasContentHeightPx"].as_f64().unwrap();
        assert!(content_width <= 100.0 && content_height <= 140.0);
        if index == 1 {
            // The landscape page is fitted by its width and padded above and
            // below; its shape survives the fit.
            assert_eq!(content_width, 100.0);
            assert!(
                (content_width / content_height - 210.0 / 100.0).abs() < 0.05,
                "the oversized page lost its aspect ratio ({content_width}x{content_height})"
            );
            assert!(metadata["placementOffsetYPx"].as_f64().unwrap() > 0.0);
            assert_pdf_image_placement_matches_canvas(&metadata);
        } else {
            assert!(metadata["pdfImagePlacement"].is_null());
        }
    }
}

#[test]
fn matched_canvas_keeps_rotation_and_margins_inside_the_document_rectangle() {
    let scratch = Scratch::new("matched-rotation");
    let manifest = scratch.path("matched-rotation-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    for index in 0..2 {
        let input = scratch.path(&format!("matched-rotation-input-{index}.png"));
        let output = scratch.path(&format!("matched-rotation-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-rotation-metadata-{index}.json"));
        let mut image = GrayImage::new(240, 320, 250);
        for y in (40..280).step_by(12) {
            for x in 30..210 {
                image.set(x, y, 12);
                image.set(x, y + 1, 12);
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-rotation-page-{index}.json")),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                // Cropping with the default 5 mm margins on every side. Any
                // part beyond the scan becomes white output paper, and the
                // complete padded raster is fitted inside this rectangle.
                "cropContent": true,
                "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center",
                "rotationDegrees": if index == 1 { 90 } else { 0 }
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
            "documentCanvas": {
                "widthPoints": 57.6,
                "heightPoints": 76.8,
                "widthPx": 240,
                "heightPx": 320
            },
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

    for (index, metadata_path) in metadata_paths.iter().enumerate() {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 300_000, 500).unwrap();
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (
                usize::try_from(metadata["outputWidthPx"].as_u64().unwrap()).unwrap(),
                usize::try_from(metadata["outputHeightPx"].as_u64().unwrap()).unwrap(),
            ),
        );
        assert_eq!(metadata["canvasWidthPx"], 240);
        assert_eq!(metadata["canvasHeightPx"], 320);
        assert!(metadata["matchedCanvasContentWidthPx"].as_f64().unwrap() <= 240.0);
        assert!(metadata["matchedCanvasContentHeightPx"].as_f64().unwrap() <= 320.0);
        if metadata["pdfImagePlacement"].is_object() {
            assert_pdf_image_placement_matches_canvas(&metadata);
        } else {
            assert_eq!(metadata["matchedCanvasContentWidthPx"], 240);
            assert_eq!(metadata["matchedCanvasContentHeightPx"], 320);
            assert_eq!(metadata["placementOffsetXPx"], 0);
            assert_eq!(metadata["placementOffsetYPx"], 0);
        }
    }
}

#[test]
fn matched_canvas_preview_places_a_page_exactly_where_the_final_run_does() {
    let scratch = Scratch::new("matched-preview");
    let manifest = scratch.path("matched-preview-manifest.json");
    let input = scratch.path("matched-preview-input.png");
    let output = scratch.path("matched-preview-output.png");
    let metadata_path = scratch.path("matched-preview-metadata.json");
    let mut image = GrayImage::new(80, 60, 255);
    for y in 12..40 {
        for x in 10..70 {
            if y % 6 < 2 {
                image.set(x, y, 15);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 33.6,
            "heightPoints": 24.0,
            "widthPx": 140,
            "heightPx": 100
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("matched-preview-page.json"),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center"
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata_path}]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let run = || {
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&result.stderr)
        );
        let metadata: Value = serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
        (metadata, (image.width(), image.height()))
    };
    let (final_metadata, final_dimensions) = run();

    let mut preview_payload = payload;
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let (preview_metadata, preview_dimensions) = run();

    for field in [
        "canvasWidthPx",
        "canvasHeightPx",
        "matchedCanvasTargetWidthPoints",
        "matchedCanvasTargetHeightPoints",
        "matchedCanvasContentWidthPx",
        "matchedCanvasContentHeightPx",
        "placementOffsetXPx",
        "placementOffsetYPx",
    ] {
        assert_eq!(
            preview_metadata[field], final_metadata[field],
            "preview and final disagree about {field}"
        );
    }
    // Both modes retain the raster they rendered. The final adds the PDF
    // placement contract while the preview already has the canvas fields its
    // renderer consumes.
    assert_eq!(final_dimensions, (80, 60));
    assert_eq!(preview_dimensions, (80, 60));
    assert_eq!(final_metadata["outputWidthPx"], 80);
    assert_eq!(preview_metadata["outputWidthPx"], 80);
    assert_pdf_image_placement_matches_canvas(&final_metadata);
    assert!(preview_metadata["pdfImagePlacement"].is_null());
}

/// `maxPixels` is a limit the matched canvas may reach and never pass. The
/// owner measures the grid in `resolveScanCleanupDocumentCanvas` and this
/// process is what enforces it, so the two have to agree on where the boundary
/// is: a grid whose area is exactly the budget renders, and one pixel more is
/// refused outright rather than trimmed. The budget is scaled down to a grid a
/// test can actually render; the comparison it exercises is the same one an A4
/// document at 1200 dpi lands on.
#[test]
fn matched_canvas_renders_at_exactly_the_pixel_budget_and_refuses_one_past_it() {
    let scratch = Scratch::new("matched-canvas-budget");
    let input = scratch.path("budget-input.png");
    let mut image = GrayImage::new(80, 60, 255);
    for y in 12..40 {
        for x in 10..70 {
            if y % 6 < 2 {
                image.set(x, y, 15);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    // 140 x 100 = 14_000 pixels, which is exactly the budget the accepting run
    // is given and one pixel more than the refusing one is.
    let run = |label: &str, max_pixels: u64| {
        let manifest = scratch.path(&format!("budget-{label}-manifest.json"));
        let output = scratch.path(&format!("budget-{label}-output.png"));
        let metadata_path = scratch.path(&format!("budget-{label}-metadata.json"));
        let page_metadata_path = scratch.path(&format!("budget-{label}-page.json"));
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 3,
                "operation": "render",
                "renderMode": "final",
                "canvasScope": "document",
                "documentCanvas": {
                    "widthPoints": 33.6,
                    "heightPoints": 24.0,
                    "widthPx": 140,
                    "heightPx": 100
                },
                "pages": [{
                    "inputPath": input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": page_metadata_path,
                    "options": {
                        "dpi": 300,
                        "layout": "force-single",
                        "normalizeIllumination": false,
                        "cropContent": false,
                        "outputMode": "grayscale",
                        "matchPageSize": true,
                        "pageAlignment": "center",
                        "maxPixels": max_pixels
                    },
                    "outputs": [{"outputPath": output, "metadataPath": metadata_path}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        (result, output, metadata_path, page_metadata_path)
    };

    let (accepted, accepted_output, accepted_metadata, accepted_page_metadata) =
        run("exact", 14_000);
    assert!(
        accepted.status.success(),
        "a canvas of exactly maxPixels has to render; stderr={}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let rendered = decode_gray(&fs::read(&accepted_output).unwrap(), 14_000, 400).unwrap();
    assert_eq!((rendered.width(), rendered.height()), (80, 60));
    let metadata: Value = serde_json::from_slice(&fs::read(&accepted_metadata).unwrap()).unwrap();
    assert_eq!(metadata["canvasWidthPx"], 140);
    assert_eq!(metadata["canvasHeightPx"], 100);
    assert_pdf_image_placement_matches_canvas(&metadata);
    assert!(accepted_page_metadata.exists());

    let (refused, refused_output, refused_metadata, refused_page_metadata) = run("over", 13_999);
    assert!(
        !refused.status.success(),
        "a canvas one pixel past maxPixels has to be refused"
    );
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(
        stderr.contains("140x100") && stderr.contains("exceeds cleanup guardrails"),
        "stderr={stderr}"
    );
    // A refused canvas leaves nothing half-written behind.
    assert!(!refused_output.exists());
    assert!(!refused_metadata.exists());
    assert!(!refused_page_metadata.exists());
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

#[cfg(unix)]
#[test]
fn final_render_publishes_each_page_without_a_whole_document_analysis_pass() {
    let scratch = Scratch::new("incremental-final");
    let input = scratch.path("incremental-input.png");
    let gated_input = scratch.path("incremental-gate.fifo");
    let manifest = scratch.path("incremental-manifest.json");
    let encoded = encode_gray(&GrayImage::new(160, 120, 245)).unwrap();
    fs::write(&input, &encoded).unwrap();
    assert!(Command::new("mkfifo")
        .arg(&gated_input)
        .status()
        .unwrap()
        .success());
    let pages = [&input, &gated_input]
        .into_iter()
        .enumerate()
        .map(|(index, page_input)| {
            serde_json::json!({
                "inputPath": page_input,
                "sourcePageIndex": index,
                "pageMetadataPath": scratch.path(&format!("incremental-page-{index}.json")),
                "options": unmatched_options(),
                "outputs": [{
                    "outputPath": scratch.path(&format!("incremental-{index}.png")),
                    "metadataPath": scratch.path(&format!("incremental-{index}-output.json")),
                }],
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
            "pages": pages,
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
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            sender
                .send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .unwrap();
        }
    });

    let first_complete = loop {
        match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(event) if event["progress"]["stage"] == "page-complete" => break event,
            Ok(event) => assert_ne!(
                event["progress"]["stage"], "page-analyzed",
                "a final render must not classify pages in a separate pass"
            ),
            Err(error) => {
                let _ = child.kill();
                panic!("no page completed while the second page was still gated: {error}");
            }
        }
    };
    assert_eq!(first_complete["progress"]["pageNumber"], 1);
    assert_eq!(first_complete["progress"]["completedPages"], 1);
    assert!(scratch.path("incremental-0.png").exists());
    assert!(
        child.try_wait().unwrap().is_none(),
        "the gated second page should keep the batch running"
    );

    fs::write(&gated_input, encoded).unwrap();
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    assert!(scratch.path("incremental-1.png").exists());
}

/// Matched page size means one output page size *and* one scale. A book page
/// scanned on its own and the same page scanned as half of a spread have to
/// land at the same size, or the document carries a scale difference that came
/// from nothing but how the sheets were fed through the scanner.
#[test]
fn matched_canvas_places_a_spread_half_at_the_same_scale_as_an_unsplit_page() {
    let scratch = Scratch::new("matched-spread");
    let manifest = scratch.path("matched-spread-manifest.json");
    // One page-sized block of ink, drawn page-relative, so every output that
    // carries one book page has to show the same bar in the same place.
    let draw_page = |image: &mut GrayImage, left: usize, width: usize| {
        for y in (image.height() * 2 / 5)..(image.height() * 3 / 5) {
            for x in (left + width / 10)..(left + (width * 9 / 10)) {
                image.set(x, y, 0);
            }
        }
    };

    let single_input = scratch.path("matched-spread-single.png");
    let mut single = GrayImage::new(100, 100, 255);
    draw_page(&mut single, 0, 100);
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();

    let spread_input = scratch.path("matched-spread-spread.png");
    let mut spread = GrayImage::new(200, 100, 255);
    draw_page(&mut spread, 0, 100);
    draw_page(&mut spread, 100, 100);
    // A gutter the splitter can find between the two book pages.
    for y in 0..spread.height() {
        for x in 96..104 {
            spread.set(x, y, 255);
        }
    }
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();

    let single_output = scratch.path("matched-spread-single-out.png");
    let left_output = scratch.path("matched-spread-left.png");
    let right_output = scratch.path("matched-spread-right.png");
    let page_options = |layout: &str| {
        serde_json::json!({
            "dpi": 100,
            "layout": layout,
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
        })
    };
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [
                {
                    "inputPath": single_input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": scratch.path("matched-spread-page-0.json"),
                    "options": page_options("force-single"),
                    "outputs": [{
                        "outputPath": single_output,
                        "metadataPath": scratch.path("matched-spread-single-out.json")
                    }]
                },
                {
                    "inputPath": spread_input,
                    "sourcePageIndex": 1,
                    "pageMetadataPath": scratch.path("matched-spread-page-1.json"),
                    "options": page_options("force-two-page"),
                    "outputs": [
                        {
                            "outputPath": left_output,
                            "metadataPath": scratch.path("matched-spread-left.json")
                        },
                        {
                            "outputPath": right_output,
                            "metadataPath": scratch.path("matched-spread-right.json")
                        }
                    ]
                }
            ]
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

    let mut ink_columns = Vec::new();
    for path in [&single_output, &left_output, &right_output] {
        let image = decode_gray(&fs::read(path).unwrap(), 50_000, 300).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (100, 100),
            "every matched output is the document grid"
        );
        let columns = (0..image.width())
            .filter(|&x| (0..image.height()).any(|y| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!columns.is_empty(), "the bar was lost");
        ink_columns.push((*columns.first().unwrap(), *columns.last().unwrap()));
    }
    // The unsplit page and both spread halves carry the bar at the same width:
    // the halves were scaled by their own share of the sheet, not by the whole
    // spread, so nothing shrank to half size.
    let (single_first, single_last) = ink_columns[0];
    for (first, last) in &ink_columns[1..] {
        assert!(
            (*first as i64 - single_first as i64).abs() <= 4
                && (*last as i64 - single_last as i64).abs() <= 4,
            "spread half ink {first}..{last} disagrees with the unsplit page {single_first}..{single_last}"
        );
    }
}

#[test]
fn matched_canvas_measures_a_kept_half_by_the_paper_it_kept() {
    // Keeping one side of a spread produces a single output that carries half a
    // sheet. Deriving its share from how many outputs the page produced would
    // call that half a whole sheet and scale it down to fit the document, which
    // is the same defect as padding a spread half onto its source sheet.
    let scratch = Scratch::new("matched-keep");
    let manifest = scratch.path("matched-keep-manifest.json");
    let draw_page = |image: &mut GrayImage, left: usize, width: usize| {
        for y in (image.height() * 2 / 5)..(image.height() * 3 / 5) {
            for x in (left + width / 10)..(left + (width * 9 / 10)) {
                image.set(x, y, 0);
            }
        }
    };

    let single_input = scratch.path("matched-keep-single.png");
    let mut single = GrayImage::new(100, 100, 255);
    draw_page(&mut single, 0, 100);
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();

    let spread_input = scratch.path("matched-keep-spread.png");
    let mut spread = GrayImage::new(200, 100, 255);
    draw_page(&mut spread, 0, 100);
    draw_page(&mut spread, 100, 100);
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();

    let single_output = scratch.path("matched-keep-single-out.png");
    let kept_output = scratch.path("matched-keep-left-out.png");
    let page_options = |layout: &str| {
        serde_json::json!({
            "dpi": 100,
            "layout": layout,
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
        })
    };
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [
                {
                    "inputPath": single_input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": scratch.path("matched-keep-page-0.json"),
                    "options": page_options("force-single"),
                    "outputs": [{
                        "outputPath": single_output,
                        "metadataPath": scratch.path("matched-keep-single-out.json")
                    }]
                },
                {
                    "inputPath": spread_input,
                    "sourcePageIndex": 1,
                    "pageMetadataPath": scratch.path("matched-keep-page-1.json"),
                    "options": page_options("keep-left"),
                    "outputs": [{
                        "outputPath": kept_output,
                        "metadataPath": scratch.path("matched-keep-left-out.json")
                    }]
                }
            ]
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

    let mut ink_columns = Vec::new();
    for path in [&single_output, &kept_output] {
        let image = decode_gray(&fs::read(path).unwrap(), 50_000, 300).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (100, 100),
            "every matched output is the document grid"
        );
        let columns = (0..image.width())
            .filter(|&x| (0..image.height()).any(|y| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!columns.is_empty(), "the bar was lost");
        ink_columns.push((*columns.first().unwrap(), *columns.last().unwrap()));
    }
    let (single_first, single_last) = ink_columns[0];
    let (kept_first, kept_last) = ink_columns[1];
    assert!(
        (kept_first as i64 - single_first as i64).abs() <= 4
            && (kept_last as i64 - single_last as i64).abs() <= 4,
        "kept half ink {kept_first}..{kept_last} disagrees with the unsplit page {single_first}..{single_last}"
    );
}

#[test]
fn matched_canvas_keeps_a_page_that_already_fits_off_the_resampler() {
    // The canvas grid is rounded up from points the way Poppler rounds a page
    // into pixels, so the page the canvas was measured from arrives exactly on
    // it. A one-pixel disagreement must not put the page through a resample or
    // report it as a page that could not hold the document's scale.
    let scratch = Scratch::new("matched-tolerance");
    let manifest = scratch.path("matched-tolerance-manifest.json");
    let input = scratch.path("matched-tolerance-input.png");
    let output = scratch.path("matched-tolerance-out.png");
    let metadata = scratch.path("matched-tolerance-out.json");
    let mut image = GrayImage::new(101, 100, 255);
    for y in 40..60 {
        for x in 10..90 {
            image.set(x, y, 0);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            // A grid one pixel narrower than the raster of the page it was
            // measured from, which is what a fractional page rectangle leaves
            // behind: the renderer rounds 100.5 points up to 101 pixels.
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-tolerance-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
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
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
    assert_eq!(
        metadata_json["warnings"],
        serde_json::json!([]),
        "a page within a pixel of the grid is not reported as fitted below it"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (101, 100));
    assert_pdf_image_placement_matches_canvas(&metadata_json);
}

#[test]
fn matched_canvas_reserves_requested_output_padding_inside_the_physical_page() {
    // Matched margins are physical insets in the document canvas. When the
    // detected content reaches the scan edge, the content is fitted into that
    // inset rather than expanding a padded raster and scaling the requested
    // margin back below its physical size.
    let scratch = Scratch::new("matched-overflow-warning");
    let manifest = scratch.path("matched-overflow-manifest.json");
    let input = scratch.path("matched-overflow-input.png");
    let output = scratch.path("matched-overflow-out.png");
    let metadata = scratch.path("matched-overflow-out.json");
    // A full-bleed cover: there are no source pixels from which the requested
    // margin could be retained, so placement has to reserve white PDF paper.
    let image = GrayImage::new(100, 100, 40);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-overflow-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    // Cropping to this page's ink and then laying 6 mm of paper
                    // around it asks for more room than the page has.
                    "cropContent": true,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 6, "topMm": 6, "rightMm": 6, "bottomMm": 6},
                    "manualContentBoxes": {
                        "full": {
                            "xNormalized": 0,
                            "yNormalized": 0,
                            "widthNormalized": 1,
                            "heightNormalized": 1,
                            "rotationDegrees": 0
                        }
                    }
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
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
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(true));
    let warnings = metadata_json["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("document canvas")),
        "warnings={warnings:?}"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (100, 100));
    assert_pdf_image_placement_matches_canvas(&metadata_json);
    assert_eq!(metadata_json["appliedMargins"]["leftPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["topPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["rightPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["bottomPx"], 24.0);
    // Six millimetres at 100 DPI rounds to 24 pixels on every edge. A
    // continuous-tone page keeps its intrinsic samples and carries that inset
    // as PDF placement rather than baking redundant white pixels into PNG.
    assert!((0..image.width()).all(|x| (0..image.height()).all(|y| image.get(x, y) < 128)));
}

#[test]
fn matched_canvas_reports_a_sheet_larger_than_the_rectangle_it_was_measured_for() {
    // The quiet way a page ends up below the document's scale: the canvas was
    // measured for half sheets — the run expected this page to be a spread —
    // and the page is then cut as one whole sheet. Nothing overflows and
    // nothing is clipped, the grid stays uniform, and the page is simply
    // letterboxed at half the scale of every page around it, which is only
    // visible if the run says so.
    let scratch = Scratch::new("matched-undersized-paper");
    let manifest = scratch.path("matched-undersized-manifest.json");
    let input = scratch.path("matched-undersized-input.png");
    let output = scratch.path("matched-undersized-out.png");
    let metadata = scratch.path("matched-undersized-out.json");
    let mut image = GrayImage::new(100, 100, 255);
    for y in 40..60 {
        for x in 10..90 {
            image.set(x, y, 0);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            // Half of this page's sheet, at the same 100 DPI grid.
            "documentCanvas": {
                "widthPoints": 36.0,
                "heightPoints": 72.0,
                "widthPx": 50,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-undersized-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
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
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    // The page fits the canvas it was placed on; it is the paper that did not.
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
    assert_eq!(metadata_json["matchedCanvasContentWidthPx"], 50);
    assert_eq!(metadata_json["matchedCanvasContentHeightPx"], 50);
    let warnings = metadata_json["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .unwrap_or("")
            .contains("at 50.0% of the document's scale")),
        "warnings={warnings:?}"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (100, 100));
    assert_pdf_image_placement_matches_canvas(&metadata_json);
}

/// The same overflow, previewed. Preview and final renders share the exact
/// final-grid inset: the intrinsic raster is the physical page and the
/// matched-content box describes where its full-bleed source is displayed.
#[test]
fn matched_canvas_preview_reserves_padding_inside_the_physical_page() {
    let scratch = Scratch::new("matched-overflow-preview");
    let manifest = scratch.path("matched-overflow-preview-manifest.json");
    let input = scratch.path("matched-overflow-preview-input.png");
    let output = scratch.path("matched-overflow-preview-out.png");
    let metadata = scratch.path("matched-overflow-preview-out.json");
    let image = GrayImage::new(200, 180, 40);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "preview",
            "canvasScope": "page",
            // The page's own paper, which is the document's: 5 mm of margin
            // around content that already reaches the edge asks for more.
            "documentCanvas": {
                "widthPoints": 96.0,
                "heightPoints": 86.4,
                "widthPx": 200,
                "heightPx": 180
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-overflow-preview-page.json"),
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": true,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-center",
                    "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
                    "manualContentBoxes": {
                        "full": {
                            "xNormalized": 0,
                            "yNormalized": 0,
                            "widthNormalized": 1,
                            "heightNormalized": 1,
                            "rotationDegrees": 0
                        }
                    }
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
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
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    let canvas_width = metadata_json["canvasWidthPx"].as_u64().unwrap();
    let canvas_height = metadata_json["canvasHeightPx"].as_u64().unwrap();
    let content_width = metadata_json["matchedCanvasContentWidthPx"]
        .as_u64()
        .unwrap();
    let content_height = metadata_json["matchedCanvasContentHeightPx"]
        .as_u64()
        .unwrap();
    let offset_x = metadata_json["placementOffsetXPx"].as_u64().unwrap();
    let offset_y = metadata_json["placementOffsetYPx"].as_u64().unwrap();
    assert_eq!((canvas_width, canvas_height), (200, 180));
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(true));
    // The intrinsic page and its inset placement both remain on the canvas
    // after presentation scales the source raster into its content box.
    assert!(offset_x + content_width <= canvas_width);
    assert!(offset_y + content_height <= canvas_height);
    assert_eq!(
        metadata_json["outputWidthPx"].as_u64().unwrap(),
        canvas_width
    );
    assert_eq!(
        metadata_json["outputHeightPx"].as_u64().unwrap(),
        canvas_height
    );
    assert_eq!(metadata_json["appliedMargins"]["leftPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["topPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["rightPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["bottomPx"], 30.0);
    // Preserve the source aspect ratio inside the 140x120 inner rectangle;
    // the seven spare horizontal pixels follow the requested top-center
    // alignment.
    assert_eq!((content_width, content_height), (133, 120));
    assert_eq!((offset_x, offset_y), (33, 30));
    // Preview publishes the physical page unchanged; presentation applies
    // the content box and exposes the exact five-millimetre boundary.
    let published = decode_gray(&fs::read(&output).unwrap(), 200_000, 400).unwrap();
    assert_eq!(
        u64::try_from(published.width()).unwrap(),
        metadata_json["outputWidthPx"].as_u64().unwrap()
    );
    assert_eq!((published.width(), published.height()), (200, 180));
    assert!(
        (0..published.width()).all(|x| (0..published.height()).all(|y| published.get(x, y) < 128))
    );
}
