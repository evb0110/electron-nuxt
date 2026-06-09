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
    let object_count = 2 + pages.len() * 3;
    let mut pdf = Vec::new();
    let mut offsets: Vec<usize> = Vec::with_capacity(object_count + 1);
    pdf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    push_object(
        &mut pdf,
        &mut offsets,
        1,
        b"<< /Type /Catalog /Pages 2 0 R >>",
    );

    let mut kids = String::new();
    for index in 0..pages.len() {
        let page_object = 3 + index * 3;
        let _ = write!(kids, "{page_object} 0 R ");
    }
    let pages_body = format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.trim_end(),
        pages.len()
    );
    push_object(&mut pdf, &mut offsets, 2, pages_body.as_bytes());

    for (index, page) in pages.iter().enumerate() {
        let page_object = 3 + index * 3;
        let image_object = page_object + 1;
        let content_object = page_object + 2;
        let image_name = format!("Im{}", index + 1);
        let page_width = points(page.width, page.dpi);
        let page_height = points(page.height, page.dpi);

        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width, page_height, image_name, image_object, content_object
        );
        push_object(&mut pdf, &mut offsets, page_object, page_body.as_bytes());

        let image_body = build_image_object_body(page)?;
        push_object(&mut pdf, &mut offsets, image_object, &image_body);

        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, image_name
        );
        let content_body = build_stream_object_body(
            format!("<< /Length {} >>", content_stream.len()).as_bytes(),
            content_stream.as_bytes(),
        );
        push_object(&mut pdf, &mut offsets, content_object, &content_body);
    }

    let xref_offset = pdf.len();
    writeln!(&mut pdf, "xref")?;
    writeln!(&mut pdf, "0 {}", object_count + 1)?;
    writeln!(&mut pdf, "0000000000 65535 f ")?;
    for offset in offsets {
        writeln!(&mut pdf, "{offset:010} 00000 n ")?;
    }
    write!(
        &mut pdf,
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        object_count + 1,
        xref_offset
    )?;

    Ok(pdf)
}

fn build_image_object_body(page: &ImagePage) -> Result<Vec<u8>> {
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
            Ok(build_stream_object_body(dict.as_bytes(), data))
        }
        ImagePayload::Jpeg { data } => {
            let dict = format!(
                "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                page.width,
                page.height,
                page.color_space,
                data.len()
            );
            Ok(build_stream_object_body(dict.as_bytes(), data))
        }
    }
}

fn build_stream_object_body(dict: &[u8], stream: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(dict.len() + stream.len() + 32);
    body.extend_from_slice(dict);
    body.extend_from_slice(b"\nstream\n");
    body.extend_from_slice(stream);
    body.extend_from_slice(b"\nendstream");
    body
}

fn push_object(pdf: &mut Vec<u8>, offsets: &mut Vec<usize>, object_number: usize, body: &[u8]) {
    offsets.push(pdf.len());
    let _ = writeln!(pdf, "{object_number} 0 obj");
    pdf.extend_from_slice(body);
    pdf.extend_from_slice(b"\nendobj\n");
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
}
