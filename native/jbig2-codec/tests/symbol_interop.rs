use std::{fs, process::Command};

use jbig2_codec::{
    decode_pdf_symbol_page, encode_pdf_generic_verified, encode_pdf_symbol_pages_verified,
    verify_strict_bitmap, Bilevel, DecodeLimits, StrictBitmapPolicy, SymbolEncodeLimits,
};

#[test]
fn jbig2dec_decodes_symbol_dictionary_and_text_region() {
    if Command::new("jbig2dec").arg("--version").output().is_err() {
        eprintln!("jbig2dec is unavailable; skipping external interoperability check");
        return;
    }

    let fixture = include_bytes!("fixtures/scan-page-007-notes.pbm");
    let (width, height, rows) = parse_p4(fixture);
    let source = Bilevel {
        width,
        height,
        rows,
    };
    let encoded =
        encode_pdf_symbol_pages_verified(&[source, source], SymbolEncodeLimits::default()).unwrap();
    assert!(
        encoded.fallback_pages.is_empty(),
        "unexpected symbol fallbacks: {:?}",
        encoded.fallback_pages
    );
    let generic = encode_pdf_generic_verified(source).unwrap();
    assert!(
        encoded.globals.len()
            + encoded
                .pages
                .iter()
                .map(|page| page.as_ref().unwrap().data.len())
                .sum::<usize>()
            < generic.len() * 2,
        "a shared symbol dictionary must pay for itself on repeated text masks"
    );

    let directory =
        std::env::temp_dir().join(format!("evb-jbig2-symbol-interop-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let globals = directory.join("globals.jb2");
    let page = directory.join("page.jb2");
    let decoded = directory.join("decoded.pbm");
    fs::write(&globals, &encoded.globals).unwrap();
    let first_page = encoded.pages[0].as_ref().unwrap();
    fs::write(&page, &first_page.data).unwrap();

    let output = Command::new("jbig2dec")
        .args(["--embedded", "--format", "pbm", "--output"])
        .arg(&decoded)
        .arg(&globals)
        .arg(&page)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "jbig2dec failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let decoded = fs::read(&decoded).unwrap();
    let (decoded_width, decoded_height, decoded_rows) = parse_p4(&decoded);
    assert_eq!((decoded_width, decoded_height), (width, height));
    let in_house =
        decode_pdf_symbol_page(&encoded.globals, &first_page.data, DecodeLimits::default())
            .unwrap();
    assert_eq!(decoded_rows, in_house.rows);
    verify_strict_bitmap(
        source,
        Bilevel {
            width,
            height,
            rows: decoded_rows,
        },
        StrictBitmapPolicy::default(),
    )
    .unwrap();

    // Sparse differences share one conservative class, but T.88 refinement
    // still reconstructs every pixel through the external decoder.
    let correction_width = 24u32;
    let correction_height = 24u32;
    let correction_stride = correction_width.div_ceil(8) as usize;
    let mut clean = vec![0u8; correction_stride * correction_height as usize];
    for y in 2..22usize {
        for x in 2..22usize {
            clean[y * correction_stride + x / 8] |= 0x80 >> (x & 7);
        }
    }
    let mut sparse = clean.clone();
    for (x, y) in [(6usize, 6usize), (17, 17)] {
        sparse[y * correction_stride + x / 8] &= !(0x80 >> (x & 7));
    }
    let corrected = encode_pdf_symbol_pages_verified(
        &[
            Bilevel {
                width: correction_width,
                height: correction_height,
                rows: &clean,
            },
            Bilevel {
                width: correction_width,
                height: correction_height,
                rows: &sparse,
            },
        ],
        SymbolEncodeLimits::default(),
    )
    .unwrap();
    assert_eq!(corrected.symbol_count, 1);
    let corrected_globals = directory.join("corrected-globals.jb2");
    let corrected_page = directory.join("corrected-page.jb2");
    let corrected_pbm = directory.join("corrected.pbm");
    fs::write(&corrected_globals, &corrected.globals).unwrap();
    fs::write(&corrected_page, &corrected.pages[1].as_ref().unwrap().data).unwrap();
    let output = Command::new("jbig2dec")
        .args(["--embedded", "--format", "pbm", "--output"])
        .arg(&corrected_pbm)
        .arg(&corrected_globals)
        .arg(&corrected_page)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "jbig2dec failed on refined symbols: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let corrected_pbm = fs::read(&corrected_pbm).unwrap();
    let (decoded_width, decoded_height, decoded_rows) = parse_p4(&corrected_pbm);
    assert_eq!(
        (decoded_width, decoded_height, decoded_rows),
        (correction_width, correction_height, sparse.as_slice())
    );

    fs::remove_dir_all(&directory).unwrap();
}

fn sample_symbol_document() -> jbig2_codec::SymbolDocument {
    let width = 24u32;
    let height = 24u32;
    let stride = width.div_ceil(8) as usize;
    let mut rows = vec![0u8; stride * height as usize];
    for y in 2..22usize {
        for x in 2..22usize {
            rows[y * stride + x / 8] |= 0x80 >> (x & 7);
        }
    }
    let page = Bilevel {
        width,
        height,
        rows: &rows,
    };
    let document =
        encode_pdf_symbol_pages_verified(&[page, page], SymbolEncodeLimits::default()).unwrap();
    assert_eq!(document.symbol_count, 1);
    document
}

#[test]
fn rejects_symbol_dictionary_claiming_an_absurd_exported_count() {
    let document = sample_symbol_document();
    let mut globals = document.globals.clone();
    // The dictionary segment header is 11 bytes (no referred segments, short
    // page association), so the exported and new counts sit at dictionary
    // offsets 10 and 14.
    const EXPORTED_OFFSET: usize = 11 + 10;
    const NEW_OFFSET: usize = 11 + 14;
    assert_eq!(
        u32::from_be_bytes(globals[NEW_OFFSET..NEW_OFFSET + 4].try_into().unwrap()),
        document.symbol_count as u32,
        "unexpected symbol-dictionary layout"
    );
    globals[EXPORTED_OFFSET..EXPORTED_OFFSET + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    globals[NEW_OFFSET..NEW_OFFSET + 4].copy_from_slice(&u32::MAX.to_be_bytes());

    let page = document.pages[0].as_ref().unwrap();
    let error = decode_pdf_symbol_page(&globals, &page.data, DecodeLimits::default()).unwrap_err();
    assert!(
        matches!(error, jbig2_codec::Jbig2Error::Unsupported(_)),
        "unexpected error: {error:?}"
    );
}

#[test]
fn rejects_symbol_bitmaps_larger_than_the_dimension_limit() {
    let document = sample_symbol_document();
    let page = document.pages[0].as_ref().unwrap();
    // The exemplar glyph is ~20 px per side; a 4 px dimension ceiling must be
    // enforced before its bitmap is allocated.
    let error = decode_pdf_symbol_page(
        &document.globals,
        &page.data,
        DecodeLimits::new(u64::MAX).with_max_dimension(4),
    )
    .unwrap_err();
    assert!(
        matches!(error, jbig2_codec::Jbig2Error::InvalidDimensions { .. }),
        "unexpected error: {error:?}"
    );
}

fn two_symbol_document() -> jbig2_codec::SymbolDocument {
    let width = 24u32;
    let height = 24u32;
    let stride = width.div_ceil(8) as usize;
    let mut solid = vec![0u8; stride * height as usize];
    for y in 2..22usize {
        for x in 2..22usize {
            solid[y * stride + x / 8] |= 0x80 >> (x & 7);
        }
    }
    let mut inset = vec![0u8; stride * height as usize];
    for y in 6..18usize {
        for x in 6..18usize {
            inset[y * stride + x / 8] |= 0x80 >> (x & 7);
        }
    }
    let solid_page = Bilevel {
        width,
        height,
        rows: &solid,
    };
    let inset_page = Bilevel {
        width,
        height,
        rows: &inset,
    };
    // Each distinct glyph appears twice so the shared dictionary is worthwhile
    // and both survive as exported symbols rather than falling back to generic.
    let document = encode_pdf_symbol_pages_verified(
        &[solid_page, inset_page, solid_page, inset_page],
        SymbolEncodeLimits::default(),
    )
    .unwrap();
    assert!(
        document.fallback_pages.is_empty(),
        "unexpected symbol fallbacks: {:?}",
        document.fallback_pages
    );
    assert_eq!(document.symbol_count, 2);
    document
}

#[test]
fn rejects_symbol_page_dimensions_above_the_limit() {
    let document = sample_symbol_document();
    let page = document.pages[0].as_ref().unwrap();
    // The page bitmap is 24x24 while its lone glyph symbol is ~20 px per side, so
    // a 23 px ceiling clears every symbol yet must still reject the page bitmap
    // before it is allocated.
    let error = decode_pdf_symbol_page(
        &document.globals,
        &page.data,
        DecodeLimits::new(u64::MAX).with_max_dimension(23),
    )
    .unwrap_err();
    assert!(
        matches!(
            error,
            jbig2_codec::Jbig2Error::InvalidDimensions {
                width: 24,
                height: 24
            }
        ),
        "unexpected error: {error:?}"
    );
}

#[test]
fn rejects_symbol_dictionary_whose_cumulative_pixels_exceed_the_budget() {
    let document = two_symbol_document();
    let page = document.pages[0].as_ref().unwrap();
    // Each symbol (20x20 and 12x12) fits under a 500-pixel budget on its own; a
    // per-symbol check would admit them both. Their combined area must not, so a
    // rejection here proves the budget accumulates across the whole dictionary.
    let error = decode_pdf_symbol_page(
        &document.globals,
        &page.data,
        DecodeLimits::new(500).with_max_dimension(100),
    )
    .unwrap_err();
    assert!(
        matches!(
            error,
            jbig2_codec::Jbig2Error::PixelLimitExceeded { maximum: 500, .. }
        ),
        "unexpected error: {error:?}"
    );
}

fn parse_p4(data: &[u8]) -> (u32, u32, &[u8]) {
    assert_eq!(&data[..2], b"P4");
    let mut position = 2usize;
    let width = number(data, &mut position);
    let height = number(data, &mut position);
    assert!(data[position].is_ascii_whitespace());
    if data[position] == b'\r' && data.get(position + 1) == Some(&b'\n') {
        position += 2;
    } else {
        position += 1;
    }
    let length = width.div_ceil(8) as usize * height as usize;
    (width, height, &data[position..position + length])
}

fn number(data: &[u8], position: &mut usize) -> u32 {
    while data[*position].is_ascii_whitespace() {
        *position += 1;
    }
    let start = *position;
    while data[*position].is_ascii_digit() {
        *position += 1;
    }
    std::str::from_utf8(&data[start..*position])
        .unwrap()
        .parse()
        .unwrap()
}
