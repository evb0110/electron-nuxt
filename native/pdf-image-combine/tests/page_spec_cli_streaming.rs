use std::{
    env, fs,
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

    let status = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS", "1000000")
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .arg(&input_path)
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-output");
    assert_no_sibling_temporary(&output_path);

    remove_files([&input_path, &output_path]);
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
