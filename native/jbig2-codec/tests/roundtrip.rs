use jbig2_codec::{
    decode_pdf_generic, encode_pdf_generic, encode_pdf_generic_verified, Bilevel, DecodeLimits,
    Jbig2Error,
};

fn assert_roundtrip(width: u32, height: u32, rows: &[u8]) {
    let image = Bilevel {
        width,
        height,
        rows,
    };
    let encoded = encode_pdf_generic_verified(image).expect("bitmap should roundtrip");
    let decoded =
        decode_pdf_generic(&encoded, DecodeLimits::default()).expect("stream should decode");
    assert_eq!((decoded.width, decoded.height), (width, height));
    assert_eq!(decoded.rows, rows);
}

fn make_bitmap(width: u32, height: u32, mut black: impl FnMut(u32, u32) -> bool) -> Vec<u8> {
    let stride = width.div_ceil(8) as usize;
    let mut rows = vec![0; stride * height as usize];
    for y in 0..height {
        for x in 0..width {
            if black(x, y) {
                rows[y as usize * stride + x as usize / 8] |= 1 << (7 - x % 8);
            }
        }
    }
    rows
}

#[test]
fn roundtrips_edge_geometries_and_uniform_pages() {
    for (width, height) in [
        (1, 1),
        (1, 97),
        (113, 1),
        (2, 3),
        (3, 2),
        (7, 19),
        (9, 17),
        (31, 33),
    ] {
        let white = make_bitmap(width, height, |_, _| false);
        assert_roundtrip(width, height, &white);
        let black = make_bitmap(width, height, |_, _| true);
        assert_roundtrip(width, height, &black);
    }
}

#[test]
fn roundtrips_text_like_structure_and_duplicate_lines() {
    let rows = make_bitmap(257, 193, |x, y| {
        let text_line = y % 24 >= 7 && y % 24 <= 17;
        let glyph_stroke = x % 19 == 2
            || x % 19 == 3
            || (y % 24 == 7 && x % 19 < 12)
            || (y % 24 == 12 && x % 19 < 9)
            || (y % 24 == 17 && x % 19 < 12);
        let rule = (y == 48 || y == 49) && x > 12 && x < 230;
        rule || (text_line && glyph_stroke)
    });
    assert_roundtrip(257, 193, &rows);

    let duplicated = make_bitmap(65, 128, |x, y| (x / 5 + y / 8) % 3 == 0);
    assert_roundtrip(65, 128, &duplicated);
}

#[test]
fn roundtrips_deterministic_random_densities() {
    let mut state = 0x4d59_5df4_d0f3_3173u64;
    for case in 0..48u32 {
        let width = 1 + (case * 37 % 193);
        let height = 1 + (case * 53 % 157);
        let threshold = match case % 6 {
            0 => u64::MAX / 100,
            1 => u64::MAX / 10,
            2 => u64::MAX / 3,
            3 => u64::MAX / 2,
            4 => u64::MAX / 4 * 3,
            _ => u64::MAX / 10 * 9,
        };
        let rows = make_bitmap(width, height, |_, _| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state < threshold
        });
        assert_roundtrip(width, height, &rows);
    }
}

#[test]
fn applies_decode_limits_before_allocating() {
    let rows = make_bitmap(64, 64, |x, y| (x + y) % 2 == 0);
    let encoded = encode_pdf_generic(Bilevel {
        width: 64,
        height: 64,
        rows: &rows,
    })
    .unwrap();
    assert_eq!(
        decode_pdf_generic(&encoded, DecodeLimits::new(4095)),
        Err(Jbig2Error::PixelLimitExceeded {
            pixels: 4096,
            maximum: 4095,
        })
    );
}

#[test]
fn malformed_inputs_return_errors() {
    for input in [
        &[][..],
        &[0][..],
        &[0, 0, 0, 0, 48, 0][..],
        &[0, 0, 0, 0, 48, 0, 1, 0, 0, 0, 19][..],
        &[0, 0, 0, 0, 48, 0xe0, 1, 0, 0, 0, 0][..],
    ] {
        assert!(decode_pdf_generic(input, DecodeLimits::default()).is_err());
    }
}
