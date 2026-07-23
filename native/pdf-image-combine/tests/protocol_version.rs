use std::process::Command;

#[test]
fn protocol_version_flag_prints_supported_protocol() {
    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .arg("--protocol-version")
        .output()
        .expect("protocol version command runs");

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "4\n");
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
}
