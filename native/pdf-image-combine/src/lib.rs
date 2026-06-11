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
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
};

use crate::{
    image::{read_image_pages, read_image_pages_from_bytes, visit_image_pages},
    pdf::{build_pdf, write_pdf_to_writer},
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        io::BufWriter,
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

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        chunk
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
}
