//! Format-sniffing readers for cleanup raster inputs: PNG for browser-visible
//! surfaces and raw PPM P6 for pipeline-internal Poppler handoffs.
use super::{decode_limits, read_file_bounded, write_atomic_with, MAX_COMPRESSED_BYTES};
use evb_raster_io::{
    decode_png, decode_png_gray, decode_ppm, decode_ppm_gray, read_png_dimensions,
    read_ppm_dimensions,
};
use jbig2_codec::{decode_pdf_generic_source, DecodeLimits};
use scan_primitives::{GrayImage, RgbImage};
use std::{
    fs::File,
    io::{Cursor, ErrorKind, Read, Write},
    path::Path,
};

pub use evb_raster_io::DecodedRaster;

pub fn read_gray(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    let (file, is_ppm) = open_sniffed(path)?;
    let limits = decode_limits(max_pixels, max_dimension);
    if is_ppm {
        decode_ppm_gray(file, limits)
    } else {
        decode_png_gray(file, limits)
    }
    .map_err(|error| error.to_string())
}

pub fn read_foreground_selection(
    path: &Path,
    max_pixels: u64,
    max_dimension: u32,
) -> Result<GrayImage, String> {
    read_foreground_selection_with_limit(path, max_pixels, max_dimension, MAX_COMPRESSED_BYTES)
}

fn read_foreground_selection_with_limit(
    path: &Path,
    max_pixels: u64,
    max_dimension: u32,
    max_compressed_bytes: usize,
) -> Result<GrayImage, String> {
    if path
        .extension()
        .is_some_and(|extension| extension == "jb2e")
    {
        let bytes =
            read_file_bounded(path, max_compressed_bytes).map_err(|error| error.to_string())?;
        let decoded = decode_pdf_generic_source(&bytes, DecodeLimits::new(max_pixels))
            .map_err(|error| error.to_string())?;
        if decoded.width > max_dimension || decoded.height > max_dimension {
            return Err(format!(
                "decoded JBIG2 dimensions {}x{} exceed the limit of {}",
                decoded.width, decoded.height, max_dimension,
            ));
        }
        let width = decoded.width as usize;
        let height = decoded.height as usize;
        let stride = width.div_ceil(8);
        let mut samples = Vec::with_capacity(width.saturating_mul(height));
        for y in 0..height {
            for x in 0..width {
                let bit = decoded.rows[y * stride + x / 8] & (0x80 >> (x % 8));
                // JBIG2 bitmap one is a black PDF sample (zero opacity in a
                // default DeviceGray soft mask); bitmap zero is white/opaque.
                samples.push(if bit == 0 { 255 } else { 0 });
            }
        }
        return GrayImage::from_vec(width, height, width, samples)
            .ok_or_else(|| "decoded JBIG2 selection has invalid dimensions".to_string());
    }
    read_gray(path, max_pixels, max_dimension)
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

pub fn write_rgb_ppm_atomic(path: &Path, image: &RgbImage) -> Result<(), String> {
    write_atomic_with(path, |file| {
        write!(file, "P6\n{} {}\n255\n", image.width(), image.height())
            .map_err(|error| error.to_string())?;
        file.write_all(image.data())
            .map_err(|error| error.to_string())
    })
}

pub fn write_gray_ppm_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    write_atomic_with(path, |file| {
        write!(file, "P6\n{} {}\n255\n", image.width(), image.height())
            .map_err(|error| error.to_string())?;
        let mut row = vec![0; image.width() * 3];
        for source in image.data().chunks_exact(image.width()) {
            for (target, value) in row.chunks_exact_mut(3).zip(source.iter().copied()) {
                target.fill(value);
            }
            file.write_all(&row).map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

pub fn write_gray_pgm_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    write_atomic_with(path, |file| {
        write!(file, "P5\n{} {}\n255\n", image.width(), image.height())
            .map_err(|error| error.to_string())?;
        file.write_all(image.data())
            .map_err(|error| error.to_string())
    })
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
    fn gray_reads_carry_the_same_plane_as_full_reads_for_both_formats() {
        let mut source = GrayImage::new(5, 4, 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (x * 37 + y * 91) as u8);
            }
        }
        let png_path = temp_path("plane.png");
        fs::write(&png_path, encode_gray(&source).unwrap()).unwrap();
        let ppm_path = temp_path("plane.ppm");
        let mut ppm = b"P6\n5 4\n255\n".to_vec();
        for y in 0..source.height() {
            for x in 0..source.width() {
                ppm.extend_from_slice(&[(x * 11) as u8, (y * 53) as u8, (x * 7 + y) as u8]);
            }
        }
        fs::write(&ppm_path, ppm).unwrap();

        for path in [&png_path, &ppm_path] {
            assert_eq!(
                read_gray(path, 64, 64).unwrap(),
                read_image(path, 64, 64).unwrap().gray,
                "gray plane diverged for {}",
                path.display()
            );
        }
        assert_eq!(read_gray(&png_path, 64, 64).unwrap(), source);

        fs::remove_file(&png_path).unwrap();
        fs::remove_file(&ppm_path).unwrap();
    }

    #[test]
    fn reads_pdf_embedded_jbig2_selection_samples_as_white_opacity() {
        let path = temp_path("selection.jb2e");
        let encoded = jbig2_codec::encode_pdf_generic(jbig2_codec::Bilevel {
            width: 8,
            height: 1,
            rows: &[0b1010_0000],
        })
        .unwrap();
        fs::write(&path, encoded).unwrap();

        let selection = read_foreground_selection(&path, 64, 64).unwrap();

        assert_eq!(selection.width(), 8);
        assert_eq!(selection.height(), 1);
        assert_eq!(selection.get(0, 0), 0);
        assert_eq!(selection.get(1, 0), 255);
        assert_eq!(selection.get(2, 0), 0);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_jbig2_selection_before_an_oversize_file_is_buffered() {
        let path = temp_path("oversize-selection.jb2e");
        fs::write(&path, b"0123456789").unwrap();

        let error = read_foreground_selection_with_limit(&path, 64, 64, 9).unwrap_err();

        assert!(error.contains("9-byte limit"), "unexpected error: {error}");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_ppm_inputs_beyond_the_pixel_guardrail() {
        let ppm_path = temp_path("oversized.ppm");
        fs::write(&ppm_path, b"P6\n4 4\n255\n").unwrap();
        let error = read_dimensions(&ppm_path, 8, 16).unwrap_err();
        assert!(error.contains("guardrails"), "unexpected error: {error}");
        fs::remove_file(&ppm_path).unwrap();
    }

    #[test]
    fn writes_gray_planes_as_rgb_ppm_handoffs() {
        let mut source = GrayImage::new(2, 1, 255);
        source.set(0, 0, 17);
        source.set(1, 0, 231);
        let ppm_path = temp_path("gray-output.ppm");

        write_gray_ppm_atomic(&ppm_path, &source).unwrap();

        let decoded = read_image(&ppm_path, 16, 16).unwrap();
        assert_eq!(decoded.rgb.get(0, 0), [17, 17, 17]);
        assert_eq!(decoded.rgb.get(1, 0), [231, 231, 231]);
        fs::remove_file(&ppm_path).unwrap();
    }

    #[test]
    fn writes_gray_planes_as_single_channel_pgm_handoffs() {
        let mut source = GrayImage::new(2, 1, 255);
        source.set(0, 0, 17);
        source.set(1, 0, 231);
        let pgm_path = temp_path("gray-output.pgm");

        write_gray_pgm_atomic(&pgm_path, &source).unwrap();

        let bytes = fs::read(&pgm_path).unwrap();
        assert_eq!(bytes, b"P5\n2 1\n255\n\x11\xe7");
        fs::remove_file(&pgm_path).unwrap();
    }
}
