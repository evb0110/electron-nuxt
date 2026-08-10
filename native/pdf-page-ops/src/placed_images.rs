use super::*;
use sha2::{Digest, Sha256};

const MAX_PLACED_IMAGE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PLACED_IMAGE_AGGREGATE_BYTES: u64 = 512 * 1024 * 1024;
const PLACED_IMAGE_READ_CHUNK_BYTES: usize = 64 * 1024;

fn digest_hex(digest: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    digest_hex(&Sha256::digest(bytes))
}

pub(crate) fn validate_placed_image_payloads(images: &[PlacedImage]) -> Result<Vec<Vec<u8>>> {
    validate_placed_image_payloads_with_limits_and_open(
        images,
        MAX_PLACED_IMAGE_BYTES,
        MAX_PLACED_IMAGE_AGGREGATE_BYTES,
        |path| File::open(path),
    )
}

pub(crate) fn take_or_validate_placed_image_payloads(
    mutations: &NativeMutationsFile,
) -> Result<Vec<Vec<u8>>> {
    if mutations
        .placed_images
        .iter()
        .any(|image| image.validated_bytes.borrow().is_none())
    {
        validate_placed_images(&mutations.placed_images)?;
    }
    mutations
        .placed_images
        .iter()
        .map(|image| {
            image
                .validated_bytes
                .borrow_mut()
                .take()
                .ok_or_else(|| "Placed image validation cache is missing".into())
        })
        .collect()
}

pub(crate) fn validate_placed_image_payloads_with_limits_and_open(
    images: &[PlacedImage],
    max_image_bytes: u64,
    max_aggregate_bytes: u64,
    mut open: impl FnMut(&Path) -> std::io::Result<File>,
) -> Result<Vec<Vec<u8>>> {
    let mut admitted_lengths = Vec::with_capacity(images.len());
    let mut aggregate_bytes = 0u64;
    for image in images {
        if image.byte_length == 0 || image.byte_length > max_image_bytes {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Invalid placed image byte length",
            ));
        }
        if image.sha256.len() != 64 {
            return Err(domain_error(
                NativeErrorCode::InvalidRequest,
                "Placed image sidecar hash does not match its manifest",
            ));
        }
        let image_len = fs::metadata(&image.bytes_path)?.len();
        if image_len == 0 || image_len > max_image_bytes {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Invalid placed image byte length",
            ));
        }
        if image_len != image.byte_length {
            return Err(domain_error(
                NativeErrorCode::InvalidRequest,
                "Placed image sidecar byte length does not match its manifest",
            ));
        }
        aggregate_bytes = aggregate_bytes.saturating_add(image_len);
        if aggregate_bytes > max_aggregate_bytes {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "Placed images exceed the {max_aggregate_bytes}-byte aggregate admission ceiling"
                ),
            ));
        }
        admitted_lengths.push(image_len);
    }

    images
        .iter()
        .zip(admitted_lengths)
        .map(|(image, admitted_len)| {
            let capacity = usize::try_from(admitted_len).map_err(|_| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Invalid placed image byte length",
                )
            })?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(capacity).map_err(|_| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Invalid placed image byte length",
                )
            })?;
            let mut reader = open(&image.bytes_path)?.take(admitted_len.saturating_add(1));
            let mut hasher = Sha256::new();
            let mut chunk = [0u8; PLACED_IMAGE_READ_CHUNK_BYTES];
            loop {
                let read = reader.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                let next_len = bytes.len().saturating_add(read);
                if next_len > capacity {
                    return Err(domain_error(
                        NativeErrorCode::InvalidRequest,
                        "Placed image sidecar byte length does not match its manifest",
                    ));
                }
                hasher.update(&chunk[..read]);
                bytes.extend_from_slice(&chunk[..read]);
            }
            if bytes.len() != capacity {
                return Err(domain_error(
                    NativeErrorCode::InvalidRequest,
                    "Placed image sidecar byte length does not match its manifest",
                ));
            }
            let digest = digest_hex(&hasher.finalize());
            if !digest.eq_ignore_ascii_case(&image.sha256) {
                return Err(domain_error(
                    NativeErrorCode::InvalidRequest,
                    "Placed image sidecar hash does not match its manifest",
                ));
            }
            Ok(bytes)
        })
        .collect()
}

pub(crate) struct JpegInfo {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) components: u8,
}

pub(crate) struct PlacedImageGeometry {
    pub(crate) rect: PdfRect,
    pub(crate) bbox_width: f64,
    pub(crate) bbox_height: f64,
    pub(crate) image_x: f64,
    pub(crate) image_y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) rotation_degrees: f64,
}

pub(crate) fn parse_jpeg_info(bytes: &[u8]) -> Result<JpegInfo> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("Placed image is not a JPEG file".into());
    }

    let mut offset = 2usize;
    while offset + 3 < bytes.len() {
        if bytes[offset] != 0xFF {
            offset += 1;
            continue;
        }
        while offset < bytes.len() && bytes[offset] == 0xFF {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xD9 {
            break;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            continue;
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let segment_len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if segment_len < 2 || offset + segment_len > bytes.len() {
            return Err("Invalid JPEG segment length".into());
        }
        let segment_start = offset + 2;
        let segment_end = offset + segment_len;
        if is_jpeg_start_of_frame_marker(marker) {
            if segment_end < segment_start + 6 {
                return Err("Invalid JPEG frame header".into());
            }
            let precision = bytes[segment_start];
            let height = u16::from_be_bytes([bytes[segment_start + 1], bytes[segment_start + 2]]);
            let width = u16::from_be_bytes([bytes[segment_start + 3], bytes[segment_start + 4]]);
            let components = bytes[segment_start + 5];
            if precision != 8 || width == 0 || height == 0 || !matches!(components, 1 | 3) {
                return Err(domain_error(
                    NativeErrorCode::UnsupportedFilter,
                    "Unsupported JPEG color format",
                ));
            }
            return Ok(JpegInfo {
                width,
                height,
                components,
            });
        }
        offset = segment_end;
    }

    Err("JPEG dimensions were not found".into())
}

pub(crate) fn is_jpeg_start_of_frame_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

pub(crate) fn placed_image_annotation_name(
    image: &PlacedImage,
    index: usize,
    modified_at: &str,
) -> String {
    format!(
        "placed-image-native:{}:{}:{}",
        image.page_index, index, modified_at
    )
}

pub(crate) fn placed_image_geometry(
    image: &PlacedImage,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PlacedImageGeometry> {
    let pdf_rect = marker_rect_to_pdf_rect(
        MarkerRect {
            left: image.x,
            top: image.y,
            width: image.width,
            height: image.height,
        },
        page_view,
        page_rotation,
    )?;
    let x = pdf_rect.x1.min(pdf_rect.x2);
    let y = pdf_rect.y1.min(pdf_rect.y2);
    let width = (pdf_rect.x2 - pdf_rect.x1).abs();
    let height = (pdf_rect.y2 - pdf_rect.y1).abs();
    if width <= 0.0 || height <= 0.0 {
        return Err("Invalid placed image dimensions".into());
    }

    let rotation_degrees = 0.0 - image.rotation_degrees.unwrap_or(0.0);
    let radians = rotation_degrees.to_radians();
    let abs_cos = radians.cos().abs();
    let abs_sin = radians.sin().abs();
    let bbox_width = (width * abs_cos) + (height * abs_sin);
    let bbox_height = (width * abs_sin) + (height * abs_cos);
    let bbox_center_x = bbox_width / 2.0;
    let bbox_center_y = bbox_height / 2.0;
    let cos = radians.cos();
    let sin = radians.sin();
    let rotated_half_width = ((width / 2.0) * cos) - ((height / 2.0) * sin);
    let rotated_half_height = ((width / 2.0) * sin) + ((height / 2.0) * cos);
    let image_x = bbox_center_x - rotated_half_width;
    let image_y = bbox_center_y - rotated_half_height;
    let rect_offset_x = (bbox_width - width) / 2.0;
    let rect_offset_y = (bbox_height - height) / 2.0;

    Ok(PlacedImageGeometry {
        rect: PdfRect {
            x1: x - rect_offset_x,
            y1: y - rect_offset_y,
            x2: x + width + rect_offset_x,
            y2: y + height + rect_offset_y,
        },
        bbox_width,
        bbox_height,
        image_x,
        image_y,
        width,
        height,
        rotation_degrees,
    })
}

pub(crate) fn pdf_content_number(value: f64) -> String {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001 {
        return format!("{rounded:.0}");
    }
    let mut formatted = format!("{value:.6}");
    while formatted.contains('.') && formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

pub(crate) fn build_jpeg_image_stream(bytes: Vec<u8>, info: &JpegInfo) -> Stream {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Image".to_vec()));
    dict.set("Width", Object::Integer(i64::from(info.width)));
    dict.set("Height", Object::Integer(i64::from(info.height)));
    dict.set("BitsPerComponent", Object::Integer(8));
    dict.set(
        "ColorSpace",
        Object::Name(match info.components {
            1 => b"DeviceGray".to_vec(),
            _ => b"DeviceRGB".to_vec(),
        }),
    );
    dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    Stream::new(dict, bytes)
}

pub(crate) fn build_placed_image_appearance_stream(
    image_ref: ObjectId,
    geometry: &PlacedImageGeometry,
    image_name: &str,
) -> Stream {
    let radians = geometry.rotation_degrees.to_radians();
    let a = geometry.width * radians.cos();
    let b = geometry.width * radians.sin();
    let c = -geometry.height * radians.sin();
    let d = geometry.height * radians.cos();
    let content = format!(
        "q\n{} {} {} {} {} {} cm\n/{image_name} Do\nQ\n",
        pdf_content_number(a),
        pdf_content_number(b),
        pdf_content_number(c),
        pdf_content_number(d),
        pdf_content_number(geometry.image_x),
        pdf_content_number(geometry.image_y),
    )
    .into_bytes();

    let mut xobjects = Dictionary::new();
    xobjects.set(image_name, Object::Reference(image_ref));
    let mut resources = Dictionary::new();
    resources.set("XObject", Object::Dictionary(xobjects));

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set(
        "BBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            number_object(geometry.bbox_width),
            number_object(geometry.bbox_height),
        ]),
    );
    dict.set(
        "Matrix",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
        ]),
    );
    dict.set("Resources", Object::Dictionary(resources));
    Stream::new(dict, content)
}

pub(crate) fn build_placed_image_stamp_dict(
    image: &PlacedImage,
    geometry: &PlacedImageGeometry,
    appearance_ref: ObjectId,
    index: usize,
    modified_at: &str,
) -> Dictionary {
    let mut ap_dict = Dictionary::new();
    ap_dict.set("N", Object::Reference(appearance_ref));

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(b"Stamp".to_vec()));
    dict.set("Rect", rect_object(geometry.rect));
    dict.set("AP", Object::Dictionary(ap_dict));
    dict.set("F", Object::Integer(4));
    dict.set(
        "NM",
        Object::String(
            encode_pdf_text_string(&placed_image_annotation_name(image, index, modified_at)),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("Name", Object::Name(b"Approved".to_vec()));
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict
}

pub(crate) fn apply_placed_images(
    document: &mut Document,
    images: &[PlacedImage],
    image_bytes: Vec<Vec<u8>>,
    modified_at: &str,
) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    if images.len() != image_bytes.len() {
        return Err("Placed image validation cache does not match its manifest".into());
    }
    let mut image_pages = Vec::with_capacity(images.len());
    let mut annotation_indexes = HashMap::new();
    for image in images {
        let page_number = image
            .page_index
            .checked_add(1)
            .ok_or("Invalid placed image page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            entry.insert(build_page_annotation_index(document, page_id)?.0);
        }
        image_pages.push(page_id);
    }
    for (index, ((image, image_bytes), page_id)) in
        images.iter().zip(image_bytes).zip(image_pages).enumerate()
    {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let jpeg_info = parse_jpeg_info(&image_bytes)?;
        let geometry = placed_image_geometry(image, page_view, page_rotation)?;
        let image_ref = document.add_object(build_jpeg_image_stream(image_bytes, &jpeg_info));
        let image_name = format!("Im{}", image_ref.0);
        let appearance_ref = document.add_object(build_placed_image_appearance_stream(
            image_ref,
            &geometry,
            &image_name,
        ));
        let stamp_ref = document.new_object_id();
        let stamp_dict =
            build_placed_image_stamp_dict(image, &geometry, appearance_ref, index, modified_at);
        document.set_object(stamp_ref, Object::Dictionary(stamp_dict));
        annotation_indexes
            .get_mut(&page_id)
            .expect("Placed-image pages are indexed before mutation")
            .append_missing_refs(&[stamp_ref]);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index(document, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn apply_placed_images_incremental(
    incremental: &mut IncrementalDocument,
    images: &[PlacedImage],
    image_bytes: Vec<Vec<u8>>,
    modified_at: &str,
) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }

    let page_map = incremental.get_prev_documents().get_pages();
    if images.len() != image_bytes.len() {
        return Err("Placed image validation cache does not match its manifest".into());
    }
    let mut image_pages = Vec::with_capacity(images.len());
    let mut annotation_indexes = HashMap::new();
    for image in images {
        let page_number = image
            .page_index
            .checked_add(1)
            .ok_or("Invalid placed image page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            entry.insert(build_page_annotation_index(incremental.get_prev_documents(), page_id)?.0);
        }
        image_pages.push(page_id);
    }
    for (index, ((image, image_bytes), page_id)) in
        images.iter().zip(image_bytes).zip(image_pages).enumerate()
    {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let jpeg_info = parse_jpeg_info(&image_bytes)?;
        let geometry = placed_image_geometry(image, page_view, page_rotation)?;
        let image_ref = incremental
            .new_document
            .add_object(build_jpeg_image_stream(image_bytes, &jpeg_info));
        let image_name = format!("Im{}", image_ref.0);
        let appearance_ref =
            incremental
                .new_document
                .add_object(build_placed_image_appearance_stream(
                    image_ref,
                    &geometry,
                    &image_name,
                ));
        let stamp_ref = incremental.new_document.new_object_id();
        let stamp_dict =
            build_placed_image_stamp_dict(image, &geometry, appearance_ref, index, modified_at);
        incremental
            .new_document
            .set_object(stamp_ref, Object::Dictionary(stamp_dict));
        annotation_indexes
            .get_mut(&page_id)
            .expect("Placed-image pages are indexed before mutation")
            .append_missing_refs(&[stamp_ref]);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index_incremental(incremental, page_id, index)?;
    }
    Ok(())
}
