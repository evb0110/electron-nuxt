use std::process::Command;

#[test]
fn protocol_version_flag_prints_supported_protocol() {
    let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .arg("--protocol-version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "{}\n",
            evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP.protocol_version
        )
    );
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
}

#[test]
fn standard_version_flags_print_descriptor_name_and_package_version() {
    for flag in ["--version", "-V"] {
        let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(output.status.success(), "{flag} failed");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{} {}\n",
                evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP.binary_name,
                env!("CARGO_PKG_VERSION"),
            ),
        );
        assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
    }
}
