use crate::{binary::read_u16_be, Result, CM_PER_INCH};

const JPEG_APP0_MARKER: u8 = 0xE0;
const JPEG_START_OF_SCAN_MARKER: u8 = 0xDA;

pub(crate) struct JpegMetadata {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) components: u8,
    pub(crate) dpi: Option<u32>,
}

pub(crate) fn parse_jpeg_metadata(bytes: &[u8]) -> Result<JpegMetadata> {
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
