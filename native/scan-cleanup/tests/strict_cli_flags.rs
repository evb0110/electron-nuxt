use serde_json::Value;
use std::process::Command;

fn assert_invalid_request(args: &[&str], expected_message: &str) {
    let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(args)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "args: {args:?}");
    let envelope: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "invalid-request", "args: {args:?}");
    assert_eq!(envelope["message"], expected_message, "args: {args:?}");
    assert!(output.stdout.is_empty(), "args: {args:?}");
}

#[test]
fn malformed_manifest_and_direct_flags_exit_as_invalid_requests() {
    for (args, expected_message) in [
        (vec!["--manifest"], "--manifest requires a value"),
        (
            vec!["--manifest", "a.json", "--manifest", "b.json"],
            "Duplicate argument --manifest",
        ),
        (
            vec!["--manifest", "a.json", "--unknown"],
            "Unknown argument --unknown",
        ),
        (
            vec!["--input", "in.ppm", "--input", "other.ppm"],
            "Duplicate argument --input",
        ),
        (vec!["--input", "--output"], "--input requires a value"),
        (
            vec![
                "--input",
                "in.ppm",
                "--output",
                "out.png",
                "--metadata",
                "out.json",
                "--ocr-mode",
                "true",
            ],
            "Unexpected positional argument true",
        ),
    ] {
        assert_invalid_request(&args, expected_message);
    }
}
