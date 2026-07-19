use crc32fast::Hasher;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use scan_primitives::GrayImage;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use crate::{DEFAULT_MAX_DIMENSION, DEFAULT_MAX_PIXELS};

const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub fn read_gray(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    decode_gray(&bytes, max_pixels, max_dimension)
}

pub fn decode_gray(bytes: &[u8], max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    if bytes.get(..8) != Some(SIGNATURE) {
        return Err("Invalid PNG signature".into());
    }
    let mut offset = 8usize;
    let mut dimensions = None;
    let mut color_type = 0u8;
    let mut compressed = Vec::new();
    let mut saw_end = false;
    while offset + 12 <= bytes.len() {
        let length = read_u32(bytes, offset)? as usize;
        let kind = bytes
            .get(offset + 4..offset + 8)
            .ok_or("Truncated PNG chunk")?;
        let start = offset.checked_add(8).ok_or("PNG chunk overflow")?;
        let end = start.checked_add(length).ok_or("PNG chunk overflow")?;
        let data = bytes.get(start..end).ok_or("Truncated PNG chunk")?;
        let expected_crc = read_u32(bytes, end)?;
        let mut hasher = Hasher::new();
        hasher.update(kind);
        hasher.update(data);
        if hasher.finalize() != expected_crc {
            return Err("PNG chunk CRC mismatch".into());
        }
        match kind {
            b"IHDR" => {
                if data.len() != 13 || dimensions.is_some() {
                    return Err("Invalid PNG IHDR".into());
                }
                let width = read_u32(data, 0)?;
                let height = read_u32(data, 4)?;
                if width == 0
                    || height == 0
                    || width > max_dimension
                    || height > max_dimension
                    || u64::from(width) * u64::from(height) > max_pixels
                {
                    return Err(format!(
                        "PNG dimensions exceed cleanup guardrails: {width}x{height}"
                    ));
                }
                if data[8] != 8
                    || !matches!(data[9], 0 | 2 | 4 | 6)
                    || data[10] != 0
                    || data[11] != 0
                    || data[12] != 0
                {
                    return Err(
                        "Only non-interlaced 8-bit grayscale/RGB/RGBA PNG is supported".into(),
                    );
                }
                color_type = data[9];
                dimensions = Some((width as usize, height as usize));
            }
            b"IDAT" => {
                if compressed
                    .len()
                    .checked_add(data.len())
                    .ok_or("PNG data overflow")?
                    > 512 * 1024 * 1024
                {
                    return Err("PNG compressed payload is too large".into());
                }
                compressed.extend_from_slice(data);
            }
            b"IEND" => {
                saw_end = true;
                break;
            }
            _ => {}
        }
        offset = end.checked_add(4).ok_or("PNG chunk overflow")?;
    }
    let (width, height) = dimensions.ok_or("Missing PNG IHDR")?;
    if !saw_end {
        return Err("Missing PNG IEND".into());
    }
    let channels = match color_type {
        0 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => unreachable!(),
    };
    let row_bytes = width.checked_mul(channels).ok_or("PNG row overflow")?;
    let expected = height
        .checked_mul(row_bytes + 1)
        .ok_or("PNG payload overflow")?;
    let mut decoder = ZlibDecoder::new(compressed.as_slice());
    let mut filtered = Vec::with_capacity(expected);
    decoder
        .by_ref()
        .take(expected as u64 + 1)
        .read_to_end(&mut filtered)
        .map_err(|error| error.to_string())?;
    if filtered.len() != expected {
        return Err("PNG decompressed payload length mismatch".into());
    }
    let mut current = vec![0u8; row_bytes];
    let mut previous = vec![0u8; row_bytes];
    let mut output = GrayImage::new(width, height, 255);
    let mut position = 0usize;
    for y in 0..height {
        let filter = filtered[position];
        position += 1;
        current.copy_from_slice(&filtered[position..position + row_bytes]);
        position += row_bytes;
        unfilter(&mut current, &previous, channels, filter)?;
        for x in 0..width {
            let pixel = &current[x * channels..(x + 1) * channels];
            let gray = match color_type {
                0 | 4 => pixel[0],
                2 | 6 => {
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8
                }
                _ => unreachable!(),
            };
            output.set(x, y, gray);
        }
        std::mem::swap(&mut current, &mut previous);
    }
    Ok(output)
}

fn unfilter(row: &mut [u8], previous: &[u8], channels: usize, filter: u8) -> Result<(), String> {
    for index in 0..row.len() {
        let left = if index >= channels {
            row[index - channels]
        } else {
            0
        };
        let up = previous[index];
        let upper_left = if index >= channels {
            previous[index - channels]
        } else {
            0
        };
        row[index] = row[index].wrapping_add(match filter {
            0 => 0,
            1 => left,
            2 => up,
            3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
            4 => paeth(left, up, upper_left),
            _ => return Err(format!("Unsupported PNG filter: {filter}")),
        });
    }
    Ok(())
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let prediction = i32::from(left) + i32::from(up) - i32::from(upper_left);
    let dl = (prediction - i32::from(left)).abs();
    let du = (prediction - i32::from(up)).abs();
    let dul = (prediction - i32::from(upper_left)).abs();
    if dl <= du && dl <= dul {
        left
    } else if du <= dul {
        up
    } else {
        upper_left
    }
}

pub fn write_gray_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    let bytes = encode_gray(image)?;
    let temp = temporary_sibling(path);
    let result = (|| {
        let mut file = File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn encode_gray(image: &GrayImage) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    for y in 0..image.height() {
        encoder.write_all(&[0]).map_err(|error| error.to_string())?;
        encoder
            .write_all(image.row(y))
            .map_err(|error| error.to_string())?;
    }
    let compressed = encoder.finish().map_err(|error| error.to_string())?;
    let mut bytes = SIGNATURE.to_vec();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(image.width() as u32).to_be_bytes());
    ihdr.extend_from_slice(&(image.height() as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    write_chunk(&mut bytes, b"IHDR", &ihdr);
    write_chunk(&mut bytes, b"IDAT", &compressed);
    write_chunk(&mut bytes, b"IEND", &[]);
    Ok(bytes)
}

fn write_chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(kind);
    output.extend_from_slice(data);
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    output.extend_from_slice(&hasher.finalize().to_be_bytes());
}
fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_be_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or("Truncated PNG integer")?
            .try_into()
            .map_err(|_| "Invalid PNG integer")?,
    ))
}
fn temporary_sibling(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

pub fn read_gray_default(path: &Path) -> Result<GrayImage, String> {
    read_gray(path, DEFAULT_MAX_PIXELS, DEFAULT_MAX_DIMENSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grayscale_png_round_trips() {
        let image = GrayImage::from_vec(3, 2, 3, vec![0, 30, 255, 80, 120, 200]).unwrap();
        assert_eq!(
            decode_gray(&encode_gray(&image).unwrap(), 100, 10).unwrap(),
            image
        );
    }
    #[test]
    fn dimensions_are_guarded_before_inflate() {
        let image = GrayImage::new(3, 2, 0);
        let bytes = encode_gray(&image).unwrap();
        assert!(decode_gray(&bytes, 5, 10)
            .unwrap_err()
            .contains("guardrails"));
    }
}
