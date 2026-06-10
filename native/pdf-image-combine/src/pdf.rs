use std::{fmt::Write as FmtWrite, io::Write as IoWrite};

use crate::Result;

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

pub(crate) fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new())?;
    for page in pages {
        writer.add_page(page)?;
    }
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
        let page_object = self.next_object;
        let image_object = page_object + 1;
        let content_object = page_object + 2;
        self.next_object += 3;
        self.page_objects.push(page_object);

        let image_name = format!("Im{}", self.page_objects.len());
        let page_width = points(page.width, page.dpi);
        let page_height = points(page.height, page.dpi);
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
        match &page.payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms {} /Length {} >>",
                    page.width,
                    page.height,
                    page.color_space,
                    decode_params,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ImagePayload::Jpeg { data } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                    page.width,
                    page.height,
                    page.color_space,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
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

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }
}
