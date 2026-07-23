mod binary;
mod flate;
mod image;
mod jpeg;
mod netpbm;
mod pdf;
mod tiff_io;

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod wasm;

use std::{
    borrow::Cow,
    error::Error,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use evb_raster_io::{write_png, PixelBuffer};

use crate::{
    image::{
        assert_pixel_limit, read_image_page_from_bytes, read_image_page_from_file,
        visit_image_pages_from_bytes, visit_image_pages_from_file, PdfImageCompression,
    },
    netpbm::{is_rgb_data_grayscale, parse_netpbm, parse_pbm_p4},
    pdf::{
        write_pdf_to_writer, ImagePage, ImagePayload, LayeredImagePayload, LayeredPdfImage,
        LayeredPdfPage, MaskPdfPage, PdfWriter,
    },
    tiff_io::combine_tiff_pages,
};

pub use crate::{
    image::JpegSizeGuardrail,
    netpbm::{probe_netpbm_path, NetpbmProbe},
    pdf::PdfPageSize,
};

pub const DEFAULT_DPI: u32 = 72;
pub const DEFAULT_MAX_IMAGE_PIXELS: u64 = 80_000_000;
pub const DEFAULT_MAX_BILEVEL_PIXELS: u64 = 160_000_000;
pub(crate) const CM_PER_INCH: f64 = 2.54;
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[doc(hidden)]
pub fn fuzz_parse_jpeg(data: &[u8]) {
    let _ = jpeg::parse_jpeg_metadata(data);
}
#[doc(hidden)]
pub fn fuzz_parse_tiff(data: &[u8]) {
    let _ = tiff_io::read_tiff_pdf_pages_from_bytes(data, 80_000_000, None, 64);
}

#[doc(hidden)]
pub fn fuzz_parse_netpbm(data: &[u8]) {
    let _ = netpbm::parse_pbm_p4(data);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageCompression {
    Auto,
    Jpeg { quality: u8 },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ImageProcessing {
    #[default]
    None,
    DownscaleToPpi {
        ppi_cap: u16,
    },
}

pub struct ImageSpec<S> {
    pub source: S,
    pub compression: ImageCompression,
    pub processing: ImageProcessing,
    pub size_guardrail: Option<JpegSizeGuardrail>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FramePolicy {
    /// Legacy plain-image behavior: all TIFF frames become PDF pages.
    All,
    /// Mixed and layered behavior: the source must resolve to exactly one page.
    ExactlyOne,
}

pub enum PageSpec<S> {
    Image {
        page_size: Option<PdfPageSize>,
        image: ImageSpec<S>,
        frames: FramePolicy,
    },
    Layered {
        page_size: PdfPageSize,
        background: ImageSpec<S>,
        foreground_mask: S,
        foreground_color: Option<[u8; 3]>,
    },
    Mask {
        page_size: PdfPageSize,
        foreground_mask: S,
    },
}

impl<S> PageSpec<S> {
    #[doc(hidden)]
    pub fn map_sources<T, E>(
        self,
        mapper: &mut impl FnMut(S) -> std::result::Result<T, E>,
    ) -> std::result::Result<PageSpec<T>, E> {
        Ok(match self {
            Self::Image {
                page_size,
                image,
                frames,
            } => PageSpec::Image {
                page_size,
                image: image.map_source(mapper)?,
                frames,
            },
            Self::Layered {
                page_size,
                background,
                foreground_mask,
                foreground_color,
            } => PageSpec::Layered {
                page_size,
                background: background.map_source(mapper)?,
                foreground_mask: mapper(foreground_mask)?,
                foreground_color,
            },
            Self::Mask {
                page_size,
                foreground_mask,
            } => PageSpec::Mask {
                page_size,
                foreground_mask: mapper(foreground_mask)?,
            },
        })
    }
}
impl<S> ImageSpec<S> {
    fn map_source<T, E>(
        self,
        mapper: &mut impl FnMut(S) -> std::result::Result<T, E>,
    ) -> std::result::Result<ImageSpec<T>, E> {
        Ok(ImageSpec {
            source: mapper(self.source)?,
            compression: self.compression,
            processing: self.processing,
            size_guardrail: self.size_guardrail,
        })
    }
}

pub enum InputSource<'a> {
    File { label: PathBuf, file: File },
    Bytes { file_name: &'a str, data: &'a [u8] },
}

pub type PdfPageSpec<'a> = PageSpec<InputSource<'a>>;

pub struct PdfBuildOptions {
    pub default_dpi: Option<u32>,
    pub max_pages: usize,
    pub max_pixels: u64,
    pub max_bilevel_pixels: u64,
    pub max_total_pixels: u64,
    pub max_output_bytes: u64,
    pub max_tiff_frames: usize,
}

impl Default for PdfBuildOptions {
    fn default() -> Self {
        Self {
            default_dpi: None,
            max_pages: 500,
            max_pixels: DEFAULT_MAX_IMAGE_PIXELS,
            max_bilevel_pixels: DEFAULT_MAX_BILEVEL_PIXELS,
            max_total_pixels: 512_000_000,
            max_output_bytes: 512 * 1024 * 1024,
            max_tiff_frames: 250,
        }
    }
}

pub fn write_pdf<'a, W, I, P>(
    output: W,
    page_specs: I,
    options: &PdfBuildOptions,
    mut on_processed: P,
) -> Result<W>
where
    W: Write,
    I: IntoIterator<Item = PdfPageSpec<'a>>,
    P: FnMut(usize),
{
    let mut page_specs = page_specs.into_iter().peekable();
    if page_specs.peek().is_none() {
        return Err("At least one image input is required".into());
    }

    let output = OutputLimitWriter::new(output, options.max_output_bytes);
    let mut page_count = 0usize;
    let mut total_pixels = 0u64;
    let output = write_pdf_to_writer(output, |pdf| {
        for (index, spec) in page_specs.by_ref().enumerate() {
            match spec {
                PageSpec::Image {
                    page_size,
                    image,
                    frames,
                } => {
                    write_image_spec(
                        pdf,
                        page_size.as_ref(),
                        image,
                        frames,
                        options,
                        &mut page_count,
                        &mut total_pixels,
                    )?;
                }
                PageSpec::Layered {
                    page_size,
                    background,
                    foreground_mask,
                    foreground_color,
                } => {
                    page_count = next_page_count_with_limit(page_count, options.max_pages)?;
                    let background = read_exact_image(background, options, Some(page_size))?;
                    let foreground_mask = read_mask(foreground_mask, options.max_bilevel_pixels)?;
                    total_pixels = add_pixels_with_limit(
                        total_pixels,
                        image_pixels(&background),
                        options.max_total_pixels,
                    )?;
                    total_pixels = add_pixels_with_limit(
                        total_pixels,
                        mask_pixels(&foreground_mask),
                        options.max_total_pixels,
                    )?;
                    pdf.add_layered_page(&LayeredPdfPage {
                        page_size,
                        background: image_page_to_layered_image(background)?,
                        foreground_mask,
                        foreground_color,
                    })?;
                }
                PageSpec::Mask {
                    page_size,
                    foreground_mask,
                } => {
                    page_count = next_page_count_with_limit(page_count, options.max_pages)?;
                    let foreground_mask = read_mask(foreground_mask, options.max_bilevel_pixels)?;
                    total_pixels = add_pixels_with_limit(
                        total_pixels,
                        mask_pixels(&foreground_mask),
                        options.max_total_pixels,
                    )?;
                    pdf.add_mask_page(&MaskPdfPage {
                        page_size,
                        foreground_mask,
                    })?;
                }
            }
            on_processed(index + 1);
        }
        Ok(())
    })?;
    Ok(output.into_inner())
}

fn write_image_spec<W: Write>(
    pdf: &mut PdfWriter<W>,
    page_size: Option<&PdfPageSize>,
    image: ImageSpec<InputSource<'_>>,
    frames: FramePolicy,
    options: &PdfBuildOptions,
    page_count: &mut usize,
    total_pixels: &mut u64,
) -> Result<()> {
    let mut add_page = |page: ImagePage| {
        *page_count = next_page_count_with_limit(*page_count, options.max_pages)?;
        *total_pixels =
            add_pixels_with_limit(*total_pixels, image_pixels(&page), options.max_total_pixels)?;
        if let Some(page_size) = page_size {
            pdf.add_page_with_size(&page, page_size)
        } else {
            pdf.add_page(&page)
        }
    };

    match frames {
        FramePolicy::All
            if image.compression == ImageCompression::Auto
                && image.processing == ImageProcessing::None =>
        {
            visit_automatic_pages(image.source, options, &mut add_page)?;
        }
        FramePolicy::All => {
            add_page(read_processed_image(image, options, page_size.copied())?)?;
        }
        FramePolicy::ExactlyOne => {
            add_page(read_exact_image(image, options, page_size.copied())?)?;
        }
    }
    Ok(())
}

fn visit_automatic_pages(
    source: InputSource<'_>,
    options: &PdfBuildOptions,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    if source.is_pbm() {
        on_page(bilevel_image_page(read_mask(
            source,
            options.max_bilevel_pixels,
        )?)?)?;
        return Ok(1);
    }

    match source {
        InputSource::File { label, file } => visit_image_pages_from_file(
            &label,
            file,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            on_page,
        ),
        InputSource::Bytes { file_name, data } => visit_image_pages_from_bytes(
            file_name,
            data,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            on_page,
        ),
    }
}

fn read_exact_image(
    image: ImageSpec<InputSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    if image.compression != ImageCompression::Auto || image.processing != ImageProcessing::None {
        return read_processed_image(image, options, page_size);
    }

    let source_label = image.source.label();
    let mut first = None;
    let page_count = visit_automatic_pages(image.source, options, |page| {
        if first.is_none() {
            first = Some(page);
        }
        Ok(())
    })?;
    match (page_count, first) {
        (1, Some(page)) => Ok(page),
        (0, _) => Err(format!("No image pages found: {source_label}").into()),
        (count, _) => Err(format!(
            "Mixed PDF page images must contain exactly one page: {source_label} has {count}"
        )
        .into()),
    }
}

fn read_processed_image(
    image: ImageSpec<InputSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    let compression = PdfImageCompression::from(image.compression);
    match image.source {
        InputSource::File { label, file } => read_image_page_from_file(
            &label,
            file,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
        InputSource::Bytes { file_name, data } => read_image_page_from_bytes(
            file_name,
            data,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
    }
}

fn read_mask(source: InputSource<'_>, max_pixels: u64) -> Result<crate::netpbm::PbmP4Image> {
    let bytes = source.read_all()?;
    let mask = parse_pbm_p4(&bytes)?;
    assert_pixel_limit(mask.width, mask.height, max_pixels)?;
    Ok(mask)
}

impl<'a> InputSource<'a> {
    fn label(&self) -> String {
        match self {
            Self::File { label, .. } => label.display().to_string(),
            Self::Bytes { file_name, .. } => (*file_name).to_string(),
        }
    }

    fn is_pbm(&self) -> bool {
        let label = match self {
            Self::File { label, .. } => label.to_string_lossy(),
            Self::Bytes { file_name, .. } => Cow::Borrowed(*file_name),
        };
        label
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("pbm"))
    }

    fn read_all(self) -> Result<Cow<'a, [u8]>> {
        match self {
            Self::File { mut file, .. } => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                Ok(Cow::Owned(bytes))
            }
            Self::Bytes { data, .. } => Ok(Cow::Borrowed(data)),
        }
    }
}

impl From<ImageCompression> for PdfImageCompression {
    fn from(compression: ImageCompression) -> Self {
        match compression {
            ImageCompression::Auto => Self::Auto,
            ImageCompression::Jpeg { quality } => Self::Jpeg { quality },
        }
    }
}

struct OutputLimitWriter<W: Write> {
    inner: W,
    max_bytes: u64,
    written: u64,
}

impl<W: Write> OutputLimitWriter<W> {
    fn new(inner: W, max_bytes: u64) -> Self {
        Self {
            inner,
            max_bytes,
            written: 0,
        }
    }

    fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write> Write for OutputLimitWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let requested = u64::try_from(buffer.len()).unwrap_or(u64::MAX);
        if self.written.saturating_add(requested) > self.max_bytes {
            return Err(std::io::Error::other(
                "Combined PDF output exceeds the configured byte limit",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn next_page_count_with_limit(current: usize, max_pages: usize) -> Result<usize> {
    let next = current
        .checked_add(1)
        .ok_or("Combined PDF page count overflow")?;
    if next > max_pages {
        return Err(format!("Combined PDF is capped at {max_pages} pages").into());
    }
    Ok(next)
}

fn add_pixels_with_limit(current: u64, added: u64, max_total_pixels: u64) -> Result<u64> {
    let next = current
        .checked_add(added)
        .ok_or("Combined PDF aggregate pixel count overflow")?;
    if next > max_total_pixels {
        return Err(
            format!("Combined PDF aggregate pixels are capped at {max_total_pixels}").into(),
        );
    }
    Ok(next)
}

fn image_pixels(page: &ImagePage) -> u64 {
    u64::from(page.width) * u64::from(page.height)
}

fn mask_pixels(mask: &crate::netpbm::PbmP4Image) -> u64 {
    u64::from(mask.width) * u64::from(mask.height)
}

fn bilevel_image_page(mut image: crate::netpbm::PbmP4Image) -> Result<ImagePage> {
    if image.width % 8 != 0 {
        let used_bits = image.width % 8;
        let padding_mask = (1u8 << (8 - used_bits)) - 1;
        let last_byte = image.row_stride - 1;
        for row in image.bitmap.chunks_exact_mut(image.row_stride) {
            row[last_byte] &= !padding_mask;
        }
    }
    Ok(ImagePage {
        width: image.width,
        height: image.height,
        dpi: DEFAULT_DPI,
        color_space: "DeviceGray",
        icc_profile: None,
        payload: ImagePayload::Bilevel {
            bitmap: image.bitmap,
            row_stride: image.row_stride,
        },
    })
}

fn image_page_to_layered_image(page: ImagePage) -> Result<LayeredPdfImage> {
    let payload = match page.payload {
        ImagePayload::RawFlate {
            data,
            decode_params,
        } => LayeredImagePayload::RawFlate {
            data,
            decode_params,
        },
        ImagePayload::Jpeg { data } => LayeredImagePayload::Jpeg { data },
        ImagePayload::Bilevel { .. } => {
            return Err("Bilevel images cannot be layered PDF backgrounds".into())
        }
    };
    Ok(LayeredPdfImage {
        width: page.width,
        height: page.height,
        color_space: page.color_space,
        payload,
    })
}

pub fn encode_netpbm_path_as_png(
    input_path: &Path,
    output_path: &Path,
    max_pixels: u64,
) -> Result<()> {
    let validated_inputs = ValidatedInputFiles::open(&[input_path.to_path_buf()], output_path)?;
    let mut input = validated_inputs.clone_file(0)?;
    let mut data = Vec::new();
    input.read_to_end(&mut data)?;
    let netpbm = parse_netpbm(&data, max_pixels)?;
    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let mut channels = netpbm.channels as usize;
    let pixels = if channels == 3 && is_rgb_data_grayscale(netpbm.pixels, total_pixels) {
        channels = 1;
        Cow::Owned(
            netpbm
                .pixels
                .chunks_exact(3)
                .map(|pixel| pixel[0])
                .collect(),
        )
    } else {
        Cow::Borrowed(netpbm.pixels)
    };
    let buffer = match channels {
        1 => PixelBuffer::Gray {
            width: netpbm.width as usize,
            height: netpbm.height as usize,
            stride: netpbm.width as usize,
            data: &pixels,
        },
        3 => PixelBuffer::Rgb {
            width: netpbm.width as usize,
            height: netpbm.height as usize,
            stride: netpbm.width as usize * 3,
            data: &pixels,
        },
        _ => unreachable!("the Netpbm parser only returns gray or RGB pixels"),
    };
    let mut output = AtomicOutput::create(output_path)?;
    write_png(output.file_mut()?, buffer)?;
    output.publish()?;
    Ok(())
}

pub fn combine_tiff_paths(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
) -> Result<()> {
    combine_tiff_pages(input_paths, output_path, max_pixels, max_pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::{
        cell::RefCell,
        io::{Cursor, Error as IoError},
        rc::Rc,
    };
    use tiff::{
        encoder::{colortype, Rational, TiffEncoder},
        tags::ResolutionUnit,
    };

    const PAGE: PdfPageSize = PdfPageSize {
        width_points: 72.0,
        height_points: 36.0,
    };

    #[test]
    fn page_spec_golden_preserves_png_and_jpeg_icc_streams() {
        let profile = b"stage-3-equivalence-icc-profile";
        for (file_name, image, payload, color_space, components) in [
            {
                let (png, idat) = png_with_icc(0, &[0, 0x40], profile);
                ("gray.png", png, idat, "/DeviceGray", "/N 1")
            },
            {
                let (png, idat) = png_with_icc(2, &[0, 0x10, 0x20, 0x30], profile);
                ("rgb.png", png, idat, "/DeviceRGB", "/N 3")
            },
            {
                let jpeg = jpeg_with_icc(&[0x40], jpeg_encoder::ColorType::Luma, profile);
                ("gray.jpg", jpeg.clone(), jpeg, "/DeviceGray", "/N 1")
            },
            {
                let jpeg =
                    jpeg_with_icc(&[0x10, 0x20, 0x30], jpeg_encoder::ColorType::Rgb, profile);
                ("rgb.jpg", jpeg.clone(), jpeg, "/DeviceRGB", "/N 3")
            },
        ] {
            let pdf = write_pdf(
                Vec::new(),
                [image_page(
                    file_name,
                    &image,
                    Some(PAGE),
                    FramePolicy::ExactlyOne,
                )],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            let text = String::from_utf8_lossy(&pdf);
            assert!(text.contains(color_space));
            assert!(text.contains(components));
            assert!(text.contains("/Width 1 /Height 1"));
            assert!(text.contains("/MediaBox [0 0 72.0000 36.0000]"));
            assert!(contains_bytes(&pdf, profile));
            assert!(contains_bytes(&pdf, &payload));
        }
    }

    #[test]
    fn page_spec_golden_preserves_netpbm_auto_and_jpeg_modes() {
        for (file_name, data, colors) in [
            ("gray.pgm", b"P5\n4 1\n255\n\x10\x40\x80\xf0".as_slice(), 1),
            (
                "rgb.ppm",
                b"P6\n4 1\n255\n\x10\x20\x30\x40\x50\x60\x70\x80\x90\xd0\xe0\xf0".as_slice(),
                3,
            ),
        ] {
            let automatic = write_pdf(
                Vec::new(),
                [image_page(file_name, data, None, FramePolicy::All)],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            assert!(String::from_utf8_lossy(&automatic).contains(&format!(
                "/Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns 4"
            )));

            let jpeg = write_pdf(
                Vec::new(),
                [PageSpec::Image {
                    page_size: Some(PAGE),
                    image: ImageSpec {
                        source: InputSource::Bytes { file_name, data },
                        compression: ImageCompression::Jpeg { quality: 83 },
                        processing: ImageProcessing::DownscaleToPpi { ppi_cap: 2 },
                        size_guardrail: None,
                    },
                    frames: FramePolicy::ExactlyOne,
                }],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            let text = String::from_utf8_lossy(&jpeg);
            assert!(text.contains("/Filter /DCTDecode"));
            assert!(text.contains("/Width 2 /Height 1"));
            assert!(text.contains("/MediaBox [0 0 72.0000 36.0000]"));
        }
    }

    #[test]
    fn frame_policy_all_streams_tiff_frames_in_order_and_exactly_one_rejects() {
        let tiff = two_page_tiff();
        let mut progress = Vec::new();
        let pdf = write_pdf(
            Vec::new(),
            [image_page("two.tiff", &tiff, None, FramePolicy::All)],
            &PdfBuildOptions {
                max_pages: 10,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        let first = text.find("/Width 1 /Height 1").unwrap();
        let second = text.find("/Width 2 /Height 1").unwrap();
        assert!(first < second);
        assert_eq!(progress, vec![1]);

        let error = write_pdf(
            Vec::new(),
            [image_page(
                "two.tiff",
                &tiff,
                Some(PAGE),
                FramePolicy::ExactlyOne,
            )],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert!(error
            .to_string()
            .contains("must contain exactly one page: two.tiff has 2"));
    }

    #[test]
    fn layered_color_and_mask_only_specs_preserve_pdf_structure() {
        let background = b"P6\n1 1\n255\n\xf0\xf0\xf0";
        let mask = b"P4\n8 1\n\xc0";
        let pdf = write_pdf(
            Vec::new(),
            [
                PageSpec::Layered {
                    page_size: PAGE,
                    background: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "background.ppm",
                            data: background,
                        },
                        compression: ImageCompression::Jpeg { quality: 75 },
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    foreground_mask: InputSource::Bytes {
                        file_name: "mask.pbm",
                        data: mask,
                    },
                    foreground_color: Some([128, 16, 16]),
                },
                PageSpec::Mask {
                    page_size: PdfPageSize {
                        width_points: 144.0,
                        height_points: 72.0,
                    },
                    foreground_mask: InputSource::Bytes {
                        file_name: "mask.pbm",
                        data: mask,
                    },
                },
            ],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        assert_eq!(text.matches("/Filter /DCTDecode").count(), 1);
        assert_eq!(text.matches("/ImageMask true").count(), 2);
        assert!(text.contains("0.5020 0.0627 0.0627 rg"));
        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("1 g\n0 0 144.0000 72.0000 re f\n0 g\n"));
        assert!(text.contains("/FlateDecode") || text.contains("/CCITTFaxDecode"));
    }

    #[test]
    fn empty_request_keeps_legacy_error_category() {
        let empty = write_pdf(
            Vec::new(),
            std::iter::empty::<PdfPageSpec<'_>>(),
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(empty.to_string(), "At least one image input is required");
    }

    #[test]
    fn core_writes_incrementally_and_single_adapter_enforces_output_limit() {
        let state = Rc::new(RefCell::new(SinkState::default()));
        let sink = CountingSink {
            state: Rc::clone(&state),
            fail_after: Some(220),
        };
        let error = write_pdf(
            sink,
            [image_page(
                "page.ppm",
                b"P6\n2 1\n255\n\x10\x20\x30\x40\x50\x60",
                None,
                FramePolicy::All,
            )],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "counting sink limit");
        assert_eq!(state.borrow().bytes, 220);
        assert!(state.borrow().writes > 4);

        let state = Rc::new(RefCell::new(SinkState::default()));
        let sink = CountingSink {
            state: Rc::clone(&state),
            fail_after: None,
        };
        let error = write_pdf(
            sink,
            [image_page(
                "page.ppm",
                b"P6\n1 1\n255\n\x10\x20\x30",
                None,
                FramePolicy::All,
            )],
            &PdfBuildOptions {
                max_output_bytes: 64,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("configured byte limit"));
        assert!(state.borrow().bytes <= 64);
    }

    #[test]
    fn frame_visits_apply_page_and_pixel_limits_before_progress() {
        let tiff = two_page_tiff();
        for options in [
            PdfBuildOptions {
                max_pages: 1,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            PdfBuildOptions {
                max_total_pixels: 1,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            PdfBuildOptions {
                max_tiff_frames: 1,
                ..PdfBuildOptions::default()
            },
        ] {
            let mut progress = Vec::new();
            let error = write_pdf(
                Vec::new(),
                [image_page("two.tiff", &tiff, None, FramePolicy::All)],
                &options,
                |processed| progress.push(processed),
            )
            .unwrap_err();
            assert!(error.to_string().contains("capped at 1"), "{}", error);
            assert!(progress.is_empty());
        }
    }

    #[test]
    fn progress_fires_once_per_spec_not_per_tiff_frame() {
        let tiff = two_page_tiff();
        let mut progress = Vec::new();
        let pdf = write_pdf(
            Vec::new(),
            [
                image_page("two.tiff", &tiff, None, FramePolicy::All),
                image_page("page.pgm", b"P5\n1 1\n255\n\x80", None, FramePolicy::All),
            ],
            &PdfBuildOptions {
                max_pages: 10,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 3"));
        assert_eq!(progress, vec![1, 2]);
    }

    fn image_page<'a>(
        file_name: &'a str,
        data: &'a [u8],
        page_size: Option<PdfPageSize>,
        frames: FramePolicy,
    ) -> PdfPageSpec<'a> {
        PageSpec::Image {
            page_size,
            image: ImageSpec {
                source: InputSource::Bytes { file_name, data },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            frames,
        }
    }

    fn two_page_tiff() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut bytes)).unwrap();
            let mut first = encoder.new_image::<colortype::RGB8>(1, 1).unwrap();
            first.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            first.write_data(&[255, 0, 0]).unwrap();
            let mut second = encoder.new_image::<colortype::RGB8>(2, 1).unwrap();
            second.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            second.write_data(&[0, 255, 0, 0, 0, 255]).unwrap();
        }
        bytes
    }

    fn png_with_icc(color_type: u8, pixels: &[u8], profile: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
        let mut iccp = b"golden\0\0".to_vec();
        iccp.extend_from_slice(&zlib(profile));
        let idat = zlib(pixels);
        (
            [
                b"\x89PNG\r\n\x1a\n".as_slice(),
                &png_chunk(b"IHDR", &ihdr),
                &png_chunk(b"iCCP", &iccp),
                &png_chunk(b"IDAT", &idat),
                &png_chunk(b"IEND", b""),
            ]
            .concat(),
            idat,
        )
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        chunk
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn jpeg_with_icc(
        pixels: &[u8],
        color_type: jpeg_encoder::ColorType,
        profile: &[u8],
    ) -> Vec<u8> {
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 90)
            .encode(pixels, 1, 1, color_type)
            .unwrap();
        let mut segment = b"\xff\xe2".to_vec();
        let payload_len = b"ICC_PROFILE\0".len() + 2 + profile.len();
        segment.extend_from_slice(&u16::try_from(payload_len + 2).unwrap().to_be_bytes());
        segment.extend_from_slice(b"ICC_PROFILE\0");
        segment.extend_from_slice(&[1, 1]);
        segment.extend_from_slice(profile);
        jpeg.splice(2..2, segment);
        jpeg
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[derive(Default)]
    struct SinkState {
        bytes: usize,
        writes: usize,
    }

    struct CountingSink {
        state: Rc<RefCell<SinkState>>,
        fail_after: Option<usize>,
    }

    impl Write for CountingSink {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            let mut state = self.state.borrow_mut();
            let allowed = self
                .fail_after
                .map(|limit| limit.saturating_sub(state.bytes))
                .unwrap_or(buffer.len())
                .min(buffer.len());
            if allowed == 0 {
                return Err(IoError::other("counting sink limit"));
            }
            state.bytes += allowed;
            state.writes += 1;
            Ok(allowed)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
