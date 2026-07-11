#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| evb_pdf_page_ops::fuzz_parse_incremental_xref_table(data));
