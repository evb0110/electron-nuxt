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
    path::{Path, PathBuf},
};

use crate::{
    image::{read_image_pages, read_image_pages_from_bytes},
    pdf::build_pdf,
    png_encode::encode_netpbm_file_as_png,
    tiff_io::combine_tiff_pages,
};

pub const DEFAULT_DPI: u32 = 72;
pub(crate) const METERS_PER_INCH: f64 = 0.0254;
pub(crate) const CM_PER_INCH: f64 = 2.54;

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub struct ImageBytesInput<'a> {
    pub file_name: &'a str,
    pub data: &'a [u8],
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
    if pages.len() + input_pages.len() > max_pages {
        return Err(format!("Combined PDF is capped at {max_pages} pages").into());
    }
    pages.extend(input_pages);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_pdf_from_png_bytes() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);

        let png = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            &png_chunk(b"IHDR", &ihdr),
            &png_chunk(b"IDAT", b"x\x9cc``\0\0\0\x04\0\x01"),
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
        assert!(pdf.windows(b"/Subtype /Image".len()).any(|window| window == b"/Subtype /Image"));
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
