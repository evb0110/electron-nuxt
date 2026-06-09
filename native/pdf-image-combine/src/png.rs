use std::io::Read;

use crate::{binary::read_u32_be, Result, METERS_PER_INCH};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) struct PngData {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) color_type: u8,
    pub(crate) dpi: Option<u32>,
    pub(crate) idat: Vec<u8>,
}

pub(crate) fn parse_png_reader<R: Read>(mut reader: R) -> Result<PngData> {
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

    while let Some(header) = read_png_chunk_header(&mut reader)? {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let chunk_type = &header[4..8];

        match chunk_type {
            b"IHDR" => {
                if length != 13 {
                    return Err("Invalid PNG IHDR length".into());
                }
                let mut chunk_data = [0u8; 13];
                reader.read_exact(&mut chunk_data)?;
                width = Some(read_u32_be(&chunk_data, 0).ok_or("Missing PNG width")?);
                height = Some(read_u32_be(&chunk_data, 4).ok_or("Missing PNG height")?);
                bit_depth = chunk_data.get(8).copied();
                color_type = chunk_data.get(9).copied();
                compression_method = chunk_data.get(10).copied();
                filter_method = chunk_data.get(11).copied();
                interlace_method = chunk_data.get(12).copied();
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
            b"IDAT" => {
                let start = idat.len();
                let end = start
                    .checked_add(length)
                    .ok_or("Invalid PNG image data length")?;
                idat.resize(end, 0);
                reader.read_exact(&mut idat[start..])?;
            }
            b"IEND" => {
                skip_exact(&mut reader, length)?;
                let mut crc = [0u8; 4];
                reader.read_exact(&mut crc)?;
                break;
            }
            _ => skip_exact(&mut reader, length)?,
        }

        let mut crc = [0u8; 4];
        reader.read_exact(&mut crc)?;
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

    Ok(PngData {
        width,
        height,
        color_type,
        dpi,
        idat,
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
    use std::io::Cursor;

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
        bytes.extend_from_slice(&png_chunk(b"IDAT", b"abc"));
        bytes.extend_from_slice(&png_chunk(b"IDAT", b"def"));
        bytes.extend_from_slice(&png_chunk(b"IEND", b""));

        let png = parse_png_reader(Cursor::new(bytes)).unwrap();

        assert_eq!(png.width, 2);
        assert_eq!(png.height, 1);
        assert_eq!(png.color_type, 2);
        assert_eq!(png.dpi, Some(300));
        assert_eq!(png.idat, b"abcdef");
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        chunk
    }
}
