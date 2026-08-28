use lopdf::{dictionary, Document, Object};
use serde_json::Value;
use std::{
    env,
    fs::{read, remove_file, write},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

fn path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-page-ops-error-{label}-{nonce}.{extension}"
    ))
}

fn run_page_sizes(input: &Path, output: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["page-sizes", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .output()
        .unwrap()
}

fn run_page_geometry(input: &Path, output: &Path, page_number: u32) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["page-geometry", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--page")
        .arg(page_number.to_string())
        .output()
        .unwrap()
}

fn run_append(input: &Path, output: &Path, updates: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["update-note-text", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--updates-file")
        .arg(updates)
        .args(["--modified-at", "D:20260809120000Z", "--append"])
        .output()
        .unwrap()
}

fn run_crop(input: &Path, output: &Path, pages: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["crop", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--pages-file")
        .arg(pages)
        .args(["--top", "4", "--bottom", "3", "--left", "2", "--right", "1"])
        .output()
        .unwrap()
}

#[cfg(unix)]
fn run_pdf_conformance(input: &Path, output: &Path, qpdf: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["pdf-conformance", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--qpdf")
        .arg(qpdf)
        .output()
        .unwrap()
}

#[cfg(unix)]
fn write_fake_qpdf(qpdf: &Path, status: i32, structure: &str) {
    use std::os::unix::fs::PermissionsExt;

    let script = format!("#!/bin/sh\nprintf '%s' '{structure}'\nexit {status}\n");
    write(qpdf, script).unwrap();
    let mut permissions = qpdf.metadata().unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(qpdf, permissions).unwrap();
}

fn error_code(output: &Output) -> String {
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope: Value = serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("invalid native error envelope ({error}): {stderr}"));
    envelope["code"].as_str().unwrap().to_string()
}

#[cfg(unix)]
#[test]
fn pdf_conformance_accepts_only_valid_qpdf_warning_output() {
    const VALID_STRUCTURE: &str = r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#;
    const TRUNCATED_STRUCTURE: &str =
        r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"#;
    let input = path("qpdf-status-input", "pdf");
    let mut document = Document::with_version("1.4");
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog" });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let warning_qpdf = path("qpdf-warning", "sh");
    let warning_output = path("qpdf-warning-output", "json");
    write_fake_qpdf(&warning_qpdf, 3, VALID_STRUCTURE);
    let warning_result = run_pdf_conformance(&input, &warning_output, &warning_qpdf);
    assert!(
        warning_result.status.success(),
        "valid warning-only qpdf output failed: {}",
        String::from_utf8_lossy(&warning_result.stderr)
    );
    let facts: Value = serde_json::from_slice(&read(&warning_output).unwrap()).unwrap();
    assert_eq!(facts["isSigned"], false);

    let truncated_qpdf = path("qpdf-truncated-warning", "sh");
    let truncated_output = path("qpdf-truncated-output", "json");
    write_fake_qpdf(&truncated_qpdf, 3, TRUNCATED_STRUCTURE);
    assert_eq!(
        error_code(&run_pdf_conformance(
            &input,
            &truncated_output,
            &truncated_qpdf,
        )),
        "native-failure"
    );

    let error_qpdf = path("qpdf-error", "sh");
    let error_output = path("qpdf-error-output", "json");
    write_fake_qpdf(&error_qpdf, 2, VALID_STRUCTURE);
    assert_eq!(
        error_code(&run_pdf_conformance(&input, &error_output, &error_qpdf)),
        "corrupt-xref"
    );

    for candidate in [
        input,
        warning_qpdf,
        warning_output,
        truncated_qpdf,
        truncated_output,
        error_qpdf,
        error_output,
    ] {
        let _ = remove_file(candidate);
    }
}

#[test]
fn crop_seeds_a_distinct_output_before_appending() {
    let input = path("crop-distinct-input", "pdf");
    let output = path("crop-distinct-output", "pdf");
    let pages = path("crop-distinct-pages", "txt");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&pages, b"1\n").unwrap();

    let result = run_crop(&input, &output, &pages);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let input_bytes = read(&input).unwrap();
    let output_bytes = read(&output).unwrap();
    assert!(output_bytes.starts_with(&input_bytes));
    assert!(output_bytes.len() > input_bytes.len());
    let cropped = Document::load(&output).unwrap();
    let crop_box = cropped
        .get_dictionary(page_id)
        .unwrap()
        .get(b"CropBox")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_float().unwrap() as f64)
        .collect::<Vec<_>>();
    assert_eq!(crop_box, vec![2.0, 3.0, 199.0, 96.0]);

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(pages);
}

#[test]
fn missing_pdf_is_io_for_direct_and_append_paths() {
    let input = path("missing-input", "pdf");
    let output = path("missing-output", "pdf");
    let updates = path("missing-updates", "json");
    write(
        &updates,
        r#"{"updates":[{"objectNumber":1,"generationNumber":0,"text":"updated"}]}"#,
    )
    .unwrap();

    assert_eq!(error_code(&run_page_sizes(&input, &output)), "io");
    assert_eq!(error_code(&run_append(&input, &output, &updates)), "io");

    let _ = remove_file(output);
    let _ = remove_file(updates);
}

#[test]
fn corrupt_pdf_is_corrupt_xref_for_direct_and_append_paths() {
    let input = path("corrupt-input", "pdf");
    let output = path("corrupt-output", "pdf");
    let updates = path("corrupt-updates", "json");
    write(&input, b"%PDF-1.7\nnot a valid PDF\n").unwrap();
    write(&output, b"%PDF-1.7\nnot a valid PDF\n").unwrap();
    write(
        &updates,
        r#"{"updates":[{"objectNumber":1,"generationNumber":0,"text":"updated"}]}"#,
    )
    .unwrap();

    assert_eq!(error_code(&run_page_sizes(&input, &output)), "corrupt-xref");
    assert_eq!(
        error_code(&run_append(&input, &output, &updates)),
        "corrupt-xref"
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(updates);
}

#[test]
fn page_geometry_reports_inherited_boxes_and_rotation() {
    let input = path("geometry-input", "pdf");
    let output = path("geometry-output", "json");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
            "MediaBox" => vec![10.into(), 20.into(), 210.into(), 120.into()],
            "CropBox" => vec![30.into(), 40.into(), 190.into(), 100.into()],
            "Rotate" => 90,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let result = run_page_geometry(&input, &output, 1);
    assert!(
        result.status.success(),
        "native page geometry failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let geometry: Value = serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
    assert_eq!(
        geometry,
        serde_json::json!({
            "mediaBox": {"x": 10.0, "y": 20.0, "width": 200.0, "height": 100.0},
            "cropBox": {"x": 30.0, "y": 40.0, "width": 160.0, "height": 60.0},
            "rotation": 90,
        })
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
}
