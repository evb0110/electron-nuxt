use serde_json::Value;
use std::{fs, process::Command};

#[test]
fn streams_netpbm_probe_metrics_through_the_real_binary() {
    let path = std::env::temp_dir().join(format!("evb-netpbm-probe-{}.ppm", std::process::id()));
    fs::write(
        &path,
        b"P6\n# deterministic probe\n3 1\n255\n\xff\xff\xff\x10\x10\x10\xc8\x20\x20",
    )
    .expect("write Netpbm probe fixture");

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--probe-netpbm", path.to_str().unwrap()])
        .output()
        .expect("run Netpbm probe binary");
    fs::remove_file(path).expect("remove Netpbm probe fixture");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let probe: Value = serde_json::from_slice(&output.stdout).expect("parse Netpbm probe response");

    assert_eq!(probe["magic"], "P6");
    assert_eq!(probe["width"], 3);
    assert_eq!(probe["height"], 1);
    assert_eq!(probe["darkRatio"], 1.0 / 3.0);
    assert_eq!(probe["nonWhiteRatio"], 2.0 / 3.0);
    assert_eq!(probe["colorRatio"], 0.5);
}
