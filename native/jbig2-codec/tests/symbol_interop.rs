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
