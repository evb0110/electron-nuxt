use evb_raster_io::{decode_p4, encode_p4, encode_p4_bilevel, RasterError};
use scan_primitives::{BinaryImage, GrayImage};

fn widen(binary: &BinaryImage) -> GrayImage {
    let mut gray = GrayImage::new(binary.width(), binary.height(), 255);
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if binary.get(x, y) {
                gray.set(x, y, 0);
            }
        }
    }
    gray
}

fn stencil(width: usize, height: usize) -> BinaryImage {
    let mut binary = BinaryImage::new(width, height);
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            if state % 5 == 0 {
                binary.set(x, y, true);
            }
        }
    }
    binary
}

#[test]
fn packed_encoding_is_byte_identical_to_widening_then_repacking() {
    // Widths straddle the byte and word boundaries the two layouts pad to:
    // PBM P4 pads each row to a byte, BinaryImage pads it to a 32-bit word.
    for width in [1, 7, 8, 9, 31, 32, 33, 63, 64, 65, 129] {
        for height in [1, 3, 17] {
            let binary = stencil(width, height);
            assert_eq!(
                encode_p4_bilevel(&binary).unwrap(),
                encode_p4(&widen(&binary)).unwrap(),
                "packed and widened encodings diverged at {width}x{height}"
            );
        }
    }
}

#[test]
fn packed_encoding_round_trips_through_the_decoder() {
    let binary = stencil(37, 11);
    let decoded = decode_p4(&encode_p4_bilevel(&binary).unwrap(), 1_000_000, 10_000).unwrap();
    assert_eq!(decoded, widen(&binary));
}

#[test]
fn packed_encoding_rejects_empty_dimensions() {
    assert!(encode_p4_bilevel(&BinaryImage::new(0, 4)).is_err());
    assert!(encode_p4_bilevel(&BinaryImage::new(4, 0)).is_err());
}

#[test]
fn decoder_reports_guardrail_violations_as_typed_oversize_errors() {
    let error = decode_p4(b"P4\n4 4\n", 8, 16).unwrap_err();
    assert!(matches!(
        error,
        RasterError::TooLarge(message) if message.contains("PBM P4 dimensions exceed guardrails")
    ));
}
