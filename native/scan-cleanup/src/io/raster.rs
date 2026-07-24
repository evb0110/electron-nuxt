//! Format-sniffing readers for cleanup raster inputs: PNG for browser-visible
//! surfaces and raw PPM P6 for pipeline-internal Poppler handoffs.
use super::decode_limits;
use evb_raster_io::{decode_png, decode_ppm, read_png_dimensions, read_ppm_dimensions};
use scan_primitives::GrayImage;
use std::{
    fs::File,
    io::{Cursor, ErrorKind, Read},
    path::Path,
};

pub use evb_raster_io::DecodedRaster;

pub fn read_gray(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    Ok(read_image(path, max_pixels, max_dimension)?.gray)
}

pub fn read_image(
    path: &Path,
    max_pixels: u64,
    max_dimension: u32,
) -> Result<DecodedRaster, String> {
    let (file, is_ppm) = open_sniffed(path)?;
    let limits = decode_limits(max_pixels, max_dimension);
    if is_ppm {
        decode_ppm(file, limits)
    } else {
        decode_png(file, limits)
    }
    .map_err(|error| error.to_string())
}

pub fn read_dimensions(
    path: &Path,
    max_pixels: u64,
    max_dimension: u32,
) -> Result<(usize, usize), String> {
    let (file, is_ppm) = open_sniffed(path)?;
    let limits = decode_limits(max_pixels, max_dimension);
    if is_ppm {
        read_ppm_dimensions(file, limits)
    } else {
        read_png_dimensions(file, limits)
    }
    .map_err(|error| error.to_string())
}

// Inputs may be FIFOs (streamed pages), so the consumed magic bytes are
// chained back in front of the stream instead of seeking.
fn open_sniffed(path: &Path) -> Result<(impl Read, bool), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut magic = [0u8; 2];
    let mut filled = 0;
    while filled < magic.len() {
        match file.read(&mut magic[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let is_ppm = &magic[..filled] == b"P6";
    Ok((Cursor::new(magic).take(filled as u64).chain(file), is_ppm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::png::encode_gray;
    use std::fs;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("evb-raster-sniff-{}-{name}", std::process::id()))
    }

    #[test]
    fn dispatches_png_and_ppm_by_signature() {
        let mut gray = GrayImage::new(2, 1, 255);
        gray.set(0, 0, 0);
        let png_path = temp_path("input.png");
        fs::write(&png_path, encode_gray(&gray).unwrap()).unwrap();
        let ppm_path = temp_path("input.ppm");
        fs::write(&ppm_path, b"P6\n2 1\n255\n\x00\x00\x00\xff\xff\xff").unwrap();

        assert_eq!(read_dimensions(&png_path, 16, 16).unwrap(), (2, 1));
        assert_eq!(read_dimensions(&ppm_path, 16, 16).unwrap(), (2, 1));
        assert_eq!(read_gray(&png_path, 16, 16).unwrap().get(0, 0), 0);
        let decoded = read_image(&ppm_path, 16, 16).unwrap();
        assert_eq!(decoded.rgb.get(0, 0), [0, 0, 0]);
        assert_eq!(decoded.rgb.get(1, 0), [255, 255, 255]);

        fs::remove_file(&png_path).unwrap();
        fs::remove_file(&ppm_path).unwrap();
    }

    #[test]
    fn rejects_ppm_inputs_beyond_the_pixel_guardrail() {
        let ppm_path = temp_path("oversized.ppm");
        fs::write(&ppm_path, b"P6\n4 4\n255\n").unwrap();
        let error = read_dimensions(&ppm_path, 8, 16).unwrap_err();
        assert!(error.contains("guardrails"), "unexpected error: {error}");
        fs::remove_file(&ppm_path).unwrap();
    }
}
