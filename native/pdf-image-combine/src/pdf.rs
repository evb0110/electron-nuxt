use fax::{encoder::Encoder as FaxEncoder, slice_bits, Color, VecWriter};
use flate2::{write::ZlibEncoder, Compression};
use jbig2_codec::Bilevel;
use std::{fmt::Write as FmtWrite, io::Write as IoWrite};

use crate::{netpbm::PbmP4Image, Result};

pub(crate) enum ImagePayload {
    RawFlate {
        data: Vec<u8>,
        decode_params: String,
    },
    Jpeg {
        data: Vec<u8>,
    },
    Bilevel {
        bitmap: Vec<u8>,
        row_stride: usize,
    },
}

pub(crate) struct ImagePage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) dpi: u32,
    pub(crate) color_space: &'static str,
    pub(crate) icc_profile: Option<Vec<u8>>,
    pub(crate) payload: ImagePayload,
}

#[derive(Clone, Copy)]
pub struct PdfPageSize {
    pub width_points: f64,
    pub height_points: f64,
}

pub enum LayeredImagePayload {
    RawFlate {
        data: Vec<u8>,
        decode_params: String,
    },
    Jpeg {
        data: Vec<u8>,
    },
}

pub struct LayeredPdfImage {
    pub width: u32,
    pub height: u32,
    pub color_space: &'static str,
    pub payload: LayeredImagePayload,
}

pub struct LayeredPdfPage {
    pub page_size: PdfPageSize,
    pub background: LayeredPdfImage,
    pub foreground_mask: PbmP4Image,
    pub foreground_color: Option<[u8; 3]>,
}

pub struct MaskPdfPage {
    pub page_size: PdfPageSize,
    pub foreground_mask: PbmP4Image,
}

#[cfg(test)]
pub(crate) fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    for page in pages {
        writer.add_page(page)?;
    }
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_layered_pdf_page(page: &LayeredPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    writer.add_layered_page(page)?;
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_mask_pdf_page(page: &MaskPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    writer.add_mask_page(page)?;
    writer.finish()
}

pub(crate) fn write_pdf_to_writer<W: IoWrite>(
    writer: W,
    mut write_pages: impl FnMut(&mut PdfWriter<W>) -> Result<()>,
) -> Result<W> {
    let mut writer = PdfWriter::new(writer)?;
    write_pages(&mut writer)?;
    writer.finish()
}

pub(crate) struct PdfWriter<W: IoWrite> {
    inner: W,
    offsets: Vec<Option<usize>>,
    page_objects: Vec<usize>,
    next_object: usize,
    bytes_written: usize,
}

impl<W: IoWrite> PdfWriter<W> {
    fn new(inner: W) -> Result<Self> {
        let mut writer = Self {
            inner,
            offsets: Vec::new(),
            page_objects: Vec::new(),
            next_object: 3,
            bytes_written: 0,
        };

        writer.write_all(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
        writer.push_object(1, b"<< /Type /Catalog /Pages 2 0 R >>")?;
        Ok(writer)
    }

    pub(crate) fn add_page(&mut self, page: &ImagePage) -> Result<()> {
        self.add_image_page(page, None)
    }

    pub(crate) fn add_page_with_size(
        &mut self,
        page: &ImagePage,
        page_size: &PdfPageSize,
    ) -> Result<()> {
        self.add_image_page(page, Some(page_size))
    }

    fn add_image_page(&mut self, page: &ImagePage, page_size: Option<&PdfPageSize>) -> Result<()> {
        if let Some(size) = page_size {
            validate_page_size(size)?;
        }
        let page_object = self.next_object;
        let image_object = page_object + 1;
        let content_object = page_object + 2;
        let icc_object = page.icc_profile.as_ref().map(|_| page_object + 3);
        self.next_object += if icc_object.is_some() { 4 } else { 3 };
        self.page_objects.push(page_object);

        let image_name = format!("Im{}", self.page_objects.len());
        let page_width = page_size
            .map(|size| size.width_points)
            .unwrap_or_else(|| points(page.width, page.dpi));
        let page_height = page_size
            .map(|size| size.height_points)
            .unwrap_or_else(|| points(page.height, page.dpi));
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width, page_height, image_name, image_object, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.push_image_object(image_object, page, icc_object)?;
        if let (Some(object_number), Some(profile)) = (icc_object, page.icc_profile.as_ref()) {
            let components = if page.color_space == "DeviceGray" {
                1
            } else {
                3
            };
            let dict = format!(
                "<< /N {} /Alternate /{} /Length {} >>",
                components,
                page.color_space,
                profile.len()
            );
            self.push_stream_object(object_number, dict.as_bytes(), profile)?;
        }

        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, image_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_layered_page(&mut self, page: &LayeredPdfPage) -> Result<()> {
        validate_page_size(&page.page_size)?;
        let page_object = self.next_object;
        let background_object = page_object + 1;
        let mask_object = page_object + 2;
        let content_object = page_object + 3;
        self.next_object = content_object + 1;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let background_name = format!("Bg{page_index}");
        let mask_name = format!("FgMask{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let xobjects = format!(
            "/{} {} 0 R /{} {} 0 R",
            background_name, background_object, mask_name, mask_object
        );
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << {} >> >> /Contents {} 0 R >>",
            page_width, page_height, xobjects, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.push_layered_image_object(background_object, &page.background)?;
        self.push_image_mask_object(mask_object, &page.foreground_mask)?;

        let foreground_fill = if let Some([red, green, blue]) = page.foreground_color {
            format!(
                "{:.4} {:.4} {:.4} rg\n",
                f64::from(red) / 255.0,
                f64::from(green) / 255.0,
                f64::from(blue) / 255.0
            )
        } else {
            "0 g\n".to_string()
        };
        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n{}q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width,
            page_height,
            background_name,
            foreground_fill,
            page_width,
            page_height,
            mask_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_mask_page(&mut self, page: &MaskPdfPage) -> Result<()> {
        validate_page_size(&page.page_size)?;
        let page_object = self.next_object;
        let mask_object = page_object + 1;
        let content_object = page_object + 2;
        self.next_object += 3;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let mask_name = format!("FgMask{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width, page_height, mask_name, mask_object, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.push_image_mask_object(mask_object, &page.foreground_mask)?;

        let content_stream = format!(
            "1 g\n0 0 {:.4} {:.4} re f\n0 g\nq {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, page_width, page_height, mask_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    fn finish(mut self) -> Result<W> {
        let mut kids = String::new();
        for page_object in &self.page_objects {
            let _ = write!(kids, "{page_object} 0 R ");
        }
        let pages_body = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.trim_end(),
            self.page_objects.len()
        );
        self.push_object(2, pages_body.as_bytes())?;

        let object_count = self.next_object - 1;
        let xref_offset = self.bytes_written;
        writeln!(&mut self, "xref")?;
        writeln!(&mut self, "0 {}", object_count + 1)?;
        writeln!(&mut self, "0000000000 65535 f ")?;
        for object_number in 1..=object_count {
            let offset = self
                .offsets
                .get(object_number)
                .and_then(|offset| *offset)
                .ok_or_else(|| format!("Missing PDF object offset: {object_number}"))?;
            writeln!(&mut self, "{offset:010} 00000 n ")?;
        }
        write!(
            &mut self,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            object_count + 1,
            xref_offset
        )?;
        self.flush()?;

        Ok(self.inner)
    }

    fn push_image_object(
        &mut self,
        object_number: usize,
        page: &ImagePage,
        icc_object: Option<usize>,
    ) -> Result<()> {
        self.push_color_image_stream(
            object_number,
            page.width,
            page.height,
            page.color_space,
            icc_object,
            ColorImagePayloadRef::from(&page.payload),
        )
    }

    fn push_layered_image_object(
        &mut self,
        object_number: usize,
        image: &LayeredPdfImage,
    ) -> Result<()> {
        self.push_color_image_stream(
            object_number,
            image.width,
            image.height,
            image.color_space,
            None,
            ColorImagePayloadRef::from(&image.payload),
        )
    }

    fn push_color_image_stream(
        &mut self,
        object_number: usize,
        width: u32,
        height: u32,
        color_space: &str,
        icc_object: Option<usize>,
        payload: ColorImagePayloadRef<'_>,
    ) -> Result<()> {
        let color_space_value = icc_object
            .map(|object| format!("[/ICCBased {object} 0 R]"))
            .unwrap_or_else(|| format!("/{color_space}"));
        match payload {
            ColorImagePayloadRef::RawFlate {
                data,
                decode_params,
            } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms {} /Length {} >>",
                    width,
                    height,
                    color_space_value,
                    decode_params,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ColorImagePayloadRef::Jpeg { data } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                    width,
                    height,
                    color_space_value,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ColorImagePayloadRef::Bilevel { bitmap, row_stride } => {
                let payload = encode_bilevel_payload(width, height, row_stride, bitmap)?;
                let dict = bilevel_image_dictionary(width, height, &payload);
                self.push_stream_object(object_number, dict.as_bytes(), payload.data())
            }
        }
    }

    fn push_image_mask_object(&mut self, object_number: usize, mask: &PbmP4Image) -> Result<()> {
        validate_image_mask(mask)?;
        let payload = encode_mask_payload(mask)?;
        let dict = image_mask_dictionary(mask.width, mask.height, &payload);
        self.push_stream_object(object_number, dict.as_bytes(), payload.data())
    }

    fn push_object(&mut self, object_number: usize, body: &[u8]) -> Result<()> {
        self.record_object_offset(object_number);
        writeln!(self, "{object_number} 0 obj")?;
        self.write_all(body)?;
        self.write_all(b"\nendobj\n")?;
        Ok(())
    }

    fn push_stream_object(
        &mut self,
        object_number: usize,
        dict: &[u8],
        stream: &[u8],
    ) -> Result<()> {
        self.record_object_offset(object_number);
        writeln!(self, "{object_number} 0 obj")?;
        self.write_all(dict)?;
        self.write_all(b"\nstream\n")?;
        self.write_all(stream)?;
        self.write_all(b"\nendstream\nendobj\n")?;
        Ok(())
    }

    fn record_object_offset(&mut self, object_number: usize) {
        if self.offsets.len() <= object_number {
            self.offsets.resize(object_number + 1, None);
        }
        self.offsets[object_number] = Some(self.bytes_written);
    }
}

impl<W: IoWrite> IoWrite for PdfWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes_written += written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn points(pixels: u32, dpi: u32) -> f64 {
    pixels as f64 / dpi.max(1) as f64 * 72.0
}

fn validate_page_size(size: &PdfPageSize) -> Result<()> {
    if !size.width_points.is_finite()
        || !size.height_points.is_finite()
        || size.width_points <= 0.0
        || size.height_points <= 0.0
    {
        return Err("Layered PDF page size must be finite positive points".into());
    }
    Ok(())
}

fn validate_image_mask(mask: &PbmP4Image) -> Result<()> {
    if mask.width == 0 || mask.height == 0 {
        return Err("Layered PDF image mask dimensions must be positive".into());
    }
    let expected_stride = (mask.width as usize)
        .checked_add(7)
        .ok_or("Invalid layered PDF image mask row stride")?
        / 8;
    if mask.row_stride != expected_stride {
        return Err(format!(
            "Invalid layered PDF image mask row stride: expected {expected_stride}, got {}",
            mask.row_stride
        )
        .into());
    }
    let expected_len = expected_stride
        .checked_mul(mask.height as usize)
        .ok_or("Invalid layered PDF image mask payload size")?;
    if mask.bitmap.len() != expected_len {
        return Err(format!(
            "Invalid layered PDF image mask payload size: expected {expected_len}, got {}",
            mask.bitmap.len()
        )
        .into());
    }
    Ok(())
}

fn deflate_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

#[derive(Debug, Eq, PartialEq)]
enum BilevelPayload {
    Jbig2(Vec<u8>),
    CcittG4(Vec<u8>),
    Flate(Vec<u8>),
}

impl BilevelPayload {
    fn data(&self) -> &[u8] {
        match self {
            Self::Jbig2(data) | Self::CcittG4(data) | Self::Flate(data) => data,
        }
    }
}

fn encode_bilevel_payload(
    width: u32,
    height: u32,
    row_stride: usize,
    bitmap: &[u8],
) -> Result<BilevelPayload> {
    let image = PbmP4Image {
        width,
        height,
        row_stride,
        bitmap: bitmap.to_vec(),
    };
    validate_image_mask(&image)?;
    encode_mask_payload(&image)
}

fn encode_mask_payload(mask: &PbmP4Image) -> Result<BilevelPayload> {
    let width = mask.width;
    let height = mask.height;
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let jbig2_started_at = std::time::Instant::now();
    let jbig2 = match jbig2_codec::encode_pdf_generic_verified(Bilevel {
        width,
        height,
        rows: &mask.bitmap,
    }) {
        Ok(data) => Some(data),
        Err(error) => {
            // Keep the verified source stencil and select a lossless CCITT/Flate
            // payload below; a JBIG2 failure is not a reason to discard valid MRC layers.
            eprintln!(
                "warning: verified JBIG2 encoding failed for {width}x{height} bilevel image; falling back: {error}"
            );
            None
        }
    };
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    if std::env::var_os("EVB_PDF_COMBINE_TIMING").is_some() {
        eprintln!(
            "{{\"type\":\"jbig2-encode-timing\",\"width\":{width},\"height\":{height},\"elapsedMs\":{:.3}}}",
            jbig2_started_at.elapsed().as_secs_f64() * 1_000.0
        );
    }

    let flate = deflate_bytes(&mask.bitmap)?;
    let ccitt = match encode_mask_ccitt_g4(mask) {
        Ok(data) => data,
        Err(error) => {
            eprintln!(
                "warning: CCITT Group 4 encoding failed for {width}x{height} bilevel image; falling back: {error}"
            );
            None
        }
    };
    Ok(select_bilevel_payload(jbig2, ccitt, flate))
}

fn select_bilevel_payload(
    jbig2: Option<Vec<u8>>,
    ccitt: Option<Vec<u8>>,
    flate: Vec<u8>,
) -> BilevelPayload {
    let mut selected = jbig2
        .map(BilevelPayload::Jbig2)
        .or_else(|| ccitt.clone().map(BilevelPayload::CcittG4))
        .unwrap_or_else(|| BilevelPayload::Flate(flate.clone()));
    if let Some(data) = ccitt {
        if data.len() < selected.data().len() {
            selected = BilevelPayload::CcittG4(data);
        }
    }
    if flate.len() < selected.data().len() {
        selected = BilevelPayload::Flate(flate);
    }
    selected
}

fn bilevel_image_dictionary(width: u32, height: u32, payload: &BilevelPayload) -> String {
    let filter = match payload {
        BilevelPayload::Jbig2(_) => "/Filter /JBIG2Decode".to_string(),
        BilevelPayload::CcittG4(_) => format!(
            "/Decode [1 0] /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 true >>"
        ),
        BilevelPayload::Flate(_) => "/Decode [1 0] /Filter /FlateDecode".to_string(),
    };
    format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 1 {filter} /Length {} >>",
        payload.data().len()
    )
}

fn image_mask_dictionary(width: u32, height: u32, payload: &BilevelPayload) -> String {
    let filter = match payload {
        BilevelPayload::Jbig2(_) => "/Filter /JBIG2Decode".to_string(),
        BilevelPayload::CcittG4(_) => format!(
            "/Decode [1 0] /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 true >>"
        ),
        BilevelPayload::Flate(_) => "/Decode [1 0] /Filter /FlateDecode".to_string(),
    };
    format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ImageMask true /BitsPerComponent 1 {filter} /Length {} >>",
        payload.data().len()
    )
}

fn encode_mask_ccitt_g4(mask: &PbmP4Image) -> Result<Option<Vec<u8>>> {
    let Ok(width) = u16::try_from(mask.width) else {
        return Ok(None);
    };
    let writer = VecWriter::with_capacity(mask.bitmap.len() * 8);
    let mut encoder = FaxEncoder::new(writer);
    for row in mask
        .bitmap
        .chunks(mask.row_stride)
        .take(mask.height as usize)
    {
        let colors = slice_bits(row).take(mask.width as usize).map(|bit| {
            if bit {
                Color::Black
            } else {
                Color::White
            }
        });
        encoder
            .encode_line(colors, width)
            .map_err(|_| "Failed to encode CCITT Group 4 mask line")?;
    }
    let writer = encoder
        .finish()
        .map_err(|_| "Failed to finish CCITT Group 4 mask")?;
    Ok(Some(writer.finish()))
}

enum ColorImagePayloadRef<'a> {
    RawFlate {
        data: &'a [u8],
        decode_params: &'a str,
    },
    Jpeg {
        data: &'a [u8],
    },
    Bilevel {
        bitmap: &'a [u8],
        row_stride: usize,
    },
}

impl<'a> From<&'a ImagePayload> for ColorImagePayloadRef<'a> {
    fn from(payload: &'a ImagePayload) -> Self {
        match payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => Self::RawFlate {
                data,
                decode_params,
            },
            ImagePayload::Jpeg { data } => Self::Jpeg { data },
            ImagePayload::Bilevel { bitmap, row_stride } => Self::Bilevel {
                bitmap,
                row_stride: *row_stride,
            },
        }
    }
}

impl<'a> From<&'a LayeredImagePayload> for ColorImagePayloadRef<'a> {
    fn from(payload: &'a LayeredImagePayload) -> Self {
        match payload {
            LayeredImagePayload::RawFlate {
                data,
                decode_params,
            } => Self::RawFlate {
                data,
                decode_params,
            },
            LayeredImagePayload::Jpeg { data } => Self::Jpeg { data },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_points_from_dpi() {
        assert_eq!(points(300, 300), 72.0);
        assert_eq!(points(144, 72), 144.0);
    }

    #[test]
    fn writes_xref_offsets_by_object_number() {
        let page = ImagePage {
            width: 1,
            height: 1,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 1 >>"
                    .to_string(),
            },
        };

        let pdf = build_pdf(&[page]).unwrap();
        let xref_offset = find_bytes(&pdf, b"xref\n").unwrap();
        let xref = std::str::from_utf8(&pdf[xref_offset..]).unwrap();
        let mut lines = xref.lines();
        assert_eq!(lines.next(), Some("xref"));
        assert_eq!(lines.next(), Some("0 6"));
        assert_eq!(lines.next(), Some("0000000000 65535 f "));

        for object_number in 1..=5 {
            let line = lines.next().unwrap();
            let offset = line[0..10].parse::<usize>().unwrap();
            let expected_prefix = format!("{object_number} 0 obj");
            assert!(pdf[offset..].starts_with(expected_prefix.as_bytes()));
        }
    }

    #[test]
    fn writes_layered_page_with_background_and_mask_xobjects() {
        let page = sample_layered_page(LayeredImagePayload::RawFlate {
            data: vec![0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1],
            decode_params: "<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns 4 >>"
                .to_string(),
        });

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("/Bg1"));
        assert!(text.contains("/FgMask1"));
        assert!(text.contains("/ImageMask true"));
        assert!(text.contains("/BitsPerComponent 1"));
        assert!(text.contains("/Decode [1 0]"));
        assert!(text.contains("/Filter /FlateDecode") || text.contains("/Filter /CCITTFaxDecode"));
        assert!(!text.contains("/JBIG2Decode"));
        assert!(!mask_object_dictionary(&text).contains("/ColorSpace"));
    }

    #[test]
    fn writes_mask_only_page_on_explicit_white_canvas() {
        let page = MaskPdfPage {
            page_size: PdfPageSize {
                width_points: 144.0,
                height_points: 72.0,
            },
            foreground_mask: PbmP4Image {
                width: 8,
                height: 2,
                row_stride: 1,
                bitmap: vec![0b1000_0000, 0b0100_0000],
            },
        };

        let pdf = build_mask_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("/FgMask1"));
        assert!(!text.contains("/Bg1"));
        assert!(text.contains("/ImageMask true"));
        assert!(!text.contains("/DCTDecode"));
        assert!(!mask_object_dictionary(&text).contains("/ColorSpace"));
        assert!(text.contains("1 g\n0 0 144.0000 72.0000 re f\n0 g\n"));
    }

    #[test]
    fn writes_layered_page_with_jpeg_background() {
        let page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("/ImageMask true"));
    }

    #[test]
    fn layered_jpeg_uses_jbig2_when_it_is_the_smallest_verified_mask_payload() {
        let foreground_mask = crate::netpbm::parse_pbm_p4(include_bytes!(
            "../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm"
        ))
        .unwrap();
        let page = LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 612.0,
                height_points: 792.0,
            },
            background: LayeredPdfImage {
                width: 1,
                height: 1,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::Jpeg {
                    data: vec![0xff, 0xd8, 0xff, 0xd9],
                },
            },
            foreground_mask,
            foreground_color: None,
        };

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /DCTDecode"));
        assert!(mask_object_dictionary(&text).contains("/Filter /JBIG2Decode"));
    }

    #[test]
    fn writes_layered_color_page_with_rgb_fill_and_image_mask() {
        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.foreground_color = Some([128, 16, 16]);

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Bg1"));
        assert!(text.contains("/FgMask1"));
        assert!(!text.contains("/Fg1"));
        assert!(!text.contains("/Mask "));
        assert_eq!(text.matches("/ImageMask true").count(), 1);
        assert_eq!(text.matches("/Filter /DCTDecode").count(), 1);
        assert!(text.contains(
            "q 144.0000 0 0 72.0000 0 0 cm /Bg1 Do Q\n0.5020 0.0627 0.0627 rg\nq 144.0000 0 0 72.0000 0 0 cm /FgMask1 Do Q\n"
        ));
    }

    #[test]
    fn maps_different_background_and_mask_dimensions_to_same_page_rect() {
        let page = LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 612.0,
                height_points: 792.0,
            },
            background: LayeredPdfImage {
                width: 1200,
                height: 1600,
                color_space: "DeviceRGB",
                payload: LayeredImagePayload::Jpeg {
                    data: vec![0xff, 0xd8, 0xff, 0xd9],
                },
            },
            foreground_mask: PbmP4Image {
                width: 2550,
                height: 3300,
                row_stride: 319,
                bitmap: vec![0; 319 * 3300],
            },
            foreground_color: None,
        };

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Width 1200 /Height 1600"));
        assert!(text.contains("/Width 2550 /Height 3300 /ImageMask true"));
        assert!(text.contains(
            "q 612.0000 0 0 792.0000 0 0 cm /Bg1 Do Q\n0 g\nq 612.0000 0 0 792.0000 0 0 cm /FgMask1 Do Q\n"
        ));
    }

    #[test]
    fn rejects_invalid_layered_page_size() {
        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.page_size.width_points = 0.0;

        let result = build_layered_pdf_page(&page);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_inconsistent_manual_layered_mask() {
        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.foreground_mask.row_stride = 2;
        assert!(build_layered_pdf_page(&page).is_err());

        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.foreground_mask.bitmap.pop();
        assert!(build_layered_pdf_page(&page).is_err());
    }

    #[test]
    fn selects_the_smallest_successful_bilevel_candidate() {
        assert!(matches!(
            select_bilevel_payload(Some(vec![1]), Some(vec![2; 2]), vec![3; 3]),
            BilevelPayload::Jbig2(_)
        ));
        assert!(matches!(
            select_bilevel_payload(Some(vec![1; 3]), Some(vec![2]), vec![3; 2]),
            BilevelPayload::CcittG4(_)
        ));
        assert!(matches!(
            select_bilevel_payload(Some(vec![1; 3]), Some(vec![2; 2]), vec![3]),
            BilevelPayload::Flate(_)
        ));
        assert!(matches!(
            select_bilevel_payload(None, None, vec![3]),
            BilevelPayload::Flate(_)
        ));
    }

    #[test]
    fn ccitt_failure_path_retains_the_flate_candidate() {
        // fax 0.2.7's VecWriter has Infallible as its error type, so a validated
        // PBM cannot construct a real encoder failure. None models the caught
        // error after encode_bilevel_payload logs it.
        assert_eq!(
            select_bilevel_payload(None, None, vec![1, 2, 3]),
            BilevelPayload::Flate(vec![1, 2, 3])
        );
    }

    #[test]
    fn writes_bilevel_base_image_dictionaries_for_every_filter() {
        for (payload, expected_filter) in [
            (BilevelPayload::Jbig2(vec![1, 2]), "/Filter /JBIG2Decode"),
            (
                BilevelPayload::CcittG4(vec![1, 2]),
                "/Filter /CCITTFaxDecode",
            ),
            (BilevelPayload::Flate(vec![1, 2]), "/Filter /FlateDecode"),
        ] {
            let dictionary = bilevel_image_dictionary(13, 7, &payload);
            assert!(dictionary.contains("/ColorSpace /DeviceGray"));
            assert!(dictionary.contains("/BitsPerComponent 1"));
            assert_eq!(
                dictionary.contains("/Decode [1 0]"),
                !matches!(payload, BilevelPayload::Jbig2(_))
            );
            assert!(dictionary.contains(expected_filter));
            assert!(!dictionary.contains("/ImageMask true"));
            if matches!(payload, BilevelPayload::CcittG4(_)) {
                assert!(dictionary
                    .contains("/DecodeParms << /K -1 /Columns 13 /Rows 7 /BlackIs1 true >>"));
            } else {
                assert!(!dictionary.contains("/DecodeParms"));
            }
        }
    }

    #[test]
    fn writes_image_mask_dictionaries_for_every_filter_and_polarity() {
        for (payload, expected_filter) in [
            (BilevelPayload::Jbig2(vec![1, 2]), "/Filter /JBIG2Decode"),
            (
                BilevelPayload::CcittG4(vec![1, 2]),
                "/Filter /CCITTFaxDecode",
            ),
            (BilevelPayload::Flate(vec![1, 2]), "/Filter /FlateDecode"),
        ] {
            let dictionary = image_mask_dictionary(13, 7, &payload);
            assert!(dictionary.contains("/ImageMask true"));
            assert!(dictionary.contains("/BitsPerComponent 1"));
            assert!(!dictionary.contains("/ColorSpace"));
            assert_eq!(
                dictionary.contains("/Decode [1 0]"),
                !matches!(payload, BilevelPayload::Jbig2(_))
            );
            assert!(dictionary.contains(expected_filter));
            if matches!(payload, BilevelPayload::CcittG4(_)) {
                assert!(dictionary
                    .contains("/DecodeParms << /K -1 /Columns 13 /Rows 7 /BlackIs1 true >>"));
            } else {
                assert!(!dictionary.contains("/DecodeParms"));
            }
        }
    }

    #[test]
    fn all_image_mask_filters_decode_to_the_same_paint_bitmap() {
        use fax::decoder::{decode_g4, pels};
        use flate2::read::ZlibDecoder;
        use std::io::Read;

        let mask = PbmP4Image {
            width: 13,
            height: 7,
            row_stride: 2,
            bitmap: vec![
                0b1010_0101,
                0b1010_0000,
                0b0101_1010,
                0b0101_0000,
                0b1111_0000,
                0b1111_0000,
                0b0000_1111,
                0b0000_1000,
                0b1000_0000,
                0b0000_0000,
                0b0000_0000,
                0b1000_0000,
                0b1111_1111,
                0b1111_1000,
            ],
        };

        let flate = deflate_bytes(&mask.bitmap).unwrap();
        let mut flate_rows = Vec::new();
        ZlibDecoder::new(flate.as_slice())
            .read_to_end(&mut flate_rows)
            .unwrap();

        let ccitt = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
        let mut ccitt_rows = vec![0; mask.bitmap.len()];
        let mut row = 0usize;
        assert!(decode_g4(
            ccitt.iter().copied(),
            mask.width as u16,
            Some(mask.height as u16),
            |transitions| {
                for (x, color) in pels(transitions, mask.width as u16).enumerate() {
                    if color == Color::Black {
                        ccitt_rows[row * mask.row_stride + x / 8] |= 1 << (7 - x % 8);
                    }
                }
                row += 1;
            }
        )
        .is_some());

        let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
            width: mask.width,
            height: mask.height,
            rows: &mask.bitmap,
        })
        .unwrap();
        let jbig2_rows =
            jbig2_codec::decode_pdf_generic(&jbig2, jbig2_codec::DecodeLimits::default())
                .unwrap()
                .rows;

        assert_eq!(flate_rows, mask.bitmap);
        assert_eq!(ccitt_rows, mask.bitmap);
        assert_eq!(jbig2_rows, mask.bitmap);
    }

    #[test]
    fn bundled_poppler_renders_all_image_mask_filters_identically() {
        use std::{
            fs,
            path::PathBuf,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        let Some(pdftoppm) = bundled_pdftoppm_path() else {
            eprintln!("bundled pdftoppm is unavailable for this host");
            return;
        };
        let mask = PbmP4Image {
            width: 13,
            height: 7,
            row_stride: 2,
            bitmap: vec![
                0b1010_0101,
                0b1010_0000,
                0b0101_1010,
                0b0101_0000,
                0b1111_0000,
                0b1111_0000,
                0b0000_1111,
                0b0000_1000,
                0b1000_0000,
                0b0000_0000,
                0b0000_0000,
                0b1000_0000,
                0b1111_1111,
                0b1111_1000,
            ],
        };
        let payloads = [
            (
                "flate",
                BilevelPayload::Flate(deflate_bytes(&mask.bitmap).unwrap()),
            ),
            (
                "group4",
                BilevelPayload::CcittG4(encode_mask_ccitt_g4(&mask).unwrap().unwrap()),
            ),
            (
                "jbig2",
                BilevelPayload::Jbig2(
                    jbig2_codec::encode_pdf_generic_verified(Bilevel {
                        width: mask.width,
                        height: mask.height,
                        rows: &mask.bitmap,
                    })
                    .unwrap(),
                ),
            ),
        ];
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "evb-image-mask-render-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();

        let mut renders = Vec::new();
        for (name, payload) in payloads {
            let pdf_path = directory.join(format!("{name}.pdf"));
            let output_prefix = directory.join(name);
            fs::write(&pdf_path, build_test_mask_pdf(&mask, &payload)).unwrap();
            let output = Command::new(&pdftoppm)
                .args(["-r", "72", "-gray", "-singlefile"])
                .arg(&pdf_path)
                .arg(&output_prefix)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            renders.push(fs::read(output_prefix.with_extension("pgm")).unwrap());
        }
        assert_eq!(renders[0], renders[1]);
        assert_eq!(renders[0], renders[2]);

        fs::remove_dir_all(directory).unwrap();

        fn bundled_pdftoppm_path() -> Option<PathBuf> {
            let tag = match (std::env::consts::OS, std::env::consts::ARCH) {
                ("macos", "aarch64") => "darwin-arm64",
                ("linux", "x86_64") => "linux-x64",
                ("windows", "x86_64") => "win32-x64",
                _ => return None,
            };
            let executable = if std::env::consts::OS == "windows" {
                "pdftoppm.exe"
            } else {
                "pdftoppm"
            };
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../resources/poppler")
                .join(tag)
                .join("bin")
                .join(executable);
            path.is_file().then_some(path)
        }
    }

    #[test]
    fn real_scan_masks_select_jbig2_over_flate_and_group4() {
        use crate::netpbm::parse_pbm_p4;

        for (name, pbm) in [
            (
                "scan-page-000-body",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-002-body",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-002-body.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-007-notes",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-007-notes.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-000-body-509",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body-509.pbm")
                    .as_slice(),
            ),
        ] {
            let mask = parse_pbm_p4(pbm).unwrap();
            let flate = deflate_bytes(&mask.bitmap).unwrap();
            let group4 = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
            let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
                width: mask.width,
                height: mask.height,
                rows: &mask.bitmap,
            })
            .unwrap();
            eprintln!(
                "{name}: Flate={} bytes, G4={} bytes, JBIG2={} bytes",
                flate.len(),
                group4.len(),
                jbig2.len()
            );

            assert!(jbig2.len() < flate.len());
            assert!(jbig2.len() < group4.len());
            assert!(matches!(
                encode_mask_payload(&mask).unwrap(),
                BilevelPayload::Jbig2(_)
            ));
        }
    }

    fn build_test_mask_pdf(mask: &PbmP4Image, payload: &BilevelPayload) -> Vec<u8> {
        let mut writer = PdfWriter::new(Vec::new()).unwrap();
        writer.page_objects.push(3);
        writer.next_object = 6;
        writer
            .push_object(
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << /Mask 4 0 R >> >> /Contents 5 0 R >>",
                    mask.width, mask.height
                )
                .as_bytes(),
            )
            .unwrap();
        let dictionary = image_mask_dictionary(mask.width, mask.height, payload);
        writer
            .push_stream_object(4, dictionary.as_bytes(), payload.data())
            .unwrap();
        let content = format!(
            "1 g\n0 0 {} {} re f\n0 g\nq {} 0 0 {} 0 0 cm /Mask Do Q\n",
            mask.width, mask.height, mask.width, mask.height
        );
        writer
            .push_stream_object(
                5,
                format!("<< /Length {} >>", content.len()).as_bytes(),
                content.as_bytes(),
            )
            .unwrap();
        writer.finish().unwrap()
    }

    fn sample_layered_page(payload: LayeredImagePayload) -> LayeredPdfPage {
        LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 144.0,
                height_points: 72.0,
            },
            background: LayeredPdfImage {
                width: 4,
                height: 2,
                color_space: "DeviceGray",
                payload,
            },
            foreground_mask: PbmP4Image {
                width: 8,
                height: 2,
                row_stride: 1,
                bitmap: vec![0b1000_0000, 0b0100_0000],
            },
            foreground_color: None,
        }
    }

    fn mask_object_dictionary(pdf: &str) -> &str {
        let image_mask = pdf.find("/ImageMask true").unwrap();
        let object_start = pdf[..image_mask].rfind("<<").unwrap();
        let object_end = pdf[image_mask..].find(">>").unwrap() + image_mask + 2;
        &pdf[object_start..object_end]
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }
}
