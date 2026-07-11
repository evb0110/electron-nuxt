#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| evb_pdf_image_combine::fuzz_parse_tiff(data));
