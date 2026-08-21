//! Integration coverage for the foreground-selection decode boundary: a
//! `.jb2e` selection whose header dimensions exceed the caller's per-side limit
//! must be rejected before its bitmap is allocated, not decoded and returned.

use evb_scan_cleanup::io::raster::{read_foreground_selection, RasterReadError};
use jbig2_codec::{encode_pdf_generic, Bilevel};
use std::fs;

#[test]
fn read_foreground_selection_rejects_dimensions_above_the_limit() {
    // A structurally valid 8x8 all-white selection. The bytes are legitimate;
    // only the caller's dimension ceiling makes it oversized.
    let width = 8u32;
    let height = 8u32;
    let rows = vec![0u8; width.div_ceil(8) as usize * height as usize];
    let encoded = encode_pdf_generic(Bilevel {
        width,
        height,
        rows: &rows,
    })
    .expect("8x8 selection should encode");

    let directory = std::env::temp_dir().join(format!(
        "evb-scan-cleanup-oversized-selection-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("selection.jb2e");
    fs::write(&path, &encoded).unwrap();

    let error = read_foreground_selection(&path, u64::MAX, 4)
        .expect_err("a selection wider than the dimension limit must be rejected");
    // A dimension-limit rejection is a resource-limit failure, not malformed
    // input, so it must surface as TooLarge. The batch adapter maps that to
    // NativeErrorCode::TooLarge; classifying it as Invalid would mislabel it as
    // a bad request.
    assert!(
        matches!(error, RasterReadError::TooLarge(_)),
        "expected TooLarge for an over-limit selection, got: {error:?}"
    );

    // The same selection decodes cleanly once the limit admits its dimensions,
    // proving the rejection above is the dimension guard and not a parse failure.
    let decoded = read_foreground_selection(&path, u64::MAX, 8)
        .expect("selection within the dimension limit should decode");
    assert_eq!((decoded.width(), decoded.height()), (8, 8));

    fs::remove_dir_all(&directory).unwrap();
}
