use std::io::Read;

use flate2::read::ZlibDecoder;

use crate::{binary::read_u32_be, image::assert_pixel_limit, Result, METERS_PER_INCH};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug)]
pub(crate) struct PngData {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) color_type: u8,
    pub(crate) dpi: Option<u32>,
    pub(crate) idat: Vec<u8>,
    pub(crate) icc_profile: Option<Vec<u8>>,
}

pub(crate) fn parse_png_reader<R: Read>(mut reader: R, max_pixels: u64) -> Result<PngData> {
    let mut signature = [0u8; 8];
    if reader.read_exact(&mut signature).is_err() || &signature != PNG_SIGNATURE {
        return Err("Invalid PNG payload".into());
    }

    let mut width = None;
    let mut height = None;
    let mut bit_depth = None;
    let mut color_type = None;
    let mut compression_method = None;
    let mut filter_method = None;
    let mut interlace_method = None;
    let mut dpi = None;
    let mut idat = Vec::new();
    let mut max_idat_bytes = None;
    let mut saw_iend = false;
    let mut icc_profile = None;

    while let Some(header) = read_png_chunk_header(&mut reader)? {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let chunk_type = &header[4..8];

        match chunk_type {
            b"IHDR" => {
                if length != 13 {
                    return Err("Invalid PNG IHDR length".into());
                }
                if width.is_some() {
                    return Err("Duplicate PNG IHDR".into());
                }
                let mut chunk_data = [0u8; 13];
                reader.read_exact(&mut chunk_data)?;
                let parsed_width = read_u32_be(&chunk_data, 0).ok_or("Missing PNG width")?;
                let parsed_height = read_u32_be(&chunk_data, 4).ok_or("Missing PNG height")?;
                let parsed_bit_depth = chunk_data[8];
                let parsed_color_type = chunk_data[9];
                validate_png_header(
                    parsed_width,
                    parsed_height,
                    parsed_bit_depth,
                    parsed_color_type,
                    chunk_data[10],
                    chunk_data[11],
                    chunk_data[12],
                    max_pixels,
                )?;
                width = Some(parsed_width);
                height = Some(parsed_height);
                bit_depth = Some(parsed_bit_depth);
                color_type = Some(parsed_color_type);
                compression_method = chunk_data.get(10).copied();
                filter_method = chunk_data.get(11).copied();
                interlace_method = chunk_data.get(12).copied();
                let expected_len =
                    expected_png_data_length(parsed_width, parsed_height, parsed_color_type)?;
                max_idat_bytes = Some(max_png_compressed_length(expected_len)?);
            }
            b"pHYs" => {
                if length == 9 {
                    let mut chunk_data = [0u8; 9];
                    reader.read_exact(&mut chunk_data)?;
                    dpi = read_png_phys_dpi(&chunk_data, 0);
                } else {
                    skip_exact(&mut reader, length)?;
                }
            }
            b"iCCP" => {
                if icc_profile.is_some() {
                    return Err("Duplicate PNG iCCP profile".into());
                }
                let mut chunk_data = vec![0u8; length];
                reader.read_exact(&mut chunk_data)?;
                let name_end = chunk_data.iter().position(|byte| *byte == 0)
                    .ok_or("Invalid PNG iCCP profile name")?;
                if name_end == 0 || name_end > 79 || chunk_data.get(name_end + 1) != Some(&0) {
                    return Err("Invalid PNG iCCP profile header".into());
                }
                let compressed = chunk_data.get(name_end + 2..)
                    .ok_or("Invalid PNG iCCP payload")?;
                let decoder = ZlibDecoder::new(compressed);
                let mut profile = Vec::new();
                decoder.take(16 * 1024 * 1024 + 1).read_to_end(&mut profile)?;
                if profile.len() > 16 * 1024 * 1024 {
                    return Err("PNG ICC profile exceeds the 16 MiB safety limit".into());
                }
                icc_profile = Some(profile);
            }
            b"IDAT" => {
                let compressed_limit =
                    max_idat_bytes.ok_or("PNG image data appeared before a valid IHDR")?;
                let start = idat.len();
                let end = start
                    .checked_add(length)
                    .ok_or("Invalid PNG image data length")?;
                if end > compressed_limit {
                    return Err(format!(
                        "PNG compressed image data exceeds the {compressed_limit}-byte safety limit"
                    )
                    .into());
                }
                idat.try_reserve_exact(length)
                    .map_err(|_| "Unable to reserve memory for PNG image data")?;
                idat.resize(end, 0);
                reader.read_exact(&mut idat[start..])?;
            }
            b"IEND" => {
                if length != 0 {
                    return Err("Invalid PNG IEND length".into());
                }
                skip_exact(&mut reader, length)?;
                let mut crc = [0u8; 4];
                reader.read_exact(&mut crc)?;
                saw_iend = true;
                break;
            }
            _ => skip_exact(&mut reader, length)?,
        }

        let mut crc = [0u8; 4];
        reader.read_exact(&mut crc)?;
    }

    if !saw_iend {
        return Err("Missing PNG IEND".into());
    }

    let width = width.ok_or("Missing PNG IHDR")?;
    let height = height.ok_or("Missing PNG IHDR")?;
    let color_type = color_type.ok_or("Missing PNG color type")?;
    if bit_depth != Some(8) {
        return Err("Unsupported PNG bit depth".into());
    }
    if compression_method != Some(0) || filter_method != Some(0) {
        return Err("Unsupported PNG compression or filter method".into());
    }
    if interlace_method != Some(0) {
        return Err("Interlaced PNG images are not supported by the native fast path".into());
    }
    if idat.is_empty() {
        return Err("Missing PNG image data".into());
    }
    validate_png_idat_data_length(&idat, width, height, color_type)?;

    Ok(PngData {
        width,
        height,
        color_type,
        dpi,
        idat,
        icc_profile,
    })
}

fn read_png_chunk_header<R: Read>(reader: &mut R) -> Result<Option<[u8; 8]>> {
    let mut header = [0u8; 8];
    let read = reader.read(&mut header[..1])?;
    if read == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    Ok(Some(header))
}

fn validate_png_idat_data_length(
    idat: &[u8],
    width: u32,
    height: u32,
    color_type: u8,
) -> Result<()> {
    let expected_len = expected_png_data_length(width, height, color_type)?;

    let mut decoder = ZlibDecoder::new(idat);
    let mut buffer = [0u8; 8192];
    let mut decoded_len = 0usize;
    loop {
        let remaining = expected_len.saturating_sub(decoded_len);
        let read_limit = remaining.saturating_add(1).min(buffer.len());
        let read = decoder.read(&mut buffer[..read_limit])?;
        if read == 0 {
            break;
        }
        decoded_len = decoded_len
            .checked_add(read)
            .ok_or("Invalid PNG image data length")?;
        if decoded_len > expected_len {
            return Err(format!(
                "PNG image data is longer than expected: expected {expected_len} bytes"
            )
            .into());
        }
    }

    if decoded_len != expected_len {
        return Err(format!(
            "PNG image data length mismatch: expected {expected_len} bytes, got {decoded_len}"
        )
        .into());
    }

    Ok(())
}

fn validate_png_header(
    width: u32,
    height: u32,
    bit_depth: u8,
    color_type: u8,
    compression_method: u8,
    filter_method: u8,
    interlace_method: u8,
    max_pixels: u64,
) -> Result<()> {
    assert_pixel_limit(width, height, max_pixels)?;
    if bit_depth != 8 {
        return Err("Unsupported PNG bit depth".into());
    }
    if supported_png_color_channels(color_type).is_none() {
        return Err(format!("Unsupported PNG color type: {color_type}").into());
    }
    if compression_method != 0 || filter_method != 0 {
        return Err("Unsupported PNG compression or filter method".into());
    }
    if interlace_method != 0 {
        return Err("Interlaced PNG images are not supported by the native fast path".into());
    }
    Ok(())
}

fn expected_png_data_length(width: u32, height: u32, color_type: u8) -> Result<usize> {
    let channels = supported_png_color_channels(color_type).ok_or("Unsupported PNG color type")?;
    (width as usize)
        .checked_mul(channels)
        .and_then(|value| value.checked_add(1))
        .and_then(|value| value.checked_mul(height as usize))
        .ok_or_else(|| "Invalid PNG image data length".into())
}

fn max_png_compressed_length(uncompressed_len: usize) -> Result<usize> {
    // zlib's documented compressBound formula, plus a small allowance for
    // non-default encoders. Inputs larger than this are intentionally outside
    // the native fast-path policy even if a decoder could eventually consume them.
    uncompressed_len
        .checked_add(uncompressed_len >> 12)
        .and_then(|value| value.checked_add(uncompressed_len >> 14))
        .and_then(|value| value.checked_add(uncompressed_len >> 25))
        .and_then(|value| value.checked_add(64))
        .ok_or_else(|| "Invalid PNG compressed image data limit".into())
}

fn supported_png_color_channels(color_type: u8) -> Option<usize> {
    match color_type {
        0 => Some(1),
        2 => Some(3),
        _ => None,
    }
}

fn skip_exact<R: Read>(reader: &mut R, mut length: usize) -> Result<()> {
    let mut buffer = [0u8; 8192];
    while length > 0 {
        let chunk_len = length.min(buffer.len());
        reader.read_exact(&mut buffer[..chunk_len])?;
        length -= chunk_len;
    }
    Ok(())
}

fn read_png_phys_dpi(bytes: &[u8], offset: usize) -> Option<u32> {
    let x_pixels_per_unit = read_u32_be(bytes, offset)?;
    let y_pixels_per_unit = read_u32_be(bytes, offset + 4)?;
    let unit = *bytes.get(offset + 8)?;
    if unit == 1 && (x_pixels_per_unit > 0 || y_pixels_per_unit > 0) {
        let pixels_per_meter = x_pixels_per_unit.max(y_pixels_per_unit) as f64;
        let dpi = (pixels_per_meter * METERS_PER_INCH).round() as u32;
        return (dpi > 0).then_some(dpi);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Cursor;
    use std::io::Write;

    #[test]
    fn reads_png_phys_dpi() {
        let bytes = [0, 0, 0x0B, 0xB8, 0, 0, 0x0B, 0xB8, 1];
        assert_eq!(read_png_phys_dpi(&bytes, 0), Some(76));
    }

    #[test]
    fn parses_png_chunks_from_reader() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&2u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);

        let mut phys = Vec::new();
        phys.extend_from_slice(&11_811u32.to_be_bytes());
        phys.extend_from_slice(&11_811u32.to_be_bytes());
        phys.push(1);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(PNG_SIGNATURE);
        bytes.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        bytes.extend_from_slice(&png_chunk(b"pHYs", &phys));
        let idat = zlib_bytes(&[0, 1, 2, 3, 4, 5, 6]);
        let split_at = idat.len() / 2;
        bytes.extend_from_slice(&png_chunk(b"IDAT", &idat[..split_at]));
        bytes.extend_from_slice(&png_chunk(b"IDAT", &idat[split_at..]));
        bytes.extend_from_slice(&png_chunk(b"IEND", b""));

        let png = parse_png_reader(Cursor::new(bytes), 1_000_000).unwrap();

        assert_eq!(png.width, 2);
        assert_eq!(png.height, 1);
        assert_eq!(png.color_type, 2);
        assert_eq!(png.dpi, Some(300));
        assert_eq!(png.idat, idat);
    }

    #[test]
    fn rejects_png_without_iend() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(PNG_SIGNATURE);
        bytes.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        bytes.extend_from_slice(&png_chunk(b"IDAT", &zlib_bytes(&[0, 7])));

        let result = parse_png_reader(Cursor::new(bytes), 1_000_000);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_png_with_short_decompressed_image_data() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&2u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(PNG_SIGNATURE);
        bytes.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        bytes.extend_from_slice(&png_chunk(b"IDAT", &zlib_bytes(&[0, 1, 2, 3])));
        bytes.extend_from_slice(&png_chunk(b"IEND", b""));

        let result = parse_png_reader(Cursor::new(bytes), 1_000_000);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_declared_near_four_gib_idat_without_allocating_it() {
        let mut bytes = png_header(1, 1, 0);
        bytes.extend_from_slice(&u32::MAX.to_be_bytes());
        bytes.extend_from_slice(b"IDAT");

        let error = parse_png_reader(Cursor::new(bytes), 1).unwrap_err();

        assert!(error
            .to_string()
            .contains("PNG compressed image data exceeds"));
    }

    #[test]
    fn rejects_cumulative_idat_length_before_reserving_next_chunk() {
        let mut bytes = png_header(1, 1, 0);
        bytes.extend_from_slice(&png_chunk(b"IDAT", &[0; 40]));
        bytes.extend_from_slice(&40u32.to_be_bytes());
        bytes.extend_from_slice(b"IDAT");

        let error = parse_png_reader(Cursor::new(bytes), 1).unwrap_err();

        assert!(error
            .to_string()
            .contains("PNG compressed image data exceeds"));
    }

    #[test]
    fn rejects_truncated_idat_chunk() {
        let mut bytes = png_header(1, 1, 0);
        bytes.extend_from_slice(&10u32.to_be_bytes());
        bytes.extend_from_slice(b"IDAT");
        bytes.extend_from_slice(&[0, 1]);

        let error = parse_png_reader(Cursor::new(bytes), 1).unwrap_err();

        assert!(error.to_string().contains("failed to fill whole buffer"));
    }

    #[test]
    fn rejects_highly_compressible_inflate_bomb_at_expected_output_length() {
        let mut bytes = png_header(100, 100, 0);
        let compressed_bomb = zlib_bytes(&vec![0; 10_000_000]);
        assert!(compressed_bomb.len() <= max_png_compressed_length(10_100).unwrap());
        bytes.extend_from_slice(&png_chunk(b"IDAT", &compressed_bomb));
        bytes.extend_from_slice(&png_chunk(b"IEND", b""));

        let error = parse_png_reader(Cursor::new(bytes), 10_000).unwrap_err();

        assert!(error.to_string().contains("longer than expected"));
    }

    #[test]
    fn rejects_pixel_policy_at_ihdr_before_reading_following_chunk() {
        let bytes = png_header(10_000, 10_000, 0);

        let error = parse_png_reader(Cursor::new(bytes), 1_000_000).unwrap_err();

        assert!(error.to_string().contains("10000x10000"));
    }

    fn png_header(width: u32, height: u32, color_type: u8) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
        [PNG_SIGNATURE.as_slice(), &png_chunk(b"IHDR", &ihdr)].concat()
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        chunk
    }

    fn zlib_bytes(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }
}
