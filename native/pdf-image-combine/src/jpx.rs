use hayro_jpeg2000::{DecodeSettings, Image};

use crate::Result;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct JpxMetadata {
    pub width: u32,
    pub height: u32,
    pub components: u16,
    pub bits_per_component: u8,
}

const SIGNATURE_BOX: &[u8; 12] = b"\0\0\0\x0cjP  \r\n\x87\n";

fn be_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or("Truncated JPEG 2000 box")?;
    Ok(u32::from_be_bytes(value.try_into()?))
}

fn be_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or("Truncated JPEG 2000 extended box")?;
    Ok(u64::from_be_bytes(value.try_into()?))
}

fn walk_boxes(
    bytes: &[u8],
    start: usize,
    end: usize,
    mut visit: impl FnMut(&[u8; 4], usize, usize) -> Result<bool>,
) -> Result<bool> {
    let mut offset = start;
    while offset < end {
        let short_length = be_u32(bytes, offset)?;
        let box_type: &[u8; 4] = bytes
            .get(offset + 4..offset + 8)
            .ok_or("Truncated JPEG 2000 box type")?
            .try_into()?;
        let (header_length, box_length) = match short_length {
            0 => (8usize, end - offset),
            1 => {
                let extended = usize::try_from(be_u64(bytes, offset + 8)?)
                    .map_err(|_| "JPEG 2000 box is too large")?;
                (16usize, extended)
            }
            value => (8usize, value as usize),
        };
        if box_length < header_length {
            return Err("Invalid JPEG 2000 box length".into());
        }
        let box_end = offset
            .checked_add(box_length)
            .filter(|value| *value <= end)
            .ok_or("JPEG 2000 box exceeds its container")?;
        if visit(box_type, offset + header_length, box_end)? {
            return Ok(true);
        }
        offset = box_end;
    }
    Ok(false)
}

pub(crate) fn parse_jpx_metadata(bytes: &[u8]) -> Result<JpxMetadata> {
    if bytes.get(..SIGNATURE_BOX.len()) != Some(SIGNATURE_BOX) {
        return Err("Invalid JPEG 2000 JP2 signature".into());
    }
    let mut metadata = None;
    walk_boxes(
        bytes,
        SIGNATURE_BOX.len(),
        bytes.len(),
        |box_type, start, end| {
            if box_type != b"jp2h" {
                return Ok(false);
            }
            walk_boxes(bytes, start, end, |child_type, child_start, child_end| {
                if child_type != b"ihdr" {
                    return Ok(false);
                }
                if child_end.saturating_sub(child_start) < 14 {
                    return Err("Truncated JPEG 2000 image header".into());
                }
                let height = be_u32(bytes, child_start)?;
                let width = be_u32(bytes, child_start + 4)?;
                let components =
                    u16::from_be_bytes(bytes[child_start + 8..child_start + 10].try_into()?);
                let encoded_bpc = bytes[child_start + 10];
                if encoded_bpc == 255 {
                    return Err("Variable JPEG 2000 component depths are unsupported".into());
                }
                let bits_per_component = (encoded_bpc & 0x7f).saturating_add(1);
                metadata = Some(JpxMetadata {
                    width,
                    height,
                    components,
                    bits_per_component,
                });
                Ok(true)
            })
        },
    )?;
    let metadata = metadata.ok_or("JPEG 2000 JP2 image header is missing")?;
    if metadata.width == 0 || metadata.height == 0 {
        return Err("JPEG 2000 dimensions must be positive".into());
    }
    if !matches!(metadata.components, 1 | 3) {
        return Err(format!(
            "Unsupported JPEG 2000 component count: {}",
            metadata.components
        )
        .into());
    }
    if metadata.bits_per_component != 8 {
        return Err(format!(
            "Unsupported JPEG 2000 component depth: {}",
            metadata.bits_per_component
        )
        .into());
    }
    Ok(metadata)
}

pub(crate) fn validate_jpx_codestream(bytes: &[u8], metadata: JpxMetadata) -> Result<()> {
    let settings = DecodeSettings {
        strict: true,
        ..DecodeSettings::default()
    };
    let image = Image::new(bytes, &settings)
        .map_err(|error| format!("JPEG 2000 payload is not decodable: {error}"))?;
    if image.width() != metadata.width
        || image.height() != metadata.height
        || image.original_bit_depth() != metadata.bits_per_component
        || image.has_alpha()
        || u16::from(image.color_space().num_channels()) != metadata.components
    {
        return Err("JPEG 2000 codestream does not match its image header".into());
    }
    image
        .decode()
        .map(|_| ())
        .map_err(|error| format!("JPEG 2000 payload is not decodable: {error}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_jp2_bytes() {
        assert!(parse_jpx_metadata(b"not a jp2").is_err());
    }
}
