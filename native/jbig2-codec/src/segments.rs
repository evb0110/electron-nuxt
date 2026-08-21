use crate::{generic, DecodeLimits, Jbig2Error, OwnedBilevel};

const PAGE_INFORMATION: u8 = 48;
const IMMEDIATE_GENERIC_REGION: u8 = 38;
const IMMEDIATE_LOSSLESS_GENERIC_REGION: u8 = 39;
const PAGE_INFORMATION_LENGTH: usize = 19;
const GENERIC_REGION_HEADER_LENGTH: usize = 26;
const NOMINAL_AT: [u8; 8] = [3, 0xff, 0xfd, 0xff, 2, 0xfe, 0xfe, 0xfe];

pub(crate) fn encode(
    width: u32,
    height: u32,
    rows: &[u8],
    stride: usize,
) -> Result<Vec<u8>, Jbig2Error> {
    let arithmetic = generic::encode(width, height, rows, stride);
    let region_length = GENERIC_REGION_HEADER_LENGTH
        .checked_add(arithmetic.len())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or(Jbig2Error::EncodedDataTooLarge)?;
    let capacity = 11usize
        .checked_add(PAGE_INFORMATION_LENGTH)
        .and_then(|length| length.checked_add(11))
        .and_then(|length| length.checked_add(region_length as usize))
        .ok_or(Jbig2Error::EncodedDataTooLarge)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|_| Jbig2Error::AllocationFailed)?;

    write_segment_header(
        &mut output,
        0,
        PAGE_INFORMATION,
        PAGE_INFORMATION_LENGTH as u32,
    );
    output.extend_from_slice(&width.to_be_bytes());
    output.extend_from_slice(&height.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.push(1);
    output.extend_from_slice(&0u16.to_be_bytes());

    write_segment_header(&mut output, 1, IMMEDIATE_GENERIC_REGION, region_length);
    output.extend_from_slice(&width.to_be_bytes());
    output.extend_from_slice(&height.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.push(0);
    output.push(0x08);
    output.extend_from_slice(&NOMINAL_AT);
    output.extend_from_slice(&arithmetic);
    Ok(output)
}

pub(crate) fn decode(
    data: &[u8],
    limits: DecodeLimits,
    require_canonical_arithmetic: bool,
) -> Result<OwnedBilevel, Jbig2Error> {
    let (page_header, page_data, remaining) = read_segment(data)?;
    if page_header.number != 0
        || page_header.segment_type != PAGE_INFORMATION
        || page_header.page != 1
        || page_data.len() != PAGE_INFORMATION_LENGTH
    {
        return Err(Jbig2Error::InvalidSegment("expected page information"));
    }

    let page_width = read_u32(page_data, 0)?;
    let page_height = read_u32(page_data, 4)?;
    if page_data[16] != 1 || page_data[17..19] != [0, 0] {
        return Err(Jbig2Error::Unsupported(
            "page information flags are not the generic lossless subset",
        ));
    }
    let stride = validate_dimensions(page_width, page_height, limits)?;

    let (region_header, region_data, trailing) = read_segment(remaining)?;
    if region_header.number != 1
        || !matches!(
            region_header.segment_type,
            IMMEDIATE_GENERIC_REGION | IMMEDIATE_LOSSLESS_GENERIC_REGION
        )
        || region_header.page != 1
    {
        return Err(Jbig2Error::InvalidSegment(
            "expected immediate generic region",
        ));
    }
    if !trailing.is_empty() {
        return Err(Jbig2Error::InvalidSegment(
            "unexpected data after generic region",
        ));
    }
    const GENERIC_REGION_BASE_HEADER_LENGTH: usize = 18;
    if region_data.len() < GENERIC_REGION_BASE_HEADER_LENGTH {
        return Err(Jbig2Error::Truncated);
    }

    let region_width = read_u32(region_data, 0)?;
    let region_height = read_u32(region_data, 4)?;
    let x = read_u32(region_data, 8)?;
    let y = read_u32(region_data, 12)?;
    if (region_width, region_height) != (page_width, page_height) || x != 0 || y != 0 {
        return Err(Jbig2Error::Unsupported(
            "generic region does not cover the page",
        ));
    }
    if region_data[16] != 0 {
        return Err(Jbig2Error::Unsupported(
            "generic region combination operator is not OR",
        ));
    }
    let generic_flags = region_data[17];
    if generic_flags & 1 != 0 {
        return generic::decode_mmr(
            region_width,
            region_height,
            stride,
            &region_data[GENERIC_REGION_BASE_HEADER_LENGTH..],
        );
    }
    const TEMPLATE_MASK: u8 = 0x06;
    const TYPICAL_PREDICTION: u8 = 0x08;
    if generic_flags & TEMPLATE_MASK != 0
        || generic_flags & !(TEMPLATE_MASK | TYPICAL_PREDICTION) != 0
    {
        return Err(Jbig2Error::UnsupportedGenericRegionFlags(generic_flags));
    }
    if region_data.len() < GENERIC_REGION_HEADER_LENGTH {
        return Err(Jbig2Error::Truncated);
    }
    if region_data[18..GENERIC_REGION_HEADER_LENGTH] != NOMINAL_AT {
        return Err(Jbig2Error::Unsupported(
            "generic region does not use nominal template 0 AT pixels",
        ));
    }

    generic::decode(
        region_width,
        region_height,
        stride,
        &region_data[GENERIC_REGION_HEADER_LENGTH..],
        generic_flags & TYPICAL_PREDICTION != 0,
        require_canonical_arithmetic,
    )
}

fn validate_dimensions(width: u32, height: u32, limits: DecodeLimits) -> Result<usize, Jbig2Error> {
    if width == 0 || height == 0 || width > limits.max_dimension || height > limits.max_dimension {
        return Err(Jbig2Error::InvalidDimensions { width, height });
    }
    let pixels = u64::from(width) * u64::from(height);
    let maximum = limits.max_pixels.min(DecodeLimits::HARD_MAX_PIXELS);
    if pixels > maximum {
        return Err(Jbig2Error::PixelLimitExceeded { pixels, maximum });
    }
    let stride = u64::from(width).div_ceil(8);
    usize::try_from(stride).map_err(|_| Jbig2Error::AllocationFailed)
}

fn write_segment_header(output: &mut Vec<u8>, number: u32, segment_type: u8, data_length: u32) {
    output.extend_from_slice(&number.to_be_bytes());
    output.push(segment_type);
    output.push(0);
    output.push(1);
    output.extend_from_slice(&data_length.to_be_bytes());
}

struct SegmentHeader {
    number: u32,
    segment_type: u8,
    page: u32,
}

fn read_segment(data: &[u8]) -> Result<(SegmentHeader, &[u8], &[u8]), Jbig2Error> {
    if data.len() < 6 {
        return Err(Jbig2Error::Truncated);
    }
    let number = read_u32(data, 0)?;
    let flags = data[4];
    let segment_type = flags & 0x3f;
    let long_page_association = flags & 0x40 != 0;
    let referred = data[5] >> 5;
    if referred != 0 {
        return Err(Jbig2Error::Unsupported(
            "referred-to segments are not supported",
        ));
    }

    let mut position = 6;
    let page = if long_page_association {
        let page = read_u32(data, position)?;
        position += 4;
        page
    } else {
        let page = *data.get(position).ok_or(Jbig2Error::Truncated)?;
        position += 1;
        u32::from(page)
    };
    let length = read_u32(data, position)?;
    position += 4;
    if length == u32::MAX {
        return Err(Jbig2Error::Unsupported(
            "unknown segment data lengths are not supported",
        ));
    }
    let length = usize::try_from(length).map_err(|_| Jbig2Error::Truncated)?;
    let end = position
        .checked_add(length)
        .filter(|end| *end <= data.len())
        .ok_or(Jbig2Error::Truncated)?;

    Ok((
        SegmentHeader {
            number,
            segment_type,
            page,
        },
        &data[position..end],
        &data[end..],
    ))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, Jbig2Error> {
    let bytes = data.get(offset..offset + 4).ok_or(Jbig2Error::Truncated)?;
    Ok(u32::from_be_bytes(
        bytes.try_into().map_err(|_| Jbig2Error::Truncated)?,
    ))
}
