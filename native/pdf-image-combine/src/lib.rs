mod binary;
mod flate;
mod image;
mod jpeg;
mod netpbm;
mod pdf;
mod png;
mod png_encode;
mod tiff_io;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod wasm;

use std::{
    error::Error,
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
};

use crate::{
    image::{
        assert_pixel_limit, read_image_page, read_image_page_from_bytes, read_image_pages,
        read_image_pages_from_bytes, visit_image_pages, PdfImageCompression,
    },
    netpbm::parse_pbm_p4,
    pdf::{
        build_layered_pdf_page, build_mask_pdf_page, build_pdf, write_pdf_to_writer, ImagePage,
        ImagePayload,
    },
    png_encode::encode_netpbm_file_as_png,
    tiff_io::combine_tiff_pages,
};

pub use crate::{
    image::JpegSizeGuardrail,
    netpbm::PbmP4Image,
    pdf::{LayeredImagePayload, LayeredPdfImage, LayeredPdfPage, MaskPdfPage, PdfPageSize},
};

pub const DEFAULT_DPI: u32 = 72;
pub(crate) const METERS_PER_INCH: f64 = 0.0254;
pub(crate) const CM_PER_INCH: f64 = 2.54;

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub struct ImageBytesInput<'a> {
    pub file_name: &'a str,
    pub data: &'a [u8],
}

pub struct ImageBytesPageInput<'a> {
    pub file_name: &'a str,
    pub data: &'a [u8],
    pub page_size: Option<PdfPageSize>,
    pub compression: MixedPdfImageCompression,
    pub image_processing: MixedPdfImageProcessing,
    pub size_guardrail: Option<JpegSizeGuardrail>,
}

pub struct PdfBuildOptions {
    pub default_dpi: Option<u32>,
    pub max_pages: usize,
    pub max_pixels: u64,
    pub max_tiff_frames: usize,
}

impl Default for PdfBuildOptions {
    fn default() -> Self {
        Self {
            default_dpi: None,
            max_pages: 500,
            max_pixels: 80_000_000,
            max_tiff_frames: 250,
        }
    }
}

pub enum MixedPdfPageSpec {
    FullImage {
        page_size: PdfPageSize,
        image_path: PathBuf,
        compression: MixedPdfImageCompression,
        image_processing: MixedPdfImageProcessing,
        size_guardrail: bool,
    },
    Layered {
        page_size: PdfPageSize,
        background_path: PathBuf,
        foreground_mask_path: PathBuf,
        foreground_color: Option<[u8; 3]>,
        background_compression: MixedPdfImageCompression,
        background_processing: MixedPdfImageProcessing,
        size_guardrail: bool,
    },
    MaskOnly {
        page_size: PdfPageSize,
        foreground_mask_path: PathBuf,
    },
}

pub enum MixedPdfBytesPageSpec<'a> {
    FullImage {
        page_size: PdfPageSize,
        image: ImageBytesInput<'a>,
        compression: MixedPdfImageCompression,
        image_processing: MixedPdfImageProcessing,
        size_guardrail: bool,
    },
    Layered {
        page_size: PdfPageSize,
        background: ImageBytesInput<'a>,
        foreground_mask: ImageBytesInput<'a>,
        foreground_color: Option<[u8; 3]>,
        background_compression: MixedPdfImageCompression,
        background_processing: MixedPdfImageProcessing,
        size_guardrail: bool,
    },
    MaskOnly {
        page_size: PdfPageSize,
        foreground_mask: ImageBytesInput<'a>,
    },
}

#[derive(Clone, Copy)]
pub enum MixedPdfImageCompression {
    Auto,
    Jpeg { quality: u8 },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MixedPdfImageProcessing {
    #[default]
    None,
    DownscaleToPpi {
        ppi_cap: u16,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MixedPdfMaskProcessing {
    #[default]
    None,
}

pub fn build_pdf_from_image_paths(
    input_paths: &[PathBuf],
    options: &PdfBuildOptions,
) -> Result<Vec<u8>> {
    build_pdf_from_image_paths_with_progress(input_paths, options, |_| {})
}

pub fn build_pdf_from_image_paths_with_progress(
    input_paths: &[PathBuf],
    options: &PdfBuildOptions,
    mut on_processed: impl FnMut(usize),
) -> Result<Vec<u8>> {
    let mut pages = Vec::with_capacity(input_paths.len());
    for (index, input_path) in input_paths.iter().enumerate() {
        let input_pages = read_image_pages(
            input_path,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
        )?;
        push_pages_with_limit(&mut pages, input_pages, options.max_pages)?;
        on_processed(index + 1);
    }

    build_pdf(&pages)
}

pub fn write_pdf_from_image_paths(
    input_paths: &[PathBuf],
    output_path: &Path,
    options: &PdfBuildOptions,
) -> Result<()> {
    write_pdf_from_image_paths_with_progress(input_paths, output_path, options, |_| {})
}

pub fn write_pdf_from_image_paths_with_progress(
    input_paths: &[PathBuf],
    output_path: &Path,
    options: &PdfBuildOptions,
    mut on_processed: impl FnMut(usize),
) -> Result<()> {
    let output = File::create(output_path)?;
    let writer = BufWriter::new(output);
    let mut page_count = 0;

    write_pdf_to_writer(writer, |pdf| {
        for (index, input_path) in input_paths.iter().enumerate() {
            visit_image_pages(
                input_path,
                options.max_pixels,
                options.default_dpi,
                options.max_tiff_frames,
                |page| {
                    page_count = next_page_count_with_limit(page_count, 1, options.max_pages)?;
                    pdf.add_page(&page)
                },
            )?;
            on_processed(index + 1);
        }
        Ok(())
    })?;

    Ok(())
}

pub fn build_pdf_from_image_bytes_inputs(
    inputs: &[ImageBytesInput<'_>],
    options: &PdfBuildOptions,
) -> Result<Vec<u8>> {
    build_pdf_from_image_bytes_inputs_with_progress(inputs, options, |_| {})
}

pub fn build_pdf_from_image_bytes_inputs_with_progress(
    inputs: &[ImageBytesInput<'_>],
    options: &PdfBuildOptions,
    mut on_processed: impl FnMut(usize),
) -> Result<Vec<u8>> {
    let mut pages = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        let input_pages = read_image_pages_from_bytes(
            input.file_name,
            input.data,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
        )?;
        push_pages_with_limit(&mut pages, input_pages, options.max_pages)?;
        on_processed(index + 1);
    }

    build_pdf(&pages)
}

pub fn build_pdf_from_image_bytes_page_inputs(
    inputs: &[ImageBytesPageInput<'_>],
    options: &PdfBuildOptions,
) -> Result<Vec<u8>> {
    build_pdf_from_image_bytes_page_inputs_with_progress(inputs, options, |_| {})
}

pub fn build_pdf_from_image_bytes_page_inputs_with_progress(
    inputs: &[ImageBytesPageInput<'_>],
    options: &PdfBuildOptions,
    mut on_processed: impl FnMut(usize),
) -> Result<Vec<u8>> {
    if inputs.is_empty() {
        return Err("At least one image input is required".into());
    }

    let mut page_count = 0usize;
    let output = Vec::new();
    let output = write_pdf_to_writer(output, |pdf| {
        for (index, input) in inputs.iter().enumerate() {
            if input.page_size.is_none()
                && matches!(input.compression, MixedPdfImageCompression::Auto)
                && matches!(input.image_processing, MixedPdfImageProcessing::None)
            {
                let pages = read_image_pages_from_bytes(
                    input.file_name,
                    input.data,
                    options.max_pixels,
                    options.default_dpi,
                    options.max_tiff_frames,
                )?;
                page_count =
                    next_page_count_with_limit(page_count, pages.len(), options.max_pages)?;
                for page in pages {
                    pdf.add_page(&page)?;
                }
                on_processed(index + 1);
                continue;
            }

            page_count = next_page_count_with_limit(page_count, 1, options.max_pages)?;
            let page = read_image_page_from_bytes(
                input.file_name,
                input.data,
                options.max_pixels,
                options.default_dpi,
                image_compression_to_reader(input.compression),
                input.image_processing,
                input.page_size,
                input.size_guardrail,
            )?;
            if let Some(page_size) = input.page_size.as_ref() {
                pdf.add_page_with_size(&page, page_size)?;
            } else {
                pdf.add_page(&page)?;
            }
            on_processed(index + 1);
        }
        Ok(())
    })?;

    Ok(output)
}

pub fn build_mixed_pdf_from_bytes_page_specs(
    page_specs: &[MixedPdfBytesPageSpec<'_>],
    options: &PdfBuildOptions,
) -> Result<Vec<u8>> {
    if page_specs.is_empty() {
        return Err("Mixed PDF byte request must contain at least one page".into());
    }
    next_page_count_with_limit(0, page_specs.len(), options.max_pages)?;

    let output = Vec::new();
    let output = write_pdf_to_writer(output, |pdf| {
        for (index, spec) in page_specs.iter().enumerate() {
            match spec {
                MixedPdfBytesPageSpec::FullImage {
                    page_size,
                    image,
                    compression,
                    image_processing,
                    size_guardrail,
                } => {
                    let page = read_single_image_page_from_bytes(
                        image,
                        options,
                        image_compression_to_reader(*compression),
                        *image_processing,
                        Some(*page_size),
                        guardrail_for_page(*size_guardrail, index + 1, false),
                    )?;
                    pdf.add_page_with_size(&page, page_size)?;
                }
                MixedPdfBytesPageSpec::Layered {
                    page_size,
                    background,
                    foreground_mask,
                    foreground_color,
                    background_compression,
                    background_processing,
                    size_guardrail,
                } => {
                    let background_page = read_single_image_page_from_bytes(
                        background,
                        options,
                        image_compression_to_reader(*background_compression),
                        *background_processing,
                        Some(*page_size),
                        guardrail_for_page(*size_guardrail, index + 1, false),
                    )?;
                    let foreground_mask = parse_pbm_p4(foreground_mask.data)?;
                    assert_pixel_limit(
                        foreground_mask.width,
                        foreground_mask.height,
                        options.max_pixels,
                    )?;
                    pdf.add_layered_page(&LayeredPdfPage {
                        page_size: *page_size,
                        background: image_page_to_layered_image(background_page),
                        foreground_mask,
                        foreground_color: *foreground_color,
                    })?;
                }
                MixedPdfBytesPageSpec::MaskOnly {
                    page_size,
                    foreground_mask,
                } => {
                    let foreground_mask = parse_pbm_p4(foreground_mask.data)?;
                    assert_pixel_limit(
                        foreground_mask.width,
                        foreground_mask.height,
                        options.max_pixels,
                    )?;
                    pdf.add_mask_page(&MaskPdfPage {
                        page_size: *page_size,
                        foreground_mask,
                    })?;
                }
            }
        }
        Ok(())
    })?;

    Ok(output)
}

pub fn parse_pbm_p4_mask(data: &[u8]) -> Result<PbmP4Image> {
    parse_pbm_p4(data)
}

pub fn build_layered_pdf_from_page(page: &LayeredPdfPage) -> Result<Vec<u8>> {
    build_layered_pdf_page(page)
}

pub fn build_mask_pdf_from_page(page: &MaskPdfPage) -> Result<Vec<u8>> {
    build_mask_pdf_page(page)
}

pub fn write_mixed_pdf_from_page_specs_with_progress(
    page_specs: &[MixedPdfPageSpec],
    output_path: &Path,
    options: &PdfBuildOptions,
    mut on_processed: impl FnMut(usize),
) -> Result<()> {
    if page_specs.is_empty() {
        return Err("Mixed PDF manifest must contain at least one page".into());
    }
    next_page_count_with_limit(0, page_specs.len(), options.max_pages)?;

    let output = File::create(output_path)?;
    let writer = BufWriter::new(output);

    write_pdf_to_writer(writer, |pdf| {
        for (index, spec) in page_specs.iter().enumerate() {
            match spec {
                MixedPdfPageSpec::FullImage {
                    page_size,
                    image_path,
                    compression,
                    image_processing,
                    size_guardrail,
                } => {
                    let page = read_single_image_page(
                        image_path,
                        options,
                        image_compression_to_reader(*compression),
                        *image_processing,
                        Some(*page_size),
                        guardrail_for_page(*size_guardrail, index + 1, true),
                    )?;
                    pdf.add_page_with_size(&page, page_size)?;
                }
                MixedPdfPageSpec::Layered {
                    page_size,
                    background_path,
                    foreground_mask_path,
                    foreground_color,
                    background_compression,
                    background_processing,
                    size_guardrail,
                } => {
                    let background = read_single_image_page(
                        background_path,
                        options,
                        image_compression_to_reader(*background_compression),
                        *background_processing,
                        Some(*page_size),
                        guardrail_for_page(*size_guardrail, index + 1, true),
                    )?;
                    let foreground_mask =
                        parse_processed_pbm_mask(foreground_mask_path, options.max_pixels)?;
                    assert_pixel_limit(
                        foreground_mask.width,
                        foreground_mask.height,
                        options.max_pixels,
                    )?;
                    pdf.add_layered_page(&LayeredPdfPage {
                        page_size: PdfPageSize {
                            width_points: page_size.width_points,
                            height_points: page_size.height_points,
                        },
                        background: image_page_to_layered_image(background),
                        foreground_mask,
                        foreground_color: *foreground_color,
                    })?;
                }
                MixedPdfPageSpec::MaskOnly {
                    page_size,
                    foreground_mask_path,
                } => {
                    let foreground_mask =
                        parse_processed_pbm_mask(foreground_mask_path, options.max_pixels)?;
                    assert_pixel_limit(
                        foreground_mask.width,
                        foreground_mask.height,
                        options.max_pixels,
                    )?;
                    pdf.add_mask_page(&MaskPdfPage {
                        page_size: PdfPageSize {
                            width_points: page_size.width_points,
                            height_points: page_size.height_points,
                        },
                        foreground_mask,
                    })?;
                }
            }
            on_processed(index + 1);
        }
        Ok(())
    })?;

    Ok(())
}

pub fn encode_netpbm_path_as_png(input_path: &Path, output_path: &Path) -> Result<()> {
    encode_netpbm_file_as_png(input_path, output_path)
}

pub fn combine_tiff_paths(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
) -> Result<()> {
    combine_tiff_pages(input_paths, output_path, max_pixels, max_pages)
}

fn push_pages_with_limit(
    pages: &mut Vec<pdf::ImagePage>,
    input_pages: Vec<pdf::ImagePage>,
    max_pages: usize,
) -> Result<()> {
    next_page_count_with_limit(pages.len(), input_pages.len(), max_pages)?;
    pages.extend(input_pages);
    Ok(())
}

fn next_page_count_with_limit(
    current_pages: usize,
    added_pages: usize,
    max_pages: usize,
) -> Result<usize> {
    let next_pages = current_pages
        .checked_add(added_pages)
        .ok_or("Combined PDF page count overflow")?;
    if next_pages > max_pages {
        return Err(format!("Combined PDF is capped at {max_pages} pages").into());
    }
    Ok(next_pages)
}

fn guardrail_for_page(
    enabled: bool,
    page: usize,
    log_json_progress: bool,
) -> Option<JpegSizeGuardrail> {
    enabled.then_some(JpegSizeGuardrail {
        page,
        log_json_progress,
    })
}

fn read_single_image_page(
    input_path: &Path,
    options: &PdfBuildOptions,
    compression: PdfImageCompression,
    processing: MixedPdfImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
) -> Result<ImagePage> {
    if !matches!(compression, PdfImageCompression::Auto) {
        return read_image_page(
            input_path,
            options.max_pixels,
            options.default_dpi,
            compression,
            processing,
            page_size,
            size_guardrail,
        );
    }

    let pages = read_image_pages(
        input_path,
        options.max_pixels,
        options.default_dpi,
        options.max_tiff_frames,
    )?;
    match pages.len() {
        1 => pages
            .into_iter()
            .next()
            .ok_or_else(|| format!("No image pages found: {}", input_path.display()).into()),
        0 => Err(format!("No image pages found: {}", input_path.display()).into()),
        page_count => Err(format!(
            "Mixed PDF page images must contain exactly one page: {} has {page_count}",
            input_path.display()
        )
        .into()),
    }
}

fn read_single_image_page_from_bytes(
    input: &ImageBytesInput<'_>,
    options: &PdfBuildOptions,
    compression: PdfImageCompression,
    processing: MixedPdfImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
) -> Result<ImagePage> {
    if !matches!(compression, PdfImageCompression::Auto)
        || !matches!(processing, MixedPdfImageProcessing::None)
    {
        return read_image_page_from_bytes(
            input.file_name,
            input.data,
            options.max_pixels,
            options.default_dpi,
            compression,
            processing,
            page_size,
            size_guardrail,
        );
    }

    let pages = read_image_pages_from_bytes(
        input.file_name,
        input.data,
        options.max_pixels,
        options.default_dpi,
        options.max_tiff_frames,
    )?;
    match pages.len() {
        1 => pages
            .into_iter()
            .next()
            .ok_or_else(|| format!("No image pages found: {}", input.file_name).into()),
        0 => Err(format!("No image pages found: {}", input.file_name).into()),
        page_count => Err(format!(
            "Mixed PDF page images must contain exactly one page: {} has {page_count}",
            input.file_name
        )
        .into()),
    }
}

fn parse_processed_pbm_mask(input_path: &Path, max_pixels: u64) -> Result<PbmP4Image> {
    let foreground_mask = parse_pbm_p4(&fs::read(input_path)?)?;
    assert_pixel_limit(foreground_mask.width, foreground_mask.height, max_pixels)?;
    Ok(foreground_mask)
}

fn image_compression_to_reader(compression: MixedPdfImageCompression) -> PdfImageCompression {
    match compression {
        MixedPdfImageCompression::Auto => PdfImageCompression::Auto,
        MixedPdfImageCompression::Jpeg { quality } => PdfImageCompression::Jpeg { quality },
    }
}

fn image_page_to_layered_image(page: ImagePage) -> LayeredPdfImage {
    LayeredPdfImage {
        width: page.width,
        height: page.height,
        color_space: page.color_space,
        payload: match page.payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => LayeredImagePayload::RawFlate {
                data,
                decode_params,
            },
            ImagePayload::Jpeg { data } => LayeredImagePayload::Jpeg { data },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::{
        env, fs,
        io::{BufWriter, Write},
        path::Path,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tiff::{
        encoder::{colortype, Rational, TiffEncoder},
        tags::ResolutionUnit,
    };

    #[test]
    fn builds_pdf_from_png_bytes() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);

        let idat = zlib_bytes(&[0, 0, 0, 0]);
        let png = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            &png_chunk(b"IHDR", &ihdr),
            &png_chunk(b"IDAT", &idat),
            &png_chunk(b"IEND", b""),
        ]
        .concat();

        let pdf = build_pdf_from_image_bytes_inputs(
            &[ImageBytesInput {
                file_name: "page.png",
                data: &png,
            }],
            &PdfBuildOptions::default(),
        )
        .unwrap();

        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf
            .windows(b"/Subtype /Image".len())
            .any(|window| window == b"/Subtype /Image"));
    }

    #[test]
    fn writes_pdf_from_image_paths_to_output_file() {
        let first_path = temp_path("stream-first").with_extension("ppm");
        let second_path = temp_path("stream-second").with_extension("ppm");
        let output_path = temp_path("stream-output").with_extension("pdf");

        fs::write(&first_path, b"P6\n1 1\n255\n\xff\0\0").unwrap();
        fs::write(&second_path, b"P6\n1 1\n255\n\0\xff\0").unwrap();

        let mut progress = Vec::new();
        write_pdf_from_image_paths_with_progress(
            &[first_path.clone(), second_path.clone()],
            &output_path,
            &PdfBuildOptions {
                default_dpi: Some(72),
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();

        let pdf = fs::read(&output_path).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf
            .windows(b"/Count 2".len())
            .any(|window| window == b"/Count 2"));
        assert!(pdf
            .windows(b"/XObject".len())
            .any(|window| window == b"/XObject"));
        assert_eq!(progress, vec![1, 2]);

        let _ = fs::remove_file(first_path);
        let _ = fs::remove_file(second_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn writes_multi_page_tiff_to_pdf_output_file() {
        let input_path = temp_path("stream-tiff").with_extension("tiff");
        let output_path = temp_path("stream-tiff-output").with_extension("pdf");
        write_two_page_rgb_tiff(&input_path);

        let mut progress = Vec::new();
        write_pdf_from_image_paths_with_progress(
            &[input_path.clone()],
            &output_path,
            &PdfBuildOptions {
                default_dpi: Some(72),
                max_pages: 10,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();

        let pdf = fs::read(&output_path).unwrap();
        assert!(pdf
            .windows(b"/Count 2".len())
            .any(|window| window == b"/Count 2"));
        assert_eq!(progress, vec![1]);

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn builds_layered_pdf_from_public_page_api() {
        let mask = parse_pbm_p4_mask(b"P4\n8 1\n\x80").unwrap();
        let pdf = build_layered_pdf_from_page(&LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 72.0,
                height_points: 72.0,
            },
            background: LayeredPdfImage {
                width: 1,
                height: 1,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::RawFlate {
                    data: zlib_bytes(&[0]),
                    decode_params: "<< /Predictor 1 /Colors 1 /BitsPerComponent 8 /Columns 1 >>"
                        .to_string(),
                },
            },
            foreground_mask: mask,
            foreground_color: None,
        })
        .unwrap();

        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf
            .windows(b"/ImageMask true".len())
            .any(|window| window == b"/ImageMask true"));
    }

    #[test]
    fn writes_mixed_layered_and_full_image_pdf_pages() {
        let background_path = temp_path("mixed-background").with_extension("ppm");
        let mask_path = temp_path("mixed-mask").with_extension("pbm");
        let fallback_path = temp_path("mixed-fallback").with_extension("ppm");
        let output_path = temp_path("mixed-output").with_extension("pdf");

        fs::write(&background_path, b"P6\n1 1\n255\n\xf8\xf8\xf8").unwrap();
        fs::write(&mask_path, b"P4\n8 1\n\x80").unwrap();
        fs::write(&fallback_path, b"P6\n1 1\n255\n\x40\x50\x60").unwrap();

        let mut progress = Vec::new();
        write_mixed_pdf_from_page_specs_with_progress(
            &[
                MixedPdfPageSpec::Layered {
                    page_size: PdfPageSize {
                        width_points: 72.0,
                        height_points: 72.0,
                    },
                    background_path: background_path.clone(),
                    foreground_mask_path: mask_path.clone(),
                    foreground_color: None,
                    background_compression: MixedPdfImageCompression::Auto,
                    background_processing: MixedPdfImageProcessing::None,
                    size_guardrail: false,
                },
                MixedPdfPageSpec::FullImage {
                    page_size: PdfPageSize {
                        width_points: 144.0,
                        height_points: 72.0,
                    },
                    image_path: fallback_path.clone(),
                    compression: MixedPdfImageCompression::Auto,
                    image_processing: MixedPdfImageProcessing::None,
                    size_guardrail: false,
                },
            ],
            &output_path,
            &PdfBuildOptions {
                default_dpi: Some(72),
                max_pages: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();

        let pdf = fs::read(&output_path).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        assert!(text.contains("/ImageMask true"));
        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(!text.contains("/JBIG2Decode"));
        assert_eq!(progress, vec![1, 2]);

        let _ = fs::remove_file(background_path);
        let _ = fs::remove_file(mask_path);
        let _ = fs::remove_file(fallback_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn writes_mixed_mask_only_and_jpeg_pdf_pages() {
        let mask_path = temp_path("mixed-mask-only").with_extension("pbm");
        let fallback_path = temp_path("mixed-jpeg-fallback").with_extension("jpg");
        let output_path = temp_path("mixed-mask-jpeg-output").with_extension("pdf");

        fs::write(&mask_path, b"P4\n8 1\n\x80").unwrap();
        fs::write(&fallback_path, minimal_jpeg()).unwrap();

        let mut progress = Vec::new();
        write_mixed_pdf_from_page_specs_with_progress(
            &[
                MixedPdfPageSpec::MaskOnly {
                    page_size: PdfPageSize {
                        width_points: 72.0,
                        height_points: 72.0,
                    },
                    foreground_mask_path: mask_path.clone(),
                },
                MixedPdfPageSpec::FullImage {
                    page_size: PdfPageSize {
                        width_points: 144.0,
                        height_points: 72.0,
                    },
                    image_path: fallback_path.clone(),
                    compression: MixedPdfImageCompression::Auto,
                    image_processing: MixedPdfImageProcessing::None,
                    size_guardrail: false,
                },
            ],
            &output_path,
            &PdfBuildOptions {
                default_dpi: Some(72),
                max_pages: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();

        let pdf = fs::read(&output_path).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        assert!(text.contains("/ImageMask true"));
        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("1 g\n0 0 72.0000 72.0000 re f\n0 g\n"));
        assert_eq!(progress, vec![1, 2]);

        let _ = fs::remove_file(mask_path);
        let _ = fs::remove_file(fallback_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn writes_mixed_layered_color_page_with_foreground_mask() {
        let background_path = temp_path("mixed-layered-color-background").with_extension("ppm");
        let mask_path = temp_path("mixed-layered-color-mask").with_extension("pbm");
        let output_path = temp_path("mixed-layered-color-output").with_extension("pdf");

        fs::write(&background_path, b"P6\n1 1\n255\n\xf0\xf0\xf0").unwrap();
        fs::write(&mask_path, b"P4\n8 1\n\xc0").unwrap();

        write_mixed_pdf_from_page_specs_with_progress(
            &[MixedPdfPageSpec::Layered {
                page_size: PdfPageSize {
                    width_points: 72.0,
                    height_points: 72.0,
                },
                background_path: background_path.clone(),
                foreground_mask_path: mask_path.clone(),
                foreground_color: Some([128, 16, 16]),
                background_compression: MixedPdfImageCompression::Jpeg { quality: 75 },
                background_processing: MixedPdfImageProcessing::None,
                size_guardrail: false,
            }],
            &output_path,
            &PdfBuildOptions {
                default_dpi: Some(72),
                max_pages: 10,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();

        let pdf = fs::read(&output_path).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert_eq!(text.matches("/Filter /DCTDecode").count(), 1);
        assert!(text.contains("/ImageMask true"));
        assert!(text.contains("0.5020 0.0627 0.0627 rg"));
        assert!(!text.contains("/Mask "));

        let _ = fs::remove_file(background_path);
        let _ = fs::remove_file(mask_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn builds_pdf_from_downscaled_netpbm_byte_input_with_page_size() {
        let pdf = build_pdf_from_image_bytes_page_inputs(
            &[ImageBytesPageInput {
                file_name: "scan.pgm",
                data: b"P5\n4 4\n255\n\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0",
                page_size: Some(PdfPageSize {
                    width_points: 72.0,
                    height_points: 72.0,
                }),
                compression: MixedPdfImageCompression::Jpeg { quality: 75 },
                image_processing: MixedPdfImageProcessing::DownscaleToPpi { ppi_cap: 2 },
                size_guardrail: None,
            }],
            &PdfBuildOptions {
                default_dpi: Some(72),
                max_pages: 10,
                ..PdfBuildOptions::default()
            },
        )
        .unwrap();

        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 72.0000 72.0000]"));
        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("/Width 2"));
        assert!(text.contains("/Height 2"));
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

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "evb-pdf-image-combine-{label}-{}-{nanos}",
            process::id()
        ))
    }

    fn write_two_page_rgb_tiff(path: &Path) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        let mut first = encoder.new_image::<colortype::RGB8>(1, 1).unwrap();
        first.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
        first.write_data(&[255, 0, 0]).unwrap();
        let mut second = encoder.new_image::<colortype::RGB8>(1, 1).unwrap();
        second.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
        second.write_data(&[0, 255, 0]).unwrap();
    }

    fn minimal_jpeg() -> Vec<u8> {
        vec![
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 1, 0, 72, 0, 72,
            0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9,
        ]
    }
}
