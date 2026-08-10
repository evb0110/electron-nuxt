use std::{
    env, fs,
    fs::File,
    path::{Path, PathBuf},
    process::{self, Command},
    time::{SystemTime, UNIX_EPOCH},
};

use evb_pdf_image_combine::{
    write_pdf, FramePolicy, ImageCompression, ImageProcessing, ImageSpec, InputSource, PageSpec,
    PdfBuildOptions,
};

#[test]
fn cli_streaming_path_matches_the_core_without_vec_staging() {
    let first_path = temp_path("stream-first").with_extension("ppm");
    let second_path = temp_path("stream-second").with_extension("ppm");
    let output_path = temp_path("stream-output").with_extension("pdf");
    let first = b"P6\n1 1\n255\n\xff\0\0";
    let second = b"P6\n1 1\n255\n\0\xff\0";
    fs::write(&first_path, first).unwrap();
    fs::write(&second_path, second).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .args([&first_path, &second_path])
        .status()
        .unwrap();
    assert!(status.success());

    let expected = write_pdf(
        Vec::new(),
        [
            image_bytes("first.ppm", first),
            image_bytes("second.ppm", second),
        ],
        &PdfBuildOptions::default(),
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(&output_path).unwrap(), expected);

    remove_files([&first_path, &second_path, &output_path]);
}

#[test]
fn cli_preserves_existing_output_and_removes_temporary_on_late_failure() {
    let valid_path = temp_path("late-valid").with_extension("ppm");
    let invalid_path = temp_path("late-invalid").with_extension("ppm");
    let output_path = temp_path("late-output").with_extension("pdf");
    fs::write(&valid_path, b"P6\n1 1\n255\n\xff\0\0").unwrap();
    fs::write(&invalid_path, b"invalid").unwrap();
    fs::write(&output_path, b"existing-output").unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .args([&valid_path, &invalid_path])
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-output");
    assert_no_sibling_temporary(&output_path);

    remove_files([&valid_path, &invalid_path, &output_path]);
}

#[test]
fn cli_preserves_existing_output_for_oversized_input() {
    let input_path = temp_path("oversized-input").with_extension("ppm");
    let output_path = temp_path("oversized-output").with_extension("pdf");
    fs::write(&input_path, b"P6\n1001 1000\n255\n").unwrap();
    fs::write(&output_path, b"existing-output").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS", "1000000")
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .arg(&input_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-output");
    assert_no_sibling_temporary(&output_path);

    remove_files([&input_path, &output_path]);
}

#[test]
fn cli_rejects_compact_manifest_over_configured_page_limit_before_image_io() {
    let manifest_path = temp_path("oversized-manifest").with_extension("tsv");
    let output_path = temp_path("oversized-manifest-output").with_extension("pdf");
    fs::write(
        &manifest_path,
        "image\t72\t72\t/missing-one.ppm\nimage\t72\t72\t/missing-two.ppm\n",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_PAGES", "1")
        .args([
            "--output",
            output_path.to_str().unwrap(),
            "--compact-manifest",
        ])
        .arg(&manifest_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("1-page admission ceiling"));
    assert!(!output_path.exists());

    remove_files([&manifest_path, &output_path]);
}

#[test]
fn cli_rejects_oversized_jpeg_and_jp2_dimensions_before_pdf_output() {
    let fixtures = [
        ("jpg", oversized_jpeg(2_000, 2_000)),
        ("jp2", oversized_jp2(2_000, 2_000)),
    ];

    for (extension, bytes) in fixtures {
        let input_path = temp_path("oversized-dimensions").with_extension(extension);
        let output_path = temp_path("oversized-dimensions-output").with_extension("pdf");
        fs::write(&input_path, bytes).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
            .env("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS", "1000000")
            .args(["--output", output_path.to_str().unwrap(), "--"])
            .arg(&input_path)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "{extension} unexpectedly succeeded"
        );
        let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(envelope["code"], "too-large", "{extension}: {envelope}");
        assert!(!output_path.exists());
        assert_no_sibling_temporary(&output_path);

        remove_files([&input_path, &output_path]);
    }
}

#[test]
fn cli_rejects_sparse_manifest_above_the_byte_limit_before_parsing() {
    let manifest_path = temp_path("oversized-manifest-bytes").with_extension("tsv");
    let output_path = temp_path("oversized-manifest-bytes-output").with_extension("pdf");
    File::create(&manifest_path)
        .unwrap()
        .set_len((64 * 1024 * 1024) + 1)
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args([
            "--output",
            output_path.to_str().unwrap(),
            "--compact-manifest",
        ])
        .arg(&manifest_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("67108864-byte admission ceiling"));
    assert!(!output_path.exists());

    remove_files([&manifest_path, &output_path]);
}

fn oversized_jpeg(width: u16, height: u16) -> Vec<u8> {
    let [width_high, width_low] = width.to_be_bytes();
    let [height_high, height_low] = height.to_be_bytes();
    vec![
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x0b,
        8,
        height_high,
        height_low,
        width_high,
        width_low,
        0x01,
        0x01,
        0x11,
        0x00,
        0xff,
        0xda,
        0x00,
        0x08,
        0x01,
        0x01,
        0x00,
        0x00,
        0x3f,
        0x00,
        0x11,
        0xff,
        0xd9,
    ]
}

fn oversized_jp2(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\0\0\0\x0cjP  \r\n\x87\n".to_vec();
    bytes.extend_from_slice(&30u32.to_be_bytes());
    bytes.extend_from_slice(b"jp2h");
    bytes.extend_from_slice(&22u32.to_be_bytes());
    bytes.extend_from_slice(b"ihdr");
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&3u16.to_be_bytes());
    bytes.extend_from_slice(&[7, 7, 0, 0]);
    bytes
}

fn image_bytes<'a>(file_name: &'a str, data: &'a [u8]) -> PageSpec<InputSource<'a>> {
    PageSpec::Image {
        page_size: None,
        placement: None,
        image: ImageSpec {
            source: InputSource::Bytes { file_name, data },
            compression: ImageCompression::Auto,
            processing: ImageProcessing::None,
            size_guardrail: None,
        },
        frames: FramePolicy::All,
    }
}

fn temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-image-combine-{label}-{}-{nanos}",
        process::id()
    ))
}

fn assert_no_sibling_temporary(output_path: &Path) {
    let marker = format!(
        ".{}.evb-tmp-",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let leftovers = fs::read_dir(output_path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
        .count();
    assert_eq!(leftovers, 0);
}

fn remove_files<const N: usize>(paths: [&PathBuf; N]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}
