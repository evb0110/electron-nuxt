#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| jbig2_codec::fuzz_decode(data));
