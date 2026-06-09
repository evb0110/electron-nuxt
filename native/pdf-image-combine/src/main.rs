use std::{
    env,
    error::Error,
    fmt::Write as FmtWrite,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const DEFAULT_DPI: u32 = 72;
const METERS_PER_INCH: f64 = 0.0254;
const CM_PER_INCH: f64 = 2.54;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const JPEG_APP0_MARKER: u8 = 0xE0;
const JPEG_START_OF_SCAN_MARKER: u8 = 0xDA;
const VERSION: &str = env!("CARGO_PKG_VERSION");

type Result<T> = std::result::Result<T, Box<dyn Error>>;

struct Config {
    output_path: PathBuf,
    input_paths: Vec<PathBuf>,
    json_progress: bool,
}

enum ImagePayload {
    RawFlate {
        data: Vec<u8>,
        decode_params: String,
    },
    Jpeg {
        data: Vec<u8>,
    },
}

struct ImagePage {
    width: u32,
    height: u32,
    dpi: u32,
    color_space: &'static str,
    payload: ImagePayload,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if env::args().skip(1).any(|arg| arg == "--version") {
        println!("evb-pdf-image-combine {VERSION}");
        return Ok(());
    }

    let config = parse_args()?;
    let max_pixels = read_max_pixels();
    let started_at = Instant::now();
    let total = config.input_paths.len();
    let mut pages = Vec::with_capacity(total);

    for (index, input_path) in config.input_paths.iter().enumerate() {
        let page = read_image_page(input_path, max_pixels)?;
        pages.push(page);
        if config.json_progress {
            print_progress(index + 1, total, started_at);
        }
    }

    let pdf = build_pdf(&pages)?;
    fs::write(&config.output_path, pdf)?;
    Ok(())
}

fn parse_args() -> Result<Config> {
    let mut args = env::args().skip(1);
    let mut output_path: Option<PathBuf> = None;
    let mut input_paths: Vec<PathBuf> = Vec::new();
    let mut json_progress = false;
    let mut reading_inputs = false;

    while let Some(arg) = args.next() {
        if reading_inputs {
            input_paths.push(PathBuf::from(arg));
            continue;
        }

        match arg.as_str() {
            "--output" => {
                let value = args.next().ok_or("Missing --output value")?;
                output_path = Some(PathBuf::from(value));
            }
            "--json-progress" => {
                json_progress = true;
            }
            "--" => {
                reading_inputs = true;
            }
            _ if arg.starts_with('-') => {
                return Err(format!("Unknown argument: {arg}").into());
            }
            _ => {
                input_paths.push(PathBuf::from(arg));
            }
        }
    }

    let output_path = output_path.ok_or("Missing required --output argument")?;
    if input_paths.is_empty() {
        return Err("At least one input image is required".into());
    }

    Ok(Config {
        output_path,
        input_paths,
        json_progress,
    })
}

fn read_max_pixels() -> u64 {
    env::var("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1_000_000)
        .unwrap_or(80_000_000)
}

fn print_progress(processed: usize, total: usize, started_at: Instant) {
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    let percent = ((processed as f64 / total as f64) * 100.0).round() as u32;
    let estimated_remaining_ms = if processed >= total {
        0
    } else {
        let average = elapsed_ms as f64 / processed.max(1) as f64;
        (average * (total - processed) as f64).round() as u64
    };

    println!(
        "{{\"type\":\"progress\",\"processed\":{processed},\"total\":{total},\"percent\":{percent},\"elapsedMs\":{elapsed_ms},\"estimatedRemainingMs\":{estimated_remaining_ms}}}"
    );
    let _ = std::io::stdout().flush();
}

fn read_image_page(path: &Path, max_pixels: u64) -> Result<ImagePage> {
    let bytes = fs::read(path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" => read_png_page(&bytes, max_pixels),
        "jpg" | "jpeg" => read_jpeg_page(bytes, max_pixels),
        _ => Err(format!("Unsupported image extension: {}", path.display()).into()),
    }
}

fn read_png_page(bytes: &[u8], max_pixels: u64) -> Result<ImagePage> {
    let png = parse_png(bytes)?;
    assert_pixel_limit(png.width, png.height, max_pixels)?;

    let (colors, color_space) = match png.color_type {
        0 => (1, "DeviceGray"),
        2 => (3, "DeviceRGB"),
        _ => {
            return Err(format!("Unsupported PNG color type: {}", png.color_type).into());
        }
    };

    let decode_params = format!(
        "<< /Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        png.width
    );

    Ok(ImagePage {
        width: png.width,
        height: png.height,
        dpi: png.dpi.unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::RawFlate {
            data: png.idat,
            decode_params,
        },
    })
}

fn read_jpeg_page(bytes: Vec<u8>, max_pixels: u64) -> Result<ImagePage> {
    let metadata = parse_jpeg_metadata(&bytes)?;
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    let color_space = match metadata.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => {
            return Err(
                format!("Unsupported JPEG component count: {}", metadata.components).into(),
            );
        }
    };

    Ok(ImagePage {
        width: metadata.width,
        height: metadata.height,
        dpi: metadata.dpi.unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::Jpeg { data: bytes },
    })
}

fn assert_pixel_limit(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = width as u64 * height as u64;
    if width == 0 || height == 0 || pixels > max_pixels {
        return Err(
            format!("Image dimensions are too large to combine safely: {width}x{height}").into(),
        );
    }
    Ok(())
}

fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>> {
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

fn read_u16_be(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
        *bytes.get(offset + 3)?,
    ]))
}

struct PngData {
    width: u32,
    height: u32,
    color_type: u8,
    dpi: Option<u32>,
    idat: Vec<u8>,
}

fn parse_png(bytes: &[u8]) -> Result<PngData> {
    if bytes.len() < PNG_SIGNATURE.len() || &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("Invalid PNG payload".into());
    }

    let mut offset = PNG_SIGNATURE.len();
    let mut width = None;
    let mut height = None;
    let mut bit_depth = None;
    let mut color_type = None;
    let mut compression_method = None;
    let mut filter_method = None;
    let mut interlace_method = None;
    let mut dpi = None;
    let mut idat = Vec::new();

    while offset + 12 <= bytes.len() {
        let length = read_u32_be(bytes, offset).ok_or("Truncated PNG chunk length")? as usize;
        let chunk_type = bytes
            .get(offset + 4..offset + 8)
            .ok_or("Truncated PNG chunk type")?;
        let data_offset = offset + 8;
        let data_end = data_offset
            .checked_add(length)
            .ok_or("Invalid PNG chunk length")?;
        let chunk_end = data_end.checked_add(4).ok_or("Invalid PNG chunk length")?;
        if chunk_end > bytes.len() {
            return Err("Truncated PNG chunk".into());
        }
        let chunk_data = &bytes[data_offset..data_end];

        match chunk_type {
            b"IHDR" => {
                if length != 13 {
                    return Err("Invalid PNG IHDR length".into());
                }
                width = Some(read_u32_be(bytes, data_offset).ok_or("Missing PNG width")?);
                height = Some(read_u32_be(bytes, data_offset + 4).ok_or("Missing PNG height")?);
                bit_depth = chunk_data.get(8).copied();
                color_type = chunk_data.get(9).copied();
                compression_method = chunk_data.get(10).copied();
                filter_method = chunk_data.get(11).copied();
                interlace_method = chunk_data.get(12).copied();
            }
            b"pHYs" => {
                if length == 9 {
                    dpi = read_png_phys_dpi(bytes, data_offset);
                }
            }
            b"IDAT" => idat.extend_from_slice(chunk_data),
            b"IEND" => break,
            _ => {}
        }

        offset = chunk_end;
    }

    let width = width.ok_or("Missing PNG IHDR")?;
    let height = height.ok_or("Missing PNG IHDR")?;
    let color_type = color_type.ok_or("Missing PNG color type")?;
    if bit_depth != Some(8) {
        return Err("Unsupported PNG bit depth".into());
    }
    if compression_method != Some(0) || filter_method != Some(0) {
        return Err("Unsupported PNG compression or filter method".into());
    }
    if interlace_method != Some(0) {
        return Err("Interlaced PNG images are not supported by the native fast path".into());
    }
    if idat.is_empty() {
        return Err("Missing PNG image data".into());
    }

    Ok(PngData {
        width,
        height,
        color_type,
        dpi,
        idat,
    })
}

fn read_png_phys_dpi(bytes: &[u8], offset: usize) -> Option<u32> {
    let x_pixels_per_unit = read_u32_be(bytes, offset)?;
    let y_pixels_per_unit = read_u32_be(bytes, offset + 4)?;
    let unit = *bytes.get(offset + 8)?;
    if unit == 1 && (x_pixels_per_unit > 0 || y_pixels_per_unit > 0) {
        let pixels_per_meter = x_pixels_per_unit.max(y_pixels_per_unit) as f64;
        let dpi = (pixels_per_meter * METERS_PER_INCH).round() as u32;
        return (dpi > 0).then_some(dpi);
    }
    None
}

struct JpegMetadata {
    width: u32,
    height: u32,
    components: u8,
    dpi: Option<u32>,
}

fn parse_jpeg_metadata(bytes: &[u8]) -> Result<JpegMetadata> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("Invalid JPEG payload".into());
    }

    let mut offset = 2usize;
    let mut dpi = None;
    let mut dimensions = None;

    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xFF {
            break;
        }

        while offset < bytes.len() && bytes[offset] == 0xFF {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or("Truncated JPEG marker")?;
        offset += 1;

        if marker == JPEG_START_OF_SCAN_MARKER {
            break;
        }
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            continue;
        }

        let segment_length = read_u16_be(bytes, offset).ok_or("Truncated JPEG segment")? as usize;
        if segment_length < 2 || offset + segment_length > bytes.len() {
            return Err("Invalid JPEG segment length".into());
        }

        if marker == JPEG_APP0_MARKER {
            dpi = dpi.or_else(|| read_jfif_dpi(bytes, offset, segment_length));
        }

        if is_jpeg_sof_marker(marker) {
            if segment_length < 8 {
                return Err("Invalid JPEG SOF segment".into());
            }
            let height = read_u16_be(bytes, offset + 3).ok_or("Missing JPEG height")? as u32;
            let width = read_u16_be(bytes, offset + 5).ok_or("Missing JPEG width")? as u32;
            let components = *bytes
                .get(offset + 7)
                .ok_or("Missing JPEG component count")?;
            dimensions = Some((width, height, components));
            break;
        }

        offset += segment_length;
    }

    let (width, height, components) = dimensions.ok_or("Missing JPEG dimensions")?;
    Ok(JpegMetadata {
        width,
        height,
        components,
        dpi,
    })
}

fn is_jpeg_sof_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

fn read_jfif_dpi(bytes: &[u8], offset: usize, segment_length: usize) -> Option<u32> {
    if segment_length < 16 {
        return None;
    }
    if bytes.get(offset + 2..offset + 7)? != b"JFIF\0" {
        return None;
    }

    let units = *bytes.get(offset + 9)?;
    let x_density = read_u16_be(bytes, offset + 10)? as u32;
    let y_density = read_u16_be(bytes, offset + 12)? as u32;
    let density = x_density.max(y_density);
    if density == 0 {
        return None;
    }

    match units {
        1 => Some(density),
        2 => Some((density as f64 * CM_PER_INCH).round() as u32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_png_phys_dpi() {
        let bytes = [0, 0, 0x0B, 0xB8, 0, 0, 0x0B, 0xB8, 1];
        assert_eq!(read_png_phys_dpi(&bytes, 0), Some(76));
    }

    #[test]
    fn computes_points_from_dpi() {
        assert_eq!(points(300, 300), 72.0);
        assert_eq!(points(144, 72), 144.0);
    }
}
