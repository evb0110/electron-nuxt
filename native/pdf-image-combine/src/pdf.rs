use fax::{encoder::Encoder as FaxEncoder, slice_bits, Color, VecWriter};
use flate2::{write::ZlibEncoder, Compression};
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
}

pub(crate) struct ImagePage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) dpi: u32,
    pub(crate) color_space: &'static str,
    pub(crate) payload: ImagePayload,
}

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
}

pub struct MaskPdfPage {
    pub page_size: PdfPageSize,
    pub foreground_mask: PbmP4Image,
}

pub(crate) fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    for page in pages {
        writer.add_page(page)?;
    }
    writer.finish()
}

pub fn build_layered_pdf_page(page: &LayeredPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    writer.add_layered_page(page)?;
    writer.finish()
}

pub fn build_mask_pdf_page(page: &MaskPdfPage) -> Result<Vec<u8>> {
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
        self.next_object += 3;
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
        self.push_image_object(image_object, page)?;

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
        self.next_object += 4;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let background_name = format!("Bg{page_index}");
        let mask_name = format!("FgMask{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << /{} {} 0 R /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width,
            page_height,
            background_name,
            background_object,
            mask_name,
            mask_object,
            content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.push_layered_image_object(background_object, &page.background)?;
        self.push_image_mask_object(mask_object, &page.foreground_mask)?;

        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n0 g\nq {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, background_name, page_width, page_height, mask_name
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

    fn push_image_object(&mut self, object_number: usize, page: &ImagePage) -> Result<()> {
        self.push_color_image_stream(
            object_number,
            page.width,
            page.height,
            page.color_space,
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
            ColorImagePayloadRef::from(&image.payload),
        )
    }

    fn push_color_image_stream(
        &mut self,
        object_number: usize,
        width: u32,
        height: u32,
        color_space: &str,
        payload: ColorImagePayloadRef<'_>,
    ) -> Result<()> {
        match payload {
            ColorImagePayloadRef::RawFlate {
                data,
                decode_params,
            } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms {} /Length {} >>",
                    width,
                    height,
                    color_space,
                    decode_params,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ColorImagePayloadRef::Jpeg { data } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                    width,
                    height,
                    color_space,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
        }
    }

    fn push_image_mask_object(&mut self, object_number: usize, mask: &PbmP4Image) -> Result<()> {
        validate_image_mask(mask)?;
        let payload = encode_mask_payload(mask)?;
        match payload {
            ImageMaskPayload::Flate(data) => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ImageMask true /BitsPerComponent 1 /Decode [1 0] /Filter /FlateDecode /Length {} >>",
                    mask.width,
                    mask.height,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), &data)
            }
            ImageMaskPayload::CcittG4(data) => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ImageMask true /BitsPerComponent 1 /Decode [1 0] /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {} /Rows {} /BlackIs1 true >> /Length {} >>",
                    mask.width,
                    mask.height,
                    mask.width,
                    mask.height,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), &data)
            }
        }
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

enum ImageMaskPayload {
    Flate(Vec<u8>),
    CcittG4(Vec<u8>),
}

fn encode_mask_payload(mask: &PbmP4Image) -> Result<ImageMaskPayload> {
    let flate = deflate_bytes(&mask.bitmap)?;
    let Some(ccitt) = encode_mask_ccitt_g4(mask)? else {
        return Ok(ImageMaskPayload::Flate(flate));
    };
    if ccitt.len() < flate.len() {
        Ok(ImageMaskPayload::CcittG4(ccitt))
    } else {
        Ok(ImageMaskPayload::Flate(flate))
    }
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
