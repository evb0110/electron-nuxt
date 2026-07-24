use evb_raster_io::{decode_ppm, read_ppm_dimensions, DecodeLimits};

const DECODE: DecodeLimits = DecodeLimits {
    max_pixels: 1_000_000,
    max_dimension: 10_000,
    max_compressed_bytes: 16 * 1024 * 1024,
};

fn p6(header: &str, payload: &[u8]) -> Vec<u8> {
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend_from_slice(payload);
    bytes
}

#[test]
fn decodes_rgb_payload_and_derives_luma_gray() {
    let decoded = decode_ppm(
        p6(
            "P6\n2 2\n255\n",
            &[
                255, 0, 0, 0, 255, 0, //
                0, 0, 255, 255, 255, 255,
            ],
        )
        .as_slice(),
        DECODE,
    )
    .unwrap();
    assert_eq!(decoded.rgb.get(0, 0), [255, 0, 0]);
    assert_eq!(decoded.rgb.get(1, 0), [0, 255, 0]);
    assert_eq!(decoded.rgb.get(0, 1), [0, 0, 255]);
    assert_eq!(decoded.rgb.get(1, 1), [255, 255, 255]);
    // Same 77/150/29 luma weights as the PNG decode path.
    assert_eq!(decoded.gray.get(0, 0), ((255u32 * 77 + 128) >> 8) as u8);
    assert_eq!(decoded.gray.get(1, 0), ((255u32 * 150 + 128) >> 8) as u8);
    assert_eq!(decoded.gray.get(0, 1), ((255u32 * 29 + 128) >> 8) as u8);
    assert_eq!(decoded.gray.get(1, 1), 255);
}

#[test]
fn parses_headers_with_comments_and_mixed_whitespace() {
    let decoded = decode_ppm(
        p6(
            "P6 # pdftoppm-style comment\n# another\n 1\t1 # trailing\n255\n",
            &[10, 20, 30],
        )
        .as_slice(),
        DECODE,
    )
    .unwrap();
    assert_eq!(decoded.rgb.get(0, 0), [10, 20, 30]);
    assert_eq!(
        read_ppm_dimensions(p6("P6\n# c\n3 4\n255\n", &[]).as_slice(), DECODE).unwrap(),
        (3, 4)
    );
}

#[test]
fn scales_sub_255_max_values_to_full_range() {
    let decoded = decode_ppm(p6("P6\n1 1\n15\n", &[15, 0, 3]).as_slice(), DECODE).unwrap();
    assert_eq!(decoded.rgb.get(0, 0), [255, 0, 51]);
}

#[test]
fn rejects_dimension_and_pixel_guardrail_violations() {
    let tight = DecodeLimits {
        max_pixels: 4,
        max_dimension: 3,
        max_compressed_bytes: 1024,
    };
    for header in ["P6\n4 1\n255\n", "P6\n3 2\n255\n", "P6\n0 1\n255\n"] {
        let error = read_ppm_dimensions(p6(header, &[]).as_slice(), tight).unwrap_err();
        assert!(
            error.to_string().contains("guardrails"),
            "unexpected error for {header:?}: {error}"
        );
    }
}

#[test]
fn rejects_malformed_and_sixteen_bit_inputs() {
    // Wrong magic, non-numeric token, 16-bit max value, truncated header.
    assert!(decode_ppm(p6("P5\n1 1\n255\n", &[0, 0, 0]).as_slice(), DECODE).is_err());
    assert!(decode_ppm(p6("P6\n1 x\n255\n", &[0, 0, 0]).as_slice(), DECODE).is_err());
    assert!(decode_ppm(
        p6("P6\n1 1\n65535\n", &[0, 0, 0, 0, 0, 0]).as_slice(),
        DECODE
    )
    .is_err());
    assert!(decode_ppm(b"P6\n1 1".as_slice(), DECODE).is_err());
}

#[test]
fn rejects_truncated_and_padded_payloads() {
    let truncated = decode_ppm(p6("P6\n2 1\n255\n", &[1, 2, 3]).as_slice(), DECODE).unwrap_err();
    assert!(truncated.to_string().contains("Truncated PPM P6 payload"));
    let padded = decode_ppm(p6("P6\n1 1\n255\n", &[1, 2, 3, 4]).as_slice(), DECODE).unwrap_err();
    assert!(padded.to_string().contains("trailing bytes"));
}
