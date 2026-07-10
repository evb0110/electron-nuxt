use std::{
    io::{Read, Write},
    path::Path,
};

#[cfg(test)]
use std::fs;

use crc32fast::Hasher;
use flate2::{write::ZlibEncoder, Compression};

use crate::{
    netpbm::{is_rgb_data_grayscale, parse_netpbm},
    output::{validate_output_inputs, write_atomically},
    Result,
};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) fn encode_netpbm_file_as_png(
    input_path: &Path,
    output_path: &Path,
    max_pixels: u64,
) -> Result<()> {
    let validated_inputs = validate_output_inputs(&[input_path.to_path_buf()], output_path)?;
    encode_validated_netpbm_file_as_png(output_path, max_pixels, &validated_inputs)
}

fn encode_validated_netpbm_file_as_png(
    output_path: &Path,
    max_pixels: u64,
    validated_inputs: &crate::output::ValidatedInputs,
) -> Result<()> {
    let mut input = validated_inputs.file(0)?;
    let mut data = Vec::new();
    input.read_to_end(&mut data)?;
    let png = encode_netpbm_as_png(&data, max_pixels)?;
    write_atomically(output_path, |output| {
        output.write_all(&png)?;
        Ok(())
    })
}

fn encode_netpbm_as_png(data: &[u8], max_pixels: u64) -> Result<Vec<u8>> {
    let netpbm = parse_netpbm(data, max_pixels)?;
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

    let compressed = deflate_png_rows(
        &pixels,
        netpbm.width as usize * channels,
        netpbm.height as usize,
    )?;
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
    use std::{
        env,
        io::Read,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn encodes_rgb_netpbm_as_png() {
        let png = encode_netpbm_as_png(b"P6\n2 1\n255\n\x01\x02\x03\x04\x05\x06", 2).unwrap();
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
        let png = encode_netpbm_as_png(b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09", 2).unwrap();
        let ihdr = chunk_data(&png, b"IHDR").unwrap();
        let idat = chunk_data(&png, b"IDAT").unwrap();

        assert_eq!(ihdr[9], 0);
        assert_eq!(inflate(idat), vec![0, 7, 9]);
    }

    #[test]
    fn encodes_pgm_as_grayscale_png() {
        let png = encode_netpbm_as_png(b"P5\n# comment\n1 2\n255\n\x01\x02", 2).unwrap();
        let ihdr = chunk_data(&png, b"IHDR").unwrap();
        let idat = chunk_data(&png, b"IDAT").unwrap();

        assert_eq!(read_u32_be(ihdr, 0), Some(1));
        assert_eq!(read_u32_be(ihdr, 4), Some(2));
        assert_eq!(ihdr[9], 0);
        assert_eq!(inflate(idat), vec![0, 1, 0, 2]);
    }

    #[test]
    fn rejects_oversized_netpbm_dimensions_before_payload_or_png_allocation() {
        let error = encode_netpbm_as_png(b"P6\n100000 100000\n255\n", 1_000_000).unwrap_err();

        assert!(error.to_string().contains("100000x100000"));
    }

    #[test]
    fn file_conversion_preserves_existing_output_when_pixel_policy_rejects_input() {
        let input_path = temp_path("oversized-input").with_extension("ppm");
        let output_path = temp_path("existing-output").with_extension("png");
        fs::write(&input_path, b"P6\n100000 100000\n255\n").unwrap();
        fs::write(&output_path, b"existing-png-output").unwrap();

        let result = encode_netpbm_file_as_png(&input_path, &output_path, 1_000_000);

        assert!(result.is_err());
        assert_eq!(fs::read(&output_path).unwrap(), b"existing-png-output");
        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn file_conversion_rejects_output_alias_to_netpbm_input() {
        let input_path = temp_path("alias-input").with_extension("ppm");
        let original = b"P6\n1 1\n255\n\x01\x02\x03";
        fs::write(&input_path, original).unwrap();

        let error = encode_netpbm_file_as_png(&input_path, &input_path, 1).unwrap_err();

        assert!(error.to_string().contains("Output aliases an input"));
        assert_eq!(fs::read(&input_path).unwrap(), original);
        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn file_conversion_decodes_validated_descriptor_after_path_becomes_output_alias() {
        let input_path = temp_path("descriptor-input").with_extension("ppm");
        let displaced_path = temp_path("descriptor-original").with_extension("ppm");
        let output_path = temp_path("descriptor-output").with_extension("png");
        fs::write(&input_path, b"P6\n1 1\n255\n\x11\x22\x33").unwrap();
        fs::write(&output_path, b"old-png-output").unwrap();
        let input_paths = vec![input_path.clone()];

        let validated_inputs = validate_output_inputs(&input_paths, &output_path).unwrap();
        fs::rename(&input_path, &displaced_path).unwrap();
        fs::hard_link(&output_path, &input_path).unwrap();

        encode_validated_netpbm_file_as_png(&output_path, 1, &validated_inputs).unwrap();

        let png = fs::read(&output_path).unwrap();
        assert_eq!(
            inflate(chunk_data(&png, b"IDAT").unwrap()),
            vec![0, 17, 34, 51]
        );
        assert_eq!(fs::read(&input_path).unwrap(), b"old-png-output");
        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(displaced_path);
        let _ = fs::remove_file(output_path);
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

    fn temp_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "evb-pdf-image-combine-png-{label}-{}-{nanos}",
            process::id()
        ))
    }
}
