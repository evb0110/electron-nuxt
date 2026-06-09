use flate2::{write::ZlibEncoder, Compression};
use std::{
    env,
    error::Error,
    fmt::Write as FmtWrite,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Seek, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use tiff::{
    decoder::{ifd::Value as TiffIfdValue, Decoder, DecodingResult},
    encoder::{colortype, Rational, TiffEncoder},
    tags::{ResolutionUnit, Tag},
    ColorType as TiffColorType,
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
    dpi: Option<u32>,
    output_format: OutputFormat,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Pdf,
    Tiff,
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
    let max_pixels = read_limit(
        "EVB_PDF_COMBINE_MAX_IMAGE_PIXELS",
        80_000_000,
        1_000_000,
        u64::MAX,
    );

    if config.output_format == OutputFormat::Tiff {
        combine_tiff_pages(
            &config.input_paths,
            &config.output_path,
            max_pixels,
            read_limit("EVB_TIFF_COMBINE_MAX_PAGES", 10_000, 1, 100_000) as usize,
        )?;
        return Ok(());
    }

    let max_pages = read_limit("EVB_PDF_COMBINE_MAX_PAGES", 500, 1, 10_000) as usize;
    let max_tiff_frames = read_limit("EVB_PDF_COMBINE_MAX_TIFF_FRAMES", 250, 1, 5_000) as usize;
    let started_at = Instant::now();
    let total = config.input_paths.len();
    let mut pages = Vec::with_capacity(total);

    for (index, input_path) in config.input_paths.iter().enumerate() {
        let input_pages = read_image_pages(input_path, max_pixels, config.dpi, max_tiff_frames)?;
        if pages.len() + input_pages.len() > max_pages {
            return Err(format!("Combined PDF is capped at {max_pages} pages").into());
        }
        pages.extend(input_pages);
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
    let mut dpi = None;
    let mut output_format = OutputFormat::Pdf;
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
            "--dpi" => {
                let value = args.next().ok_or("Missing --dpi value")?;
                dpi = Some(parse_dpi(&value)?);
            }
            "--format" => {
                let value = args.next().ok_or("Missing --format value")?;
                output_format = match value.as_str() {
                    "pdf" => OutputFormat::Pdf,
                    "tiff" => OutputFormat::Tiff,
                    _ => return Err(format!("Unsupported output format: {value}").into()),
                };
            }
            "--inputs-file" => {
                let value = args.next().ok_or("Missing --inputs-file value")?;
                input_paths.extend(read_input_paths_file(Path::new(&value))?);
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
        dpi,
        output_format,
    })
}

fn read_input_paths_file(path: &Path) -> Result<Vec<PathBuf>> {
    let contents = fs::read_to_string(path)?;
    Ok(contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn parse_dpi(value: &str) -> Result<u32> {
    let dpi = value.parse::<u32>()?;
    if dpi == 0 {
        return Err("DPI must be greater than zero".into());
    }
    Ok(dpi)
}

fn read_limit(name: &str, default_value: u64, min_value: u64, max_value: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= min_value && *value <= max_value)
        .unwrap_or(default_value)
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

fn read_image_pages(
    path: &Path,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
) -> Result<Vec<ImagePage>> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "tif" || extension == "tiff" {
        return read_tiff_pdf_pages(path, max_pixels, default_dpi, max_tiff_frames);
    }

    let bytes = fs::read(path)?;

    let page = match extension.as_str() {
        "png" => read_png_page(&bytes, max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(bytes, max_pixels, default_dpi)?,
        "pgm" | "ppm" => read_netpbm_page(&bytes, max_pixels, default_dpi.unwrap_or(DEFAULT_DPI))?,
        _ => return Err(format!("Unsupported image extension: {}", path.display()).into()),
    };

    Ok(vec![page])
}

fn read_png_page(bytes: &[u8], max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
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
        dpi: png.dpi.or(default_dpi).unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::RawFlate {
            data: png.idat,
            decode_params,
        },
    })
}

fn read_jpeg_page(bytes: Vec<u8>, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
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
        dpi: metadata.dpi.or(default_dpi).unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::Jpeg { data: bytes },
    })
}

fn read_netpbm_page(bytes: &[u8], max_pixels: u64, dpi: u32) -> Result<ImagePage> {
    let netpbm = parse_netpbm(bytes)?;
    assert_pixel_limit(netpbm.width, netpbm.height, max_pixels)?;

    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let (colors, color_space, image_pixels): (u32, &'static str, Vec<u8>) = if netpbm.channels == 1
    {
        (1, "DeviceGray", netpbm.pixels.to_vec())
    } else if is_rgb_data_grayscale(netpbm.pixels, total_pixels) {
        (
            1,
            "DeviceGray",
            extract_grayscale_from_rgb(netpbm.pixels, total_pixels),
        )
    } else {
        (3, "DeviceRGB", netpbm.pixels.to_vec())
    };

    let bytes_per_row = netpbm.width as usize * colors as usize;
    let filtered = apply_up_filter(&image_pixels, bytes_per_row, netpbm.height as usize);
    let compressed = deflate(&filtered)?;
    let decode_params = format!(
        "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        netpbm.width
    );

    Ok(ImagePage {
        width: netpbm.width,
        height: netpbm.height,
        dpi,
        color_space,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params,
        },
    })
}

fn read_tiff_pdf_pages(
    path: &Path,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
) -> Result<Vec<ImagePage>> {
    let file = File::open(path)?;
    let mut decoder = Decoder::new(BufReader::new(file))?;
    let mut pages = Vec::new();

    loop {
        if pages.len() >= max_tiff_frames {
            return Err(format!(
                "TIFF frame count is capped at {max_tiff_frames}: {}",
                path.display()
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
        pages.push(build_tiff_pdf_page(
            width, height, dpi, color_type, decoded,
        )?);

        if !decoder.more_images() {
            break;
        }
        decoder.next_image()?;
    }

    if pages.is_empty() {
        return Err(format!("No decodable TIFF pages found in {}", path.display()).into());
    }

    Ok(pages)
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
    let filtered = apply_up_filter(&pixels, bytes_per_row, height as usize);
    let compressed = deflate(&filtered)?;
    let decode_params =
        format!("<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {width} >>");

    Ok(ImagePage {
        width,
        height,
        dpi,
        color_space,
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

fn combine_tiff_pages(
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

    let output = File::create(output_path)?;
    let mut encoder = TiffEncoder::new(BufWriter::new(output))?;

    for input_path in input_paths {
        let page = read_first_tiff_rgba_page(input_path, max_pixels)?;
        let mut image = encoder.new_image::<colortype::RGBA8>(page.width, page.height)?;
        image.resolution(ResolutionUnit::None, Rational { n: 1, d: 1 });
        image.write_data(&page.rgba)?;
    }

    Ok(())
}

fn read_first_tiff_rgba_page(path: &Path, max_pixels: u64) -> Result<RgbaTiffPage> {
    let file = File::open(path)?;
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

fn assert_pixel_limit(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = width as u64 * height as u64;
    if width == 0 || height == 0 || pixels > max_pixels {
        return Err(
            format!("Image dimensions are too large to combine safely: {width}x{height}").into(),
        );
    }
    Ok(())
}

struct NetpbmData<'a> {
    width: u32,
    height: u32,
    channels: u8,
    pixels: &'a [u8],
}

fn parse_netpbm(data: &[u8]) -> Result<NetpbmData<'_>> {
    if data.len() < 4 {
        return Err("Netpbm payload is too short".into());
    }

    let channels = match data.get(0..2) {
        Some(b"P5") => 1,
        Some(b"P6") => 3,
        _ => return Err("Unsupported Netpbm format".into()),
    };

    let mut offset = 2usize;
    let width = read_netpbm_number(data, &mut offset, "width")?;
    let height = read_netpbm_number(data, &mut offset, "height")?;
    let maxval = read_netpbm_number(data, &mut offset, "maxval")?;
    if maxval == 0 || maxval > 255 {
        return Err(format!("Unsupported maxval {maxval} (only 8-bit supported)").into());
    }
    if offset >= data.len() || !is_whitespace_byte(data[offset]) {
        return Err("Invalid Netpbm header terminator".into());
    }
    offset += 1;

    let data_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|value| value.checked_mul(channels as usize))
        .ok_or("Invalid Netpbm payload size")?;
    let data_end = offset
        .checked_add(data_size)
        .ok_or("Invalid Netpbm payload size")?;
    let pixels = data
        .get(offset..data_end)
        .ok_or("Truncated Netpbm payload")?;

    Ok(NetpbmData {
        width,
        height,
        channels,
        pixels,
    })
}

fn read_netpbm_number(data: &[u8], offset: &mut usize, label: &str) -> Result<u32> {
    skip_netpbm_whitespace_and_comments(data, offset);
    if *offset >= data.len() {
        return Err(format!("Missing {label} in Netpbm header").into());
    }

    let start = *offset;
    while *offset < data.len() && data[*offset].is_ascii_digit() {
        *offset += 1;
    }
    if start == *offset {
        return Err(format!("Invalid {label} in Netpbm header").into());
    }

    let value = std::str::from_utf8(&data[start..*offset])?.parse::<u32>()?;
    if value == 0 {
        return Err(format!("Invalid {label} in Netpbm header").into());
    }
    Ok(value)
}

fn skip_netpbm_whitespace_and_comments(data: &[u8], offset: &mut usize) {
    while *offset < data.len() {
        let byte = data[*offset];
        if byte == b'#' {
            while *offset < data.len() && data[*offset] != b'\n' {
                *offset += 1;
            }
            if *offset < data.len() {
                *offset += 1;
            }
            continue;
        }
        if is_whitespace_byte(byte) {
            *offset += 1;
            continue;
        }
        break;
    }
}

fn is_whitespace_byte(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

fn is_rgb_data_grayscale(pixels: &[u8], total_pixels: usize) -> bool {
    let step = std::cmp::max(1, total_pixels / 10_000);
    for index in (0..total_pixels).step_by(step) {
        let offset = index * 3;
        if pixels[offset] != pixels[offset + 1] || pixels[offset] != pixels[offset + 2] {
            return false;
        }
    }
    true
}

fn extract_grayscale_from_rgb(pixels: &[u8], total_pixels: usize) -> Vec<u8> {
    let mut grayscale = Vec::with_capacity(total_pixels);
    for index in 0..total_pixels {
        grayscale.push(pixels[index * 3]);
    }
    grayscale
}

fn apply_up_filter(pixels: &[u8], bytes_per_row: usize, height: usize) -> Vec<u8> {
    let row_size = 1 + bytes_per_row;
    let mut filtered = vec![0u8; height * row_size];
    for y in 0..height {
        let out_row = y * row_size;
        filtered[out_row] = 2;

        let src_row = y * bytes_per_row;
        let prev_row = (y.saturating_sub(1)) * bytes_per_row;
        for byte_index in 0..bytes_per_row {
            let current = pixels[src_row + byte_index];
            let above = if y > 0 {
                pixels[prev_row + byte_index]
            } else {
                0
            };
            filtered[out_row + 1 + byte_index] = current.wrapping_sub(above);
        }
    }
    filtered
}

fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
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
    use std::{
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

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

    #[test]
    fn parses_netpbm_comments_and_payload() {
        let data = b"P6\n# generated by ddjvu\n2 1\n255\n\x01\x01\x01\x02\x03\x04";
        let netpbm = parse_netpbm(data).unwrap();

        assert_eq!(netpbm.width, 2);
        assert_eq!(netpbm.height, 1);
        assert_eq!(netpbm.channels, 3);
        assert_eq!(netpbm.pixels, &[1, 1, 1, 2, 3, 4]);
    }

    #[test]
    fn builds_grayscale_netpbm_pdf_image_payload() {
        let data = b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09";
        let page = read_netpbm_page(data, 1_000_000, 300).unwrap();

        assert_eq!(page.width, 2);
        assert_eq!(page.height, 1);
        assert_eq!(page.dpi, 300);
        assert_eq!(page.color_space, "DeviceGray");
        match page.payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                assert!(!data.is_empty());
                assert!(decode_params.contains("/Colors 1"));
                assert!(decode_params.contains("/Columns 2"));
            }
            ImagePayload::Jpeg { .. } => panic!("expected flate payload"),
        }
    }

    #[test]
    fn reads_tiff_pages_for_pdf_with_resolution() {
        let input_path = temp_tiff_path("pdf-input");
        write_rgb_tiff(&input_path, 2, 1, &[255, 0, 0, 0, 255, 0], 300);

        let pages = read_tiff_pdf_pages(&input_path, 1_000_000, None, 10).unwrap();

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
}
