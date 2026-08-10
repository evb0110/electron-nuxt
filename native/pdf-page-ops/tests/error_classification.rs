use serde_json::Value;
use std::{
    env,
    fs::{remove_file, write},
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

fn error_code(output: &Output) -> String {
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope: Value = serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("invalid native error envelope ({error}): {stderr}"));
    envelope["code"].as_str().unwrap().to_string()
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
