use std::io::{self, Read, Write};

use crc32fast::Hasher;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use scan_primitives::{GrayImage, RgbImage};
use thiserror::Error;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const METERS_PER_INCH: f64 = 0.0254;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PassthroughLimits {
    pub max_pixels: u64,
    pub max_icc_profile_bytes: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodeLimits {
    pub max_pixels: u64,
    pub max_dimension: u32,
    pub max_compressed_bytes: usize,
}
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PngColorType {
    Gray8 = 0,
    Rgb8 = 2,
    GrayAlpha8 = 4,
    Rgba8 = 6,
}
impl PngColorType {
    fn channels(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Rgb8 => 3,
            Self::GrayAlpha8 => 2,
            Self::Rgba8 => 4,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompressedPng {
    pub width: u32,
    pub height: u32,
    pub color_type: PngColorType,
    pub dpi: Option<u32>,
    /// Concatenated original IDAT bytes; never decoded or re-encoded.
    pub idat: Vec<u8>,
    pub icc_profile: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedPng {
    pub gray: GrayImage,
    pub rgb: RgbImage,
}
#[derive(Clone, Copy, Debug)]
pub enum PixelBuffer<'a> {
    Gray {
        width: usize,
        height: usize,
        stride: usize,
        data: &'a [u8],
    },
    Rgb {
        width: usize,
        height: usize,
        stride: usize,
        data: &'a [u8],
    },
}
#[derive(Debug, Error)]
pub enum RasterError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}
impl RasterError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
}
pub fn read_png_passthrough<R: Read>(
    reader: R,
    limits: PassthroughLimits,
) -> Result<CompressedPng, RasterError> {
    let parsed = walk_chunks(reader, WalkMode::Passthrough(limits))?;
    validate_inflated_length(&parsed.idat, parsed.header.expected_data_len()?)?;
    Ok(CompressedPng {
        width: parsed.header.width,
        height: parsed.header.height,
        color_type: parsed.header.color_type,
        dpi: parsed.dpi,
        idat: parsed.idat,
        icc_profile: parsed.icc_profile,
    })
}
pub fn read_png_dimensions<R: Read>(
    reader: R,
    limits: DecodeLimits,
) -> Result<(usize, usize), RasterError> {
    let header = walk_chunks(reader, WalkMode::Dimensions(limits))?.header;
    Ok((header.width as usize, header.height as usize))
}
pub fn decode_png<R: Read>(reader: R, limits: DecodeLimits) -> Result<DecodedPng, RasterError> {
    let parsed = walk_chunks(reader, WalkMode::Decode(limits))?;
    let header = parsed.header;
    let channels = header.color_type.channels();
    let row_bytes = (header.width as usize)
        .checked_mul(channels)
        .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
    let expected = header.expected_data_len()?;
    let mut filtered = Vec::with_capacity(expected);
    ZlibDecoder::new(parsed.idat.as_slice())
        .take(expected.saturating_add(1) as u64)
        .read_to_end(&mut filtered)?;
    if filtered.len() != expected {
        return Err(RasterError::invalid(format!(
            "PNG decompressed payload length mismatch: expected {expected} bytes, got {}",
            filtered.len()
        )));
    }
    let width = header.width as usize;
    let height = header.height as usize;
    let mut gray = GrayImage::new(width, height, 255);
    let mut rgb = RgbImage::new(width, height, [255; 3]);
    let mut current = vec![0; row_bytes];
    let mut previous = vec![0; row_bytes];
    let mut position = 0usize;
    for y in 0..height {
        let filter = filtered[position];
        position += 1;
        current.copy_from_slice(&filtered[position..position + row_bytes]);
        position += row_bytes;
        unfilter(&mut current, &previous, channels, filter)?;
        for (x, pixel) in current.chunks_exact(channels).enumerate() {
            let (gray_value, rgb_value) = match header.color_type {
                PngColorType::Gray8 | PngColorType::GrayAlpha8 => (pixel[0], [pixel[0]; 3]),
                PngColorType::Rgb8 | PngColorType::Rgba8 => (
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                    [pixel[0], pixel[1], pixel[2]],
                ),
            };
            gray.set(x, y, gray_value);
            rgb.set(x, y, rgb_value);
        }
        std::mem::swap(&mut current, &mut previous);
    }
    Ok(DecodedPng { gray, rgb })
}
pub fn write_png<W: Write>(mut writer: W, pixels: PixelBuffer<'_>) -> Result<W, RasterError> {
    let (width, height, stride, data, color_type) = match pixels {
        PixelBuffer::Gray {
            width,
            height,
            stride,
            data,
        } => (width, height, stride, data, PngColorType::Gray8),
        PixelBuffer::Rgb {
            width,
            height,
            stride,
            data,
        } => (width, height, stride, data, PngColorType::Rgb8),
    };
    let width_u32 = u32::try_from(width).map_err(|_| RasterError::invalid("Invalid PNG width"))?;
    let height_u32 =
        u32::try_from(height).map_err(|_| RasterError::invalid("Invalid PNG height"))?;
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("PNG dimensions must be non-zero"));
    }
    let row_bytes = width
        .checked_mul(color_type.channels())
        .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
    if stride < row_bytes {
        return Err(RasterError::invalid("PNG stride is shorter than its row"));
    }
    let required = (height - 1)
        .checked_mul(stride)
        .and_then(|value| value.checked_add(row_bytes))
        .ok_or_else(|| RasterError::invalid("PNG pixel buffer length overflow"))?;
    if data.len() < required {
        return Err(RasterError::invalid("PNG pixel buffer is too short"));
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    for y in 0..height {
        let start = y * stride;
        encoder.write_all(&[0])?;
        encoder.write_all(&data[start..start + row_bytes])?;
    }
    let compressed = encoder.finish()?;
    writer.write_all(PNG_SIGNATURE)?;
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width_u32.to_be_bytes());
    ihdr.extend_from_slice(&height_u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type as u8, 0, 0, 0]);
    write_chunk(&mut writer, b"IHDR", &ihdr)?;
    write_chunk(&mut writer, b"IDAT", &compressed)?;
    write_chunk(&mut writer, b"IEND", &[])?;
    Ok(writer)
}
pub fn encode_png(pixels: PixelBuffer<'_>) -> Result<Vec<u8>, RasterError> {
    write_png(Vec::new(), pixels)
}
pub fn decode_p4(
    bytes: &[u8],
    max_pixels: u64,
    max_dimension: u32,
) -> Result<GrayImage, RasterError> {
    if bytes.get(..3) != Some(b"P4\n") {
        return Err(RasterError::invalid("Invalid PBM P4 signature"));
    }
    let dimensions_end = bytes[3..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| offset + 3)
        .ok_or_else(|| RasterError::invalid("Truncated PBM P4 header"))?;
    let dimensions = std::str::from_utf8(&bytes[3..dimensions_end])
        .map_err(|_| RasterError::invalid("Invalid PBM P4 dimensions"))?
        .split_ascii_whitespace()
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| RasterError::invalid("Invalid PBM P4 dimensions"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dimensions.len() != 2 {
        return Err(RasterError::invalid("Invalid PBM P4 dimensions"));
    }
    let (width, height) = (dimensions[0], dimensions[1]);
    if width == 0
        || height == 0
        || width > max_dimension as usize
        || height > max_dimension as usize
        || (width as u64).saturating_mul(height as u64) > max_pixels
    {
        return Err(RasterError::invalid(format!(
            "PBM P4 dimensions exceed guardrails: {width}x{height}"
        )));
    }
    let row_stride = width.div_ceil(8);
    let bitmap = bytes
        .get(dimensions_end + 1..)
        .ok_or_else(|| RasterError::invalid("Truncated PBM P4 payload"))?;
    if bitmap.len() != row_stride.saturating_mul(height) {
        return Err(RasterError::invalid("PBM P4 payload length mismatch"));
    }
    let mut image = GrayImage::new(width, height, 255);
    for y in 0..height {
        for x in 0..width {
            if bitmap[y * row_stride + x / 8] & (1 << (7 - x % 8)) != 0 {
                image.set(x, y, 0);
            }
        }
    }
    Ok(image)
}
pub fn encode_p4(image: &GrayImage) -> Result<Vec<u8>, RasterError> {
    if image.width() == 0 || image.height() == 0 {
        return Err(RasterError::invalid("PBM P4 dimensions must be positive"));
    }
    let row_stride = image
        .width()
        .checked_add(7)
        .ok_or_else(|| RasterError::invalid("PBM P4 row stride overflow"))?
        / 8;
    let bitmap_len = row_stride
        .checked_mul(image.height())
        .ok_or_else(|| RasterError::invalid("PBM P4 payload size overflow"))?;
    let header = format!("P4\n{} {}\n", image.width(), image.height());
    let mut bytes = Vec::with_capacity(header.len().saturating_add(bitmap_len));
    bytes.extend_from_slice(header.as_bytes());
    for y in 0..image.height() {
        let row_start = bytes.len();
        bytes.resize(row_start + row_stride, 0);
        for (x, pixel) in image.row(y).iter().copied().enumerate() {
            match pixel {
                0 => bytes[row_start + x / 8] |= 1 << (7 - x % 8),
                255 => {}
                value => {
                    return Err(RasterError::invalid(format!(
                        "PBM P4 source contains non-binary sample {value} at ({x}, {y})"
                    )));
                }
            }
        }
    }
    Ok(bytes)
}
#[derive(Clone, Copy)]
enum WalkMode {
    Dimensions(DecodeLimits),
    Passthrough(PassthroughLimits),
    Decode(DecodeLimits),
}
#[derive(Clone, Copy)]
struct PngHeader {
    width: u32,
    height: u32,
    color_type: PngColorType,
}
impl PngHeader {
    fn expected_data_len(self) -> Result<usize, RasterError> {
        (self.width as usize)
            .checked_mul(self.color_type.channels())
            .and_then(|value| value.checked_add(1))
            .and_then(|value| value.checked_mul(self.height as usize))
            .ok_or_else(|| RasterError::invalid("Invalid PNG image data length"))
    }
}
struct WalkedPng {
    header: PngHeader,
    dpi: Option<u32>,
    idat: Vec<u8>,
    icc_profile: Option<Vec<u8>>,
}
fn walk_chunks<R: Read>(mut reader: R, mode: WalkMode) -> Result<WalkedPng, RasterError> {
    let mut signature = [0u8; 8];
    reader.read_exact(&mut signature)?;
    if &signature != PNG_SIGNATURE {
        return Err(RasterError::invalid("Invalid PNG signature"));
    }
    let mut header = None;
    let mut dpi = None;
    let mut idat = Vec::new();
    let mut icc_profile = None;
    loop {
        let mut chunk_header = [0u8; 8];
        reader.read_exact(&mut chunk_header)?;
        let length = u32::from_be_bytes(chunk_header[..4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = chunk_header[4..].try_into().unwrap();
        let mut hasher = Hasher::new();
        hasher.update(&kind);

        match &kind {
            b"IHDR" => {
                if length != 13 || header.is_some() {
                    return Err(RasterError::invalid("Invalid PNG IHDR"));
                }
                let mut data = [0u8; 13];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                header = Some(parse_header(&data, mode)?);
            }
            b"pHYs" if length == 9 => {
                let mut data = [0u8; 9];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                if matches!(mode, WalkMode::Passthrough(_)) {
                    dpi = read_phys_dpi(&data);
                }
            }
            b"iCCP" if matches!(mode, WalkMode::Passthrough(_)) => {
                if icc_profile.is_some() {
                    return Err(RasterError::invalid("Duplicate PNG iCCP profile"));
                }
                let WalkMode::Passthrough(limits) = mode else {
                    unreachable!()
                };
                if length > limits.max_icc_profile_bytes {
                    return Err(RasterError::invalid(format!(
                        "PNG compressed ICC profile exceeds the {}-byte safety limit",
                        limits.max_icc_profile_bytes
                    )));
                }
                let mut data = vec![0; length];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                icc_profile = Some(decode_icc_profile(&data, limits.max_icc_profile_bytes)?);
            }
            b"IDAT" => {
                let parsed_header =
                    header.ok_or_else(|| RasterError::invalid("PNG IDAT appeared before IHDR"))?;
                let compressed_limit = match mode {
                    WalkMode::Passthrough(_) => {
                        max_png_compressed_length(parsed_header.expected_data_len()?)?
                    }
                    WalkMode::Decode(limits) => limits.max_compressed_bytes,
                    WalkMode::Dimensions(_) => {
                        return Err(RasterError::invalid(
                            "PNG IDAT appeared before IHDR admission",
                        ));
                    }
                };
                let end = idat
                    .len()
                    .checked_add(length)
                    .ok_or_else(|| RasterError::invalid("PNG compressed payload overflow"))?;
                if end > compressed_limit {
                    return Err(RasterError::invalid(format!(
                        "PNG compressed image data exceeds the {compressed_limit}-byte safety limit"
                    )));
                }
                idat.try_reserve_exact(length)
                    .map_err(|_| RasterError::invalid("Unable to reserve PNG image data"))?;
                let start = idat.len();
                idat.resize(end, 0);
                read_chunk_bytes(&mut reader, &mut idat[start..], &mut hasher)?;
            }
            b"IEND" => {
                if length != 0 {
                    return Err(RasterError::invalid("Invalid PNG IEND length"));
                }
            }
            _ => skip_chunk_bytes(&mut reader, length, &mut hasher)?,
        }
        let mut expected_crc = [0u8; 4];
        reader.read_exact(&mut expected_crc)?;
        if !matches!(mode, WalkMode::Passthrough(_))
            && hasher.finalize() != u32::from_be_bytes(expected_crc)
        {
            return Err(RasterError::invalid("PNG chunk CRC mismatch"));
        }
        let parsed_header = header;
        if matches!(mode, WalkMode::Dimensions(_)) {
            if let Some(header) = parsed_header {
                return Ok(WalkedPng {
                    header,
                    dpi: None,
                    idat,
                    icc_profile: None,
                });
            }
        }
        if &kind == b"IEND" {
            let header = parsed_header.ok_or_else(|| RasterError::invalid("Missing PNG IHDR"))?;
            if idat.is_empty() {
                return Err(RasterError::invalid("Missing PNG image data"));
            }
            return Ok(WalkedPng {
                header,
                dpi,
                idat,
                icc_profile,
            });
        }
    }
}
fn parse_header(data: &[u8; 13], mode: WalkMode) -> Result<PngHeader, RasterError> {
    let width = u32::from_be_bytes(data[..4].try_into().unwrap());
    let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
    let color_type = match data[9] {
        0 => PngColorType::Gray8,
        2 => PngColorType::Rgb8,
        4 => PngColorType::GrayAlpha8,
        6 => PngColorType::Rgba8,
        value => {
            return Err(RasterError::invalid(format!(
                "Unsupported PNG color type: {value}"
            )));
        }
    };
    let (max_pixels, max_dimension) = match mode {
        WalkMode::Passthrough(limits) => (limits.max_pixels, None),
        WalkMode::Dimensions(limits) | WalkMode::Decode(limits) => {
            (limits.max_pixels, Some(limits.max_dimension))
        }
    };
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > max_pixels {
        return Err(RasterError::invalid(format!(
            "PNG dimensions exceed pixel guardrails: {width}x{height}"
        )));
    }
    if let Some(max_dimension) = max_dimension {
        if width > max_dimension || height > max_dimension {
            return Err(RasterError::invalid(format!(
                "PNG dimensions exceed cleanup guardrails: {width}x{height}"
            )));
        }
    }
    if data[8] != 8 || data[10] != 0 || data[11] != 0 || data[12] != 0 {
        return Err(RasterError::invalid(
            "Only non-interlaced 8-bit grayscale/RGB/RGBA PNG is supported",
        ));
    }
    if matches!(mode, WalkMode::Passthrough(_))
        && !matches!(color_type, PngColorType::Gray8 | PngColorType::Rgb8)
    {
        return Err(RasterError::invalid(format!(
            "Unsupported PNG color type: {}",
            color_type as u8
        )));
    }
    Ok(PngHeader {
        width,
        height,
        color_type,
    })
}
fn read_chunk_bytes<R: Read>(
    reader: &mut R,
    data: &mut [u8],
    hasher: &mut Hasher,
) -> Result<(), RasterError> {
    reader.read_exact(data)?;
    hasher.update(data);
    Ok(())
}
fn skip_chunk_bytes<R: Read>(
    reader: &mut R,
    mut length: usize,
    hasher: &mut Hasher,
) -> Result<(), RasterError> {
    let mut buffer = [0u8; 8192];
    while length > 0 {
        let count = length.min(buffer.len());
        read_chunk_bytes(reader, &mut buffer[..count], hasher)?;
        length -= count;
    }
    Ok(())
}
fn decode_icc_profile(data: &[u8], limit: usize) -> Result<Vec<u8>, RasterError> {
    let name_end = data
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| RasterError::invalid("Invalid PNG iCCP profile name"))?;
    if name_end == 0 || name_end > 79 || data.get(name_end + 1) != Some(&0) {
        return Err(RasterError::invalid("Invalid PNG iCCP profile header"));
    }
    let compressed = data
        .get(name_end + 2..)
        .ok_or_else(|| RasterError::invalid("Invalid PNG iCCP payload"))?;
    let mut profile = Vec::new();
    ZlibDecoder::new(compressed)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut profile)?;
    if profile.len() > limit {
        return Err(RasterError::invalid(format!(
            "PNG ICC profile exceeds the {limit}-byte safety limit"
        )));
    }
    Ok(profile)
}
fn validate_inflated_length(idat: &[u8], expected: usize) -> Result<(), RasterError> {
    let mut decoder = ZlibDecoder::new(idat);
    let mut buffer = [0u8; 8192];
    let mut decoded = 0usize;
    loop {
        let count = expected
            .saturating_sub(decoded)
            .saturating_add(1)
            .min(buffer.len());
        let read = decoder.read(&mut buffer[..count])?;
        if read == 0 {
            break;
        }
        decoded = decoded
            .checked_add(read)
            .ok_or_else(|| RasterError::invalid("PNG image data length overflow"))?;
        if decoded > expected {
            return Err(RasterError::invalid(format!(
                "PNG image data is longer than expected: expected {expected} bytes"
            )));
        }
    }
    if decoded != expected {
        return Err(RasterError::invalid(format!(
            "PNG image data length mismatch: expected {expected} bytes, got {decoded}"
        )));
    }
    Ok(())
}
fn max_png_compressed_length(uncompressed: usize) -> Result<usize, RasterError> {
    uncompressed
        .checked_add(uncompressed >> 12)
        .and_then(|value| value.checked_add(uncompressed >> 14))
        .and_then(|value| value.checked_add(uncompressed >> 25))
        .and_then(|value| value.checked_add(64))
        .ok_or_else(|| RasterError::invalid("Invalid PNG compressed image data limit"))
}
fn read_phys_dpi(data: &[u8; 9]) -> Option<u32> {
    let x = u32::from_be_bytes(data[..4].try_into().unwrap());
    let y = u32::from_be_bytes(data[4..8].try_into().unwrap());
    if data[8] == 1 && (x > 0 || y > 0) {
        let dpi = (f64::from(x.max(y)) * METERS_PER_INCH).round() as u32;
        (dpi > 0).then_some(dpi)
    } else {
        None
    }
}
fn unfilter(
    row: &mut [u8],
    previous: &[u8],
    channels: usize,
    filter: u8,
) -> Result<(), RasterError> {
    for index in 0..row.len() {
        let prior = index.checked_sub(channels);
        let left = prior.map_or(0, |index| row[index]);
        let up = previous[index];
        let upper_left = prior.map_or(0, |index| previous[index]);
        row[index] = row[index].wrapping_add(match filter {
            0 => 0,
            1 => left,
            2 => up,
            3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
            4 => paeth(left, up, upper_left),
            _ => {
                return Err(RasterError::invalid(format!(
                    "Unsupported PNG filter: {filter}"
                )));
            }
        });
    }
    Ok(())
}
fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let prediction = i32::from(left) + i32::from(up) - i32::from(upper_left);
    let distances = (
        (prediction - i32::from(left)).abs(),
        (prediction - i32::from(up)).abs(),
        (prediction - i32::from(upper_left)).abs(),
    );
    if distances.0 <= distances.1 && distances.0 <= distances.2 {
        left
    } else if distances.1 <= distances.2 {
        up
    } else {
        upper_left
    }
}
fn write_chunk<W: Write>(writer: &mut W, kind: &[u8; 4], data: &[u8]) -> Result<(), RasterError> {
    let length =
        u32::try_from(data.len()).map_err(|_| RasterError::invalid("PNG chunk exceeds u32"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(kind)?;
    writer.write_all(data)?;
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    writer.write_all(&hasher.finalize().to_be_bytes())?;
    Ok(())
}
