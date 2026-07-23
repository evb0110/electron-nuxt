#![no_main]

use jbig2_codec::{decode_pdf_generic, encode_pdf_generic, Bilevel, DecodeLimits};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }
    let width = u16::from_be_bytes([data[0], data[1]]) as u32 % 1024 + 1;
    let height = u16::from_be_bytes([data[2], data[3]]) as u32 % 1024 + 1;
    let stride = width.div_ceil(8) as usize;
    let length = stride * height as usize;
    let mut rows = vec![0; length];
    for (target, source) in rows.iter_mut().zip(data[4..].iter().cycle()) {
        *target = *source;
    }
    if width % 8 != 0 {
        let keep = u8::MAX << (8 - width % 8);
        for row in rows.chunks_exact_mut(stride) {
            row[stride - 1] &= keep;
        }
    }
    let image = Bilevel {
        width,
        height,
        rows: &rows,
    };
    let Ok(encoded) = encode_pdf_generic(image) else {
        return;
    };
    let decoded = decode_pdf_generic(
        &encoded,
        DecodeLimits::new(u64::from(width) * u64::from(height)),
    )
    .expect("encoded stream must decode");
    assert_eq!(decoded.rows, rows);
});
