use jbig2_codec::{decode_pdf_generic_source, DecodeLimits};
use std::{env, fs, process};

fn main() {
    let Some(path) = env::args_os().nth(1) else {
        eprintln!("usage: decode_pdf_generic <path>");
        process::exit(2);
    };
    let data = fs::read(&path).unwrap_or_else(|error| {
        eprintln!("failed to read {:?}: {error}", path);
        process::exit(2);
    });
    match decode_pdf_generic_source(&data, DecodeLimits::new(160_000_000)) {
        Ok(bitmap) => {
            println!(
                "decoded width={} height={} bytes={}",
                bitmap.width,
                bitmap.height,
                bitmap.rows.len()
            );
            if let Some(output_path) = env::args_os().nth(2) {
                let mut pbm = format!("P4\n{} {}\n", bitmap.width, bitmap.height).into_bytes();
                pbm.extend_from_slice(&bitmap.rows);
                fs::write(&output_path, pbm).unwrap_or_else(|error| {
                    eprintln!("failed to write {:?}: {error}", output_path);
                    process::exit(2);
                });
            }
        }
        Err(error) => {
            eprintln!("decode failed: {error}");
            process::exit(1);
        }
    }
}
