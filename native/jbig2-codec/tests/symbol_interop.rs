use std::{
    fs,
    panic::{catch_unwind, AssertUnwindSafe},
    process::Command,
};

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

#[derive(Clone, Copy)]
struct SegmentBounds {
    length_offset: usize,
    data_start: usize,
    data_end: usize,
}

fn segment_bounds(stream: &[u8], start: usize) -> SegmentBounds {
    let number = u32::from_be_bytes(stream[start..start + 4].try_into().unwrap());
    let referred_count = usize::from(stream[start + 5] >> 5);
    let reference_size = if number <= 256 {
        1
    } else if number <= 65_536 {
        2
    } else {
        4
    };
    let length_offset = start + 6 + referred_count * reference_size + 1;
    let data_start = length_offset + 4;
    let length = u32::from_be_bytes(stream[length_offset..data_start].try_into().unwrap()) as usize;
    SegmentBounds {
        length_offset,
        data_start,
        data_end: data_start + length,
    }
}

fn assert_symbol_decode_error(label: &str, globals: &[u8], page: &[u8]) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        decode_pdf_symbol_page(globals, page, DecodeLimits::default())
    }));
    let result = outcome.unwrap_or_else(|_| panic!("{label} panicked"));
    assert!(result.is_err(), "{label} decoded successfully");
}

fn terminated_prefix(stream: &[u8], segment: SegmentBounds, end: usize) -> Vec<u8> {
    let mut truncated = stream[..end].to_vec();
    truncated.extend_from_slice(&[0xff, 0xac]);
    let repaired_length = u32::try_from(truncated.len() - segment.data_start).unwrap();
    truncated[segment.length_offset..segment.data_start]
        .copy_from_slice(&repaired_length.to_be_bytes());
    truncated
}

#[test]
fn rejects_every_premature_symbol_global_end_without_panicking() {
    let document = two_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    for end in 0..document.globals.len() {
        assert_symbol_decode_error(
            &format!("symbol globals truncated at {end}"),
            &document.globals[..end],
            page,
        );
    }
}

#[test]
fn rejects_every_terminated_symbol_global_arithmetic_prefix_without_panicking() {
    let document = two_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    let dictionary = segment_bounds(&document.globals, 0);
    assert_eq!(dictionary.data_end, document.globals.len());
    const SYMBOL_DICTIONARY_HEADER_LENGTH: usize = 18;
    let arithmetic_start = dictionary.data_start + SYMBOL_DICTIONARY_HEADER_LENGTH;
    for end in arithmetic_start..dictionary.data_end - 2 {
        let truncated = terminated_prefix(&document.globals, dictionary, end);
        assert_symbol_decode_error(
            &format!("symbol globals terminated at {end}"),
            &truncated,
            page,
        );
    }
}

#[test]
fn rejects_every_premature_symbol_page_end_without_panicking() {
    let document = two_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    for end in 0..page.len() {
        assert_symbol_decode_error(
            &format!("symbol page truncated at {end}"),
            &document.globals,
            &page[..end],
        );
    }
}

#[test]
fn rejects_every_terminated_symbol_page_arithmetic_prefix_without_panicking() {
    let document = two_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    let page_information = segment_bounds(page, 0);
    let text_region = segment_bounds(page, page_information.data_end);
    assert_eq!(text_region.data_end, page.len());
    const TEXT_REGION_HEADER_LENGTH: usize = 23;
    let arithmetic_start = text_region.data_start + TEXT_REGION_HEADER_LENGTH;
    for end in arithmetic_start..text_region.data_end - 2 {
        let truncated = terminated_prefix(page, text_region, end);
        assert_symbol_decode_error(
            &format!("symbol page terminated at {end}"),
            &document.globals,
            &truncated,
        );
    }
}

/// Six copies of one 8x8 glyph stepped down a 128x128 page, each on its own
/// strip. Every placement therefore costs real arithmetic bytes for its own
/// coordinates instead of collapsing into one compressible run, so the text
/// region carries a payload long enough to truncate meaningfully while the
/// page stays small enough for byte-level assertions.
fn lattice_symbol_document() -> (jbig2_codec::SymbolDocument, Vec<u8>) {
    const SIZE: u32 = 128;
    let stride = SIZE.div_ceil(8) as usize;
    let mut rows = vec![0u8; stride * SIZE as usize];
    for index in 0..6u32 {
        let left = 4 + (index % 3) * 12;
        let top = 4 + index * 12;
        for y in top..top + 8 {
            for x in left..left + 8 {
                rows[y as usize * stride + (x as usize) / 8] |= 0x80 >> (x & 7);
            }
        }
    }
    let page = Bilevel {
        width: SIZE,
        height: SIZE,
        rows: &rows,
    };
    let document =
        encode_pdf_symbol_pages_verified(&[page, page], SymbolEncodeLimits::default()).unwrap();
    assert!(
        document.fallback_pages.is_empty(),
        "unexpected symbol fallbacks: {:?}",
        document.fallback_pages
    );
    assert_eq!(document.symbol_count, 1);
    (document, rows)
}

/// The same lattice with a single pixel punched out of every second glyph, so
/// the encoder classes them together and refinement-codes the odd ones. That
/// puts a refinement bitmap decode between a placement's first decision and
/// the placement itself, which is the window the pre-placement budget has to
/// cover.
fn refined_lattice_symbol_document() -> (jbig2_codec::SymbolDocument, Vec<u8>) {
    const SIZE: u32 = 128;
    let stride = SIZE.div_ceil(8) as usize;
    let mut rows = vec![0u8; stride * SIZE as usize];
    for index in 0..7u32 {
        let top = 4 + index * 12;
        for y in top..top + 10 {
            for x in 4..14u32 {
                rows[y as usize * stride + (x as usize) / 8] |= 0x80 >> (x & 7);
            }
        }
        if index % 2 == 1 {
            let hole_y = top + 1 + index;
            rows[hole_y as usize * stride] &= !(0x80 >> 5);
        }
    }
    let page = Bilevel {
        width: SIZE,
        height: SIZE,
        rows: &rows,
    };
    let document =
        encode_pdf_symbol_pages_verified(&[page, page], SymbolEncodeLimits::default()).unwrap();
    assert!(
        document.fallback_pages.is_empty(),
        "unexpected symbol fallbacks: {:?}",
        document.fallback_pages
    );
    assert_eq!(document.symbol_count, 1);
    (document, rows)
}

/// Locates the text-region segment of a symbol page, its declared instance
/// count, and the first byte of its arithmetic payload.
fn text_region_bounds(page: &[u8], refined: bool) -> (SegmentBounds, usize, usize) {
    const TEXT_REGION_HEADER_LENGTH: usize = 23;
    const REFINED_TEXT_REGION_HEADER_LENGTH: usize = 27;
    let bounds = segment_bounds(page, segment_bounds(page, 0).data_end);
    assert_eq!(bounds.data_end, page.len());
    let (flags, header_length) = if refined {
        ([0, 2], REFINED_TEXT_REGION_HEADER_LENGTH)
    } else {
        ([0, 0], TEXT_REGION_HEADER_LENGTH)
    };
    assert_eq!(
        page[bounds.data_start + 17..bounds.data_start + 19],
        flags,
        "fixture does not use the expected text-region layout"
    );
    (
        bounds,
        bounds.data_start + header_length - 4,
        bounds.data_start + header_length,
    )
}

#[test]
fn rejects_a_symbol_page_whose_trailing_text_region_arithmetic_bytes_are_truncated() {
    let (document, rows) = lattice_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    let (text_region, instances, arithmetic_start) = text_region_bounds(page, false);
    assert_eq!(
        u32::from_be_bytes(page[instances..instances + 4].try_into().unwrap()),
        6,
        "unexpected declared instance count"
    );
    assert_eq!(
        text_region.data_end - 2 - arithmetic_start,
        10,
        "unexpected arithmetic payload length"
    );

    // Keep four of the ten arithmetic payload bytes and re-terminate the
    // stream. The surviving prefix cannot encode six placements, so every
    // placement past the prefix comes from the decoder's synthesized padding.
    // Without a flush budget on the text-region loop this decodes to Ok with
    // pixels that are not the encoded page.
    let truncated = terminated_prefix(page, text_region, arithmetic_start + 4);
    assert_eq!(
        decode_pdf_symbol_page(&document.globals, &truncated, DecodeLimits::default()),
        Err(jbig2_codec::Jbig2Error::Truncated)
    );

    // The intact page still decodes to the exact source pixels.
    let decoded = decode_pdf_symbol_page(&document.globals, page, DecodeLimits::default()).unwrap();
    assert_eq!(decoded.rows, rows);
}

#[test]
fn rejects_a_symbol_page_declaring_more_instances_than_its_arithmetic_payload_encodes() {
    let (document, rows) = lattice_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    let (_, instances, _) = text_region_bounds(page, false);

    // Raise only the declared instance count. The arithmetic payload is
    // untouched and still ends at its real terminating marker, so the two
    // extra placements can only come from synthesized padding.
    let mut inflated = page.clone();
    inflated[instances..instances + 4].copy_from_slice(&8u32.to_be_bytes());
    assert_eq!(
        decode_pdf_symbol_page(&document.globals, &inflated, DecodeLimits::default()),
        Err(jbig2_codec::Jbig2Error::Truncated)
    );

    let decoded = decode_pdf_symbol_page(&document.globals, page, DecodeLimits::default()).unwrap();
    assert_eq!(decoded.rows, rows);
}

/// Pins both halves of the pre-placement budget: where it is taken, and how
/// much it allows.
///
/// One extra declared placement on this refined page is reached with exactly
/// three synthesized bits drawn -- the whole allowance, which a well-formed
/// region only ever spends on the drain that follows its last real placement.
/// Widening the bound to `>` accepts it, and so does taking the check at the
/// top of the placement loop instead, because the symbol id and refinement
/// bitmap decoded in between are what push the draw from under budget to
/// exactly on it. Either way the page decodes to `Ok` carrying a glyph its
/// payload never encoded.
#[test]
fn rejects_an_extra_declared_placement_that_lands_exactly_on_the_termination_allowance() {
    let (document, rows) = refined_lattice_symbol_document();
    let page = &document.pages[0].as_ref().unwrap().data;
    let (text_region, instances, arithmetic_start) = text_region_bounds(page, true);
    assert_eq!(
        u32::from_be_bytes(page[instances..instances + 4].try_into().unwrap()),
        7,
        "unexpected declared instance count"
    );
    assert_eq!(
        text_region.data_end - 2 - arithmetic_start,
        21,
        "unexpected arithmetic payload length"
    );

    // Declare one placement more than the untouched payload encodes.
    let mut inflated = page.clone();
    inflated[instances..instances + 4].copy_from_slice(&8u32.to_be_bytes());
    assert_eq!(
        inflated[..instances],
        page[..instances],
        "only the declared instance count may differ"
    );
    assert_eq!(
        inflated[instances + 4..],
        page[instances + 4..],
        "only the declared instance count may differ"
    );
    assert_eq!(
        decode_pdf_symbol_page(&document.globals, &inflated, DecodeLimits::default()),
        Err(jbig2_codec::Jbig2Error::Truncated)
    );

    // The same payload, honestly declared, still decodes to the source pixels,
    // so the bound rejects the fabricated placement and not the flush itself.
    let decoded = decode_pdf_symbol_page(&document.globals, page, DecodeLimits::default()).unwrap();
    assert_eq!(decoded.rows, rows);
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
