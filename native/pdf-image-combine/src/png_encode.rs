use std::{fs, path::Path};

use crc32fast::Hasher;
use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

use crate::{
    netpbm::{is_rgb_data_grayscale, parse_netpbm},
    Result,
};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) fn encode_netpbm_file_as_png(input_path: &Path, output_path: &Path) -> Result<()> {
    let data = fs::read(input_path)?;
    let png = encode_netpbm_as_png(&data)?;
    fs::write(output_path, png)?;
    Ok(())
}

fn encode_netpbm_as_png(data: &[u8]) -> Result<Vec<u8>> {
    let netpbm = parse_netpbm(data)?;
    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let (color_type, channels, pixels) = if netpbm.channels == 1 {
        (0u8, 1usize, netpbm.pixels.to_vec())
    } else if is_rgb_data_grayscale(netpbm.pixels, total_pixels) {
        let mut grayscale = Vec::with_capacity(total_pixels);
        for chunk in netpbm.pixels.chunks_exact(3) {
            grayscale.push(chunk[0]);
        }
        (0u8, 1usize, grayscale)
    } else {
        (2u8, 3usize, netpbm.pixels.to_vec())
    };

    let compressed = deflate_png_rows(&pixels, netpbm.width as usize * channels, netpbm.height as usize)?;
    let mut png = Vec::new();
    png.extend_from_slice(PNG_SIGNATURE);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&netpbm.width.to_be_bytes());
    ihdr.extend_from_slice(&netpbm.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    push_chunk(&mut png, b"IHDR", &ihdr);
    push_chunk(&mut png, b"IDAT", &compressed);
    push_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn deflate_png_rows(pixels: &[u8], bytes_per_row: usize, height: usize) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    for row in 0..height {
        let start = row * bytes_per_row;
        encoder.write_all(&[0])?;
        encoder.write_all(&pixels[start..start + bytes_per_row])?;
    }
    Ok(encoder.finish()?)
}

fn push_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    png.extend_from_slice(&hasher.finalize().to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::read_u32_be;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    #[test]
    fn encodes_rgb_netpbm_as_png() {
        let png = encode_netpbm_as_png(b"P6\n2 1\n255\n\x01\x02\x03\x04\x05\x06").unwrap();
        let ihdr = chunk_data(&png, b"IHDR").unwrap();
        let idat = chunk_data(&png, b"IDAT").unwrap();

        assert_eq!(&png[..8], PNG_SIGNATURE);
        assert_eq!(read_u32_be(ihdr, 0), Some(2));
        assert_eq!(read_u32_be(ihdr, 4), Some(1));
        assert_eq!(ihdr[8], 8);
        assert_eq!(ihdr[9], 2);
        assert_eq!(inflate(idat), vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn encodes_gray_rgb_netpbm_as_grayscale_png() {
        let png = encode_netpbm_as_png(b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09").unwrap();
        let ihdr = chunk_data(&png, b"IHDR").unwrap();
        let idat = chunk_data(&png, b"IDAT").unwrap();

        assert_eq!(ihdr[9], 0);
        assert_eq!(inflate(idat), vec![0, 7, 9]);
    }

    #[test]
    fn encodes_pgm_as_grayscale_png() {
        let png = encode_netpbm_as_png(b"P5\n# comment\n1 2\n255\n\x01\x02").unwrap();
        let ihdr = chunk_data(&png, b"IHDR").unwrap();
        let idat = chunk_data(&png, b"IDAT").unwrap();

        assert_eq!(read_u32_be(ihdr, 0), Some(1));
        assert_eq!(read_u32_be(ihdr, 4), Some(2));
        assert_eq!(ihdr[9], 0);
        assert_eq!(inflate(idat), vec![0, 1, 0, 2]);
    }

    fn chunk_data<'a>(png: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
        let mut offset = PNG_SIGNATURE.len();
        while offset + 12 <= png.len() {
            let length = read_u32_be(png, offset)? as usize;
            let chunk_kind = png.get(offset + 4..offset + 8)?;
            let data_start = offset + 8;
            let data_end = data_start + length;
            if chunk_kind == kind {
                return png.get(data_start..data_end);
            }
            offset = data_end + 4;
        }
        None
    }

    fn inflate(bytes: &[u8]) -> Vec<u8> {
        let mut decoder = ZlibDecoder::new(bytes);
        let mut inflated = Vec::new();
        decoder.read_to_end(&mut inflated).unwrap();
        inflated
    }
}
