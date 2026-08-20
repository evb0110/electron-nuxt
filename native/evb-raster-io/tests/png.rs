use evb_raster_io::{
    decode_png, encode_png, encode_png_fast, read_png_dimensions, read_png_passthrough,
    DecodeLimits, PassthroughLimits, PixelBuffer, PngColorType, RasterError,
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
const PASSTHROUGH: PassthroughLimits = PassthroughLimits {
    max_pixels: 1_000_000,
    max_icc_profile_bytes: 1024 * 1024,
};
const DECODE: DecodeLimits = DecodeLimits {
    max_pixels: 1_000_000,
    max_dimension: 1_000,
    max_compressed_bytes: 1024 * 1024,
};
const RGB: &[u8] = &[
    10, 20, 30, 40, 50, 60, 70, 80, 90, 15, 25, 35, 45, 55, 65, 75, 85, 95,
];

#[test]
fn passthrough_preserves_compressed_data_and_metadata_without_decoding() {
    let multi = fixture("multi-idat.png");
    let png = read_png_passthrough(multi.as_slice(), PASSTHROUGH).unwrap();
    assert_eq!(
        (png.width, png.height, png.color_type),
        (3, 2, PngColorType::Rgb8)
    );
    assert_eq!(png.idat, source_idat(&multi));
    assert_eq!(
        read_png_passthrough(fixture("phys.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .dpi,
        Some(300)
    );
    assert_eq!(
        read_png_passthrough(fixture("iccp.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .icc_profile
            .unwrap(),
        fixture("iccp-profile.bin")
    );

    let corrupt = fixture("corrupt-crc.png");
    assert!(read_png_passthrough(corrupt.as_slice(), PASSTHROUGH).is_err());
    assert!(decode_png(corrupt.as_slice(), DECODE).is_err());
    assert!(read_png_passthrough(fixture("rgba8.png").as_slice(), PASSTHROUGH).is_err());
}

#[test]
fn passthrough_rejects_bad_crc_on_every_trusted_chunk_kind() {
    for (fixture_name, chunk_kind) in [
        ("rgb8.png", *b"IHDR"),
        ("multi-idat.png", *b"IDAT"),
        ("phys.png", *b"pHYs"),
        ("rgb8.png", *b"IEND"),
    ] {
        let corrupt = corrupt_chunk_crc(fixture(fixture_name), chunk_kind);
        let error = read_png_passthrough(corrupt.as_slice(), PASSTHROUGH).unwrap_err();
        assert!(
            error.to_string().contains("CRC mismatch"),
            "{fixture_name} {}: {error}",
            String::from_utf8_lossy(&chunk_kind)
        );
    }
}

#[test]
fn decode_matches_scan_cleanup_luma_alpha_and_filter_behavior() {
    let gray = decode_png(fixture("gray8.png").as_slice(), DECODE).unwrap();
    assert_eq!(gray.gray.data(), &[0, 30, 255, 80, 120, 200]);
    assert_eq!(
        gray.rgb.data(),
        &[0, 0, 0, 30, 30, 30, 255, 255, 255, 80, 80, 80, 120, 120, 120, 200, 200, 200]
    );
    let rgb = decode_png(fixture("rgb8.png").as_slice(), DECODE).unwrap();
    assert_eq!(rgb.gray.data(), &[18, 48, 78, 23, 53, 83]);
    assert_eq!(rgb.rgb.data(), RGB);
    let gray_alpha = decode_png(fixture("gray-alpha8.png").as_slice(), DECODE).unwrap();
    assert_eq!(gray_alpha.gray.data(), &[12, 200, 64, 128]);
    assert_eq!(
        gray_alpha.rgb.data(),
        &[12, 12, 12, 200, 200, 200, 64, 64, 64, 128, 128, 128]
    );
    let rgba = decode_png(fixture("rgba8.png").as_slice(), DECODE).unwrap();
    assert_eq!(rgba.gray.data(), &[68, 48, 78, 117]);
    assert_eq!(
        rgba.rgb.data(),
        &[200, 10, 20, 40, 50, 60, 70, 80, 90, 128, 110, 120]
    );
    for filter in 0..=4 {
        let decoded =
            decode_png(fixture(&format!("filter-{filter}.png")).as_slice(), DECODE).unwrap();
        assert_eq!(decoded.rgb.data(), RGB, "filter {filter}");
        assert_eq!(decoded.gray.data(), &[18, 48, 78, 23, 53, 83]);
    }
}

#[test]
fn encoder_is_deterministic_and_round_trips() {
    let gray = [0, 30, 255, 80, 120, 200];
    let gray_pixels = PixelBuffer::Gray {
        width: 3,
        height: 2,
        stride: 3,
        data: &gray,
    };
    assert_eq!(encode_png(gray_pixels).unwrap(), fixture("gray8.png"));
    let encoded = encode_png(PixelBuffer::Rgb {
        width: 3,
        height: 2,
        stride: 9,
        data: RGB,
    })
    .unwrap();
    assert_eq!(encoded, fixture("rgb8.png"));
    assert_eq!(
        decode_png(encoded.as_slice(), DECODE).unwrap().rgb.data(),
        RGB
    );
}

#[test]
fn fast_encoder_is_lossless_for_managed_intermediates() {
    for pixels in [
        PixelBuffer::Gray {
            width: 6,
            height: 1,
            stride: 6,
            data: &[0, 30, 255, 80, 120, 200],
        },
        PixelBuffer::Rgb {
            width: 3,
            height: 2,
            stride: 9,
            data: RGB,
        },
    ] {
        let expected = match pixels {
            PixelBuffer::Gray { data, .. } => data
                .iter()
                .flat_map(|value| [*value; 3])
                .collect::<Vec<_>>(),
            PixelBuffer::Rgb { data, .. } => data.to_vec(),
        };
        let encoded = encode_png_fast(pixels).unwrap();
        assert_eq!(
            decode_png(encoded.as_slice(), DECODE).unwrap().rgb.data(),
            expected
        );
    }
}

#[test]
fn admission_precedes_allocation_and_inflate() {
    let oversized = fixture("oversized-dimensions.png");
    let error = decode_png(oversized.as_slice(), DECODE).unwrap_err();
    assert!(matches!(
        error,
        RasterError::TooLarge(message) if message.contains("100000x100000")
    ));
    assert_eq!(
        read_png_dimensions(fixture("rgba8.png").as_slice(), DECODE).unwrap(),
        (2, 2)
    );
    assert!(read_png_dimensions(fixture("corrupt-crc.png").as_slice(), DECODE).is_err());

    let compressed_error = decode_png(
        fixture("rgb8.png").as_slice(),
        DecodeLimits {
            max_compressed_bytes: 1,
            ..DECODE
        },
    )
    .unwrap_err();
    assert!(compressed_error
        .to_string()
        .contains("compressed image data exceeds"));
    assert!(
        read_png_passthrough(fixture("high-compression.png").as_slice(), PASSTHROUGH)
            .unwrap_err()
            .to_string()
            .contains("longer than expected")
    );
}

#[test]
fn rejects_truncation_and_short_or_long_inflated_payloads() {
    for name in [
        "truncated-chunk.png",
        "missing-iend.png",
        "short-idat.png",
        "long-idat.png",
    ] {
        let bytes = fixture(name);
        assert!(
            read_png_passthrough(bytes.as_slice(), PASSTHROUGH).is_err(),
            "{name}"
        );
        assert!(decode_png(bytes.as_slice(), DECODE).is_err(), "{name}");
    }
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

fn source_idat(bytes: &[u8]) -> Vec<u8> {
    let mut offset = 8;
    let mut idat = Vec::new();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let data = offset + 8..offset + 8 + length;
        if &bytes[offset + 4..offset + 8] == b"IDAT" {
            idat.extend_from_slice(&bytes[data.clone()]);
        }
        offset = data.end + 4;
    }
    idat
}

fn corrupt_chunk_crc(mut bytes: Vec<u8>, target: [u8; 4]) -> Vec<u8> {
    let mut offset = 8;
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let crc_offset = offset + 8 + length;
        if bytes[offset + 4..offset + 8] == target {
            bytes[crc_offset] ^= 0x01;
            return bytes;
        }
        offset = crc_offset + 4;
    }
    panic!(
        "fixture did not contain chunk {}",
        String::from_utf8_lossy(&target)
    );
}
