use std::{
    fs::File,
    io::{BufReader, BufWriter, Cursor, Read, Seek, Write},
    path::{Path, PathBuf},
};

use tiff::{
    decoder::{ifd::Value as TiffIfdValue, Decoder, DecodingResult},
    encoder::{colortype, Rational, TiffEncoder},
    tags::{ResolutionUnit, Tag},
    ColorType as TiffColorType,
};

use crate::{
    flate::deflate_up_filtered_slices,
    image::assert_pixel_limit,
    output::{validate_output_inputs, write_atomically},
    pdf::{ImagePage, ImagePayload},
    Result, CM_PER_INCH, DEFAULT_DPI,
};

pub(crate) fn read_tiff_pdf_pages_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
) -> Result<Vec<ImagePage>> {
    let mut pages = Vec::new();
    visit_tiff_pdf_pages_from_reader(
        Cursor::new(bytes),
        "in-memory TIFF",
        max_pixels,
        default_dpi,
        max_tiff_frames,
        |page| {
            pages.push(page);
            Ok(())
        },
    )?;
    Ok(pages)
}

#[cfg(test)]
pub(crate) fn visit_tiff_pdf_pages(
    path: &Path,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_file(
        File::open(path)?,
        &path.display().to_string(),
        max_pixels,
        default_dpi,
        max_tiff_frames,
        on_page,
    )
}

pub(crate) fn visit_tiff_pdf_pages_from_file(
    file: File,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_reader(
        file,
        source_label,
        max_pixels,
        default_dpi,
        max_tiff_frames,
        on_page,
    )
}

fn visit_tiff_pdf_pages_from_reader<R: Read + Seek>(
    reader: R,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let mut decoder = Decoder::new(BufReader::new(reader))?;
    let mut page_count = 0;

    loop {
        if page_count >= max_tiff_frames {
            return Err(format!(
                "TIFF frame count is capped at {max_tiff_frames}: {}",
                source_label,
            )
            .into());
        }

        let (width, height) = decoder.dimensions()?;
        assert_pixel_limit(width, height, max_pixels)?;
        let dpi = read_tiff_dpi(&mut decoder)
            .or(default_dpi)
            .unwrap_or(DEFAULT_DPI);
        let color_type = decoder.colortype()?;
        let decoded = decoder.read_image()?;
        on_page(build_tiff_pdf_page(
            width, height, dpi, color_type, decoded,
        )?)?;
        page_count += 1;

        if !decoder.more_images() {
            break;
        }
        decoder.next_image()?;
    }

    if page_count == 0 {
        return Err(format!("No decodable TIFF pages found in {source_label}").into());
    }

    Ok(page_count)
}

fn build_tiff_pdf_page(
    width: u32,
    height: u32,
    dpi: u32,
    color_type: TiffColorType,
    decoded: DecodingResult,
) -> Result<ImagePage> {
    let pixels = match decoded {
        DecodingResult::U8(pixels) => pixels,
        _ => {
            return Err("Only 8-bit TIFF samples are supported by the native PDF fast path".into())
        }
    };

    let (colors, color_space) = match color_type {
        TiffColorType::Gray(8) => (1, "DeviceGray"),
        TiffColorType::RGB(8) => (3, "DeviceRGB"),
        _ => {
            return Err(format!(
                "Unsupported TIFF color type for native PDF fast path: {color_type:?}"
            )
            .into());
        }
    };
    let expected_len = width as usize * height as usize * colors as usize;
    if pixels.len() != expected_len {
        return Err("Decoded TIFF payload length does not match image dimensions".into());
    }

    let bytes_per_row = width as usize * colors as usize;
    let compressed = deflate_up_filtered_slices(&pixels, bytes_per_row, height as usize)?;
    let decode_params =
        format!("<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {width} >>");

    Ok(ImagePage {
        width,
        height,
        dpi,
        color_space,
        icc_profile: None,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params,
        },
    })
}

fn read_tiff_dpi<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<u32> {
    let x_resolution = decoder
        .find_tag(Tag::XResolution)
        .ok()
        .flatten()
        .and_then(tiff_resolution_value_to_f64);
    let y_resolution = decoder
        .find_tag(Tag::YResolution)
        .ok()
        .flatten()
        .and_then(tiff_resolution_value_to_f64);
    let resolution = x_resolution.unwrap_or(0.0).max(y_resolution.unwrap_or(0.0));
    if resolution <= 0.0 {
        return None;
    }

    match decoder
        .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
        .ok()
        .flatten()
        .unwrap_or(2)
    {
        2 => Some(resolution.round() as u32),
        3 => Some((resolution * CM_PER_INCH).round() as u32),
        _ => None,
    }
}

fn tiff_resolution_value_to_f64(value: TiffIfdValue) -> Option<f64> {
    match value {
        TiffIfdValue::Byte(value) => Some(f64::from(value)),
        TiffIfdValue::Short(value) => Some(f64::from(value)),
        TiffIfdValue::Unsigned(value) => Some(f64::from(value)),
        TiffIfdValue::Float(value) => Some(f64::from(value)),
        TiffIfdValue::Double(value) => Some(value),
        TiffIfdValue::Rational(numerator, denominator) if denominator > 0 => {
            Some(f64::from(numerator) / f64::from(denominator))
        }
        TiffIfdValue::List(values) => values
            .into_iter()
            .next()
            .and_then(tiff_resolution_value_to_f64),
        _ => None,
    }
}

struct RgbaTiffPage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

pub(crate) fn combine_tiff_pages(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
) -> Result<()> {
    if input_paths.is_empty() {
        return Err("No pages available for TIFF export".into());
    }
    if input_paths.len() > max_pages {
        return Err(format!("TIFF export is capped at {max_pages} pages").into());
    }

    let validated_inputs = validate_output_inputs(input_paths, output_path)?;
    combine_validated_tiff_pages(input_paths, output_path, max_pixels, &validated_inputs)
}

fn combine_validated_tiff_pages(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    validated_inputs: &crate::output::ValidatedInputs,
) -> Result<()> {
    write_atomically(output_path, |output| {
        let mut writer = BufWriter::new(output);
        {
            let mut encoder = TiffEncoder::new(&mut writer)?;
            for (index, _input_path) in input_paths.iter().enumerate() {
                let page = read_first_tiff_rgba_page(validated_inputs.file(index)?, max_pixels)?;
                let mut image = encoder.new_image::<colortype::RGBA8>(page.width, page.height)?;
                image.resolution(ResolutionUnit::None, Rational { n: 1, d: 1 });
                image.write_data(&page.rgba)?;
            }
        }
        writer.flush()?;
        Ok(())
    })
}

fn read_first_tiff_rgba_page(file: File, max_pixels: u64) -> Result<RgbaTiffPage> {
    let mut decoder = Decoder::new(BufReader::new(file))?;
    let (width, height) = decoder.dimensions()?;
    assert_pixel_limit(width, height, max_pixels)?;
    let color_type = decoder.colortype()?;
    let decoded = decoder.read_image()?;
    let rgba = build_tiff_rgba_payload(width, height, color_type, decoded)?;

    Ok(RgbaTiffPage {
        width,
        height,
        rgba,
    })
}

fn build_tiff_rgba_payload(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    decoded: DecodingResult,
) -> Result<Vec<u8>> {
    let pixels = match decoded {
        DecodingResult::U8(pixels) => pixels,
        _ => {
            return Err("Only 8-bit TIFF samples are supported by the native TIFF fast path".into())
        }
    };
    let pixel_count = width as usize * height as usize;

    match color_type {
        TiffColorType::Gray(8) => {
            if pixels.len() != pixel_count {
                return Err(
                    "Decoded grayscale TIFF payload length does not match dimensions".into(),
                );
            }
            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for gray in pixels {
                rgba.extend_from_slice(&[gray, gray, gray, 255]);
            }
            Ok(rgba)
        }
        TiffColorType::GrayA(8) => {
            if pixels.len() != pixel_count * 2 {
                return Err(
                    "Decoded grayscale-alpha TIFF payload length does not match dimensions".into(),
                );
            }
            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for chunk in pixels.chunks_exact(2) {
                rgba.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            Ok(rgba)
        }
        TiffColorType::RGB(8) => {
            if pixels.len() != pixel_count * 3 {
                return Err("Decoded RGB TIFF payload length does not match dimensions".into());
            }
            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for chunk in pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
            Ok(rgba)
        }
        TiffColorType::RGBA(8) => {
            if pixels.len() != pixel_count * 4 {
                return Err("Decoded RGBA TIFF payload length does not match dimensions".into());
            }
            Ok(pixels)
        }
        _ => Err(
            format!("Unsupported TIFF color type for native TIFF fast path: {color_type:?}").into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs, process,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn reads_tiff_pages_for_pdf_with_resolution() {
        let input_path = temp_tiff_path("pdf-input");
        write_rgb_tiff(&input_path, 2, 1, &[255, 0, 0, 0, 255, 0], 300);

        let mut pages = Vec::new();
        visit_tiff_pdf_pages(&input_path, 1_000_000, None, 10, |page| {
            pages.push(page);
            Ok(())
        })
        .unwrap();

        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].width, 2);
        assert_eq!(pages[0].height, 1);
        assert_eq!(pages[0].dpi, 300);
        assert_eq!(pages[0].color_space, "DeviceRGB");
        match &pages[0].payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                assert!(!data.is_empty());
                assert!(decode_params.contains("/Colors 3"));
                assert!(decode_params.contains("/Columns 2"));
            }
            ImagePayload::Jpeg { .. } => panic!("expected flate payload"),
        }

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn combines_single_page_tiffs_as_rgba_output() {
        let first_path = temp_tiff_path("combine-first");
        let second_path = temp_tiff_path("combine-second");
        let output_path = temp_tiff_path("combine-output");
        write_rgb_tiff(&first_path, 1, 1, &[255, 0, 0], 72);
        write_rgb_tiff(&second_path, 1, 1, &[0, 255, 0], 72);
        fs::write(&output_path, b"old-output").unwrap();

        combine_tiff_pages(
            &[first_path.clone(), second_path.clone()],
            &output_path,
            1_000_000,
            10,
        )
        .unwrap();

        let file = File::open(&output_path).unwrap();
        let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
        assert_eq!(decoder.colortype().unwrap(), TiffColorType::RGBA(8));
        let first = decoder.read_image().unwrap();
        assert_eq!(decode_u8(first), vec![255, 0, 0, 255]);
        assert!(decoder.more_images());
        decoder.next_image().unwrap();
        let second = decoder.read_image().unwrap();
        assert_eq!(decode_u8(second), vec![0, 255, 0, 255]);
        assert!(!decoder.more_images());

        let _ = fs::remove_file(first_path);
        let _ = fs::remove_file(second_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn tiff_writer_decodes_validated_descriptor_after_path_becomes_output_alias() {
        let input_path = temp_tiff_path("descriptor-input");
        let displaced_path = temp_tiff_path("descriptor-original");
        let output_path = temp_tiff_path("descriptor-output");
        write_rgb_tiff(&input_path, 1, 1, &[17, 34, 51], 72);
        fs::write(&output_path, b"old-tiff-output").unwrap();
        let input_paths = vec![input_path.clone()];

        let validated_inputs = validate_output_inputs(&input_paths, &output_path).unwrap();
        fs::rename(&input_path, &displaced_path).unwrap();
        fs::hard_link(&output_path, &input_path).unwrap();

        combine_validated_tiff_pages(&input_paths, &output_path, 1_000_000, &validated_inputs)
            .unwrap();

        let mut decoder = Decoder::new(BufReader::new(File::open(&output_path).unwrap())).unwrap();
        assert_eq!(
            decode_u8(decoder.read_image().unwrap()),
            vec![17, 34, 51, 255]
        );
        assert_eq!(fs::read(&input_path).unwrap(), b"old-tiff-output");
        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(displaced_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn rejects_tiff_output_that_aliases_an_input_without_modifying_it() {
        let input_path = temp_tiff_path("same-input-output");
        write_rgb_tiff(&input_path, 1, 1, &[255, 0, 0], 72);
        let original = fs::read(&input_path).unwrap();

        let error = combine_tiff_pages(
            std::slice::from_ref(&input_path),
            &input_path,
            1_000_000,
            10,
        )
        .unwrap_err();

        assert!(error.to_string().contains("Output aliases an input"));
        assert_eq!(fs::read(&input_path).unwrap(), original);
        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn rejects_tiff_output_hardlink_to_input() {
        let input_path = temp_tiff_path("hardlink-input");
        let output_path = temp_tiff_path("hardlink-output");
        write_rgb_tiff(&input_path, 1, 1, &[255, 0, 0], 72);
        fs::hard_link(&input_path, &output_path).unwrap();
        let original = fs::read(&input_path).unwrap();

        let error = combine_tiff_pages(
            std::slice::from_ref(&input_path),
            &output_path,
            1_000_000,
            10,
        )
        .unwrap_err();

        assert!(error.to_string().contains("Output aliases an input"));
        assert_eq!(fs::read(&input_path).unwrap(), original);
        assert_eq!(fs::read(&output_path).unwrap(), original);
        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn keeps_existing_tiff_and_cleans_temporary_on_late_failure() {
        let valid_path = temp_tiff_path("atomic-valid");
        let invalid_path = temp_tiff_path("atomic-invalid");
        let output_path = temp_tiff_path("atomic-output");
        write_rgb_tiff(&valid_path, 1, 1, &[255, 0, 0], 72);
        fs::write(&invalid_path, b"invalid tiff").unwrap();
        fs::write(&output_path, b"existing-tiff-output").unwrap();

        let result = combine_tiff_pages(
            &[valid_path.clone(), invalid_path.clone()],
            &output_path,
            1_000_000,
            10,
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&output_path).unwrap(), b"existing-tiff-output");
        assert_no_sibling_temporary(&output_path);
        let _ = fs::remove_file(valid_path);
        let _ = fs::remove_file(invalid_path);
        let _ = fs::remove_file(output_path);
    }

    fn temp_tiff_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "evb-pdf-image-combine-{label}-{}-{nanos}.tiff",
            process::id()
        ))
    }

    fn write_rgb_tiff(path: &Path, width: u32, height: u32, pixels: &[u8], dpi: u32) {
        let file = File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        let mut image = encoder.new_image::<colortype::RGB8>(width, height).unwrap();
        image.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
        image.write_data(pixels).unwrap();
    }

    fn decode_u8(decoded: DecodingResult) -> Vec<u8> {
        match decoded {
            DecodingResult::U8(pixels) => pixels,
            _ => panic!("expected u8 pixels"),
        }
    }

    fn assert_no_sibling_temporary(output_path: &Path) {
        let marker = format!(
            ".{}.evb-tmp-",
            output_path.file_name().unwrap().to_string_lossy()
        );
        let leftovers: Vec<_> = fs::read_dir(output_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
            .collect();
        assert!(leftovers.is_empty(), "temporary output was not cleaned");
    }
}
