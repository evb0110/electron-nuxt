use scan_primitives::GrayImage;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

pub fn write_p4_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    let bytes = encode_p4(image)?;
    let temporary = temporary_sibling(path);
    let result = (|| {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn read_p4(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    decode_p4(&bytes, max_pixels, max_dimension)
}

pub fn decode_p4(bytes: &[u8], max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    if bytes.get(..3) != Some(b"P4\n") {
        return Err("Invalid PBM P4 signature".into());
    }
    let dimensions_end = bytes[3..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| offset + 3)
        .ok_or("Truncated PBM P4 header")?;
    let dimensions = std::str::from_utf8(&bytes[3..dimensions_end])
        .map_err(|_| "Invalid PBM P4 dimensions")?
        .split_ascii_whitespace()
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| "Invalid PBM P4 dimensions")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dimensions.len() != 2 {
        return Err("Invalid PBM P4 dimensions".into());
    }
    let (width, height) = (dimensions[0], dimensions[1]);
    if width == 0
        || height == 0
        || width > max_dimension as usize
        || height > max_dimension as usize
        || (width as u64).saturating_mul(height as u64) > max_pixels
    {
        return Err(format!(
            "PBM P4 dimensions exceed cleanup guardrails: {width}x{height}"
        ));
    }
    let row_stride = width.div_ceil(8);
    let bitmap = bytes
        .get(dimensions_end + 1..)
        .ok_or("Truncated PBM P4 payload")?;
    if bitmap.len() != row_stride.saturating_mul(height) {
        return Err("PBM P4 payload length mismatch".into());
    }
    let mut image = GrayImage::new(width, height, 255);
    for y in 0..height {
        for x in 0..width {
            if bitmap[y * row_stride + x / 8] & (1 << (7 - x % 8)) != 0 {
                image.set(x, y, 0);
            }
        }
    }
    Ok(image)
}

pub fn encode_p4(image: &GrayImage) -> Result<Vec<u8>, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("PBM P4 dimensions must be positive".into());
    }
    let row_stride = image
        .width()
        .checked_add(7)
        .ok_or("PBM P4 row stride overflow")?
        / 8;
    let bitmap_len = row_stride
        .checked_mul(image.height())
        .ok_or("PBM P4 payload size overflow")?;
    let header = format!("P4\n{} {}\n", image.width(), image.height());
    let mut bytes = Vec::with_capacity(header.len().saturating_add(bitmap_len));
    bytes.extend_from_slice(header.as_bytes());
    for y in 0..image.height() {
        let row_start = bytes.len();
        bytes.resize(row_start + row_stride, 0);
        for (x, pixel) in image.row(y).iter().copied().enumerate() {
            match pixel {
                0 => bytes[row_start + x / 8] |= 1 << (7 - x % 8),
                255 => {}
                value => {
                    return Err(format!(
                        "PBM P4 source contains non-binary sample {value} at ({x}, {y})"
                    ))
                }
            }
        }
    }
    Ok(bytes)
}

fn temporary_sibling(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_black_as_one_and_clears_row_padding() {
        let image = GrayImage::from_vec(
            10,
            2,
            10,
            vec![
                0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
                0,
            ],
        )
        .unwrap();

        assert_eq!(encode_p4(&image).unwrap(), b"P4\n10 2\n\x80\x40\x55\x40");
    }

    #[test]
    fn rejects_tonal_samples() {
        let image = GrayImage::from_vec(1, 1, 1, vec![127]).unwrap();
        assert!(encode_p4(&image)
            .unwrap_err()
            .contains("non-binary sample 127"));
    }

    #[test]
    fn roundtrips_p4_pixels_and_dimensions() {
        let source = GrayImage::from_vec(
            10,
            2,
            10,
            vec![
                0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
                0,
            ],
        )
        .unwrap();

        assert_eq!(
            decode_p4(&encode_p4(&source).unwrap(), 100, 20).unwrap(),
            source
        );
    }
}
