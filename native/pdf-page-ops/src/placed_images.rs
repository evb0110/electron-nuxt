struct JpegInfo {
    width: u16,
    height: u16,
    components: u8,
}

struct PlacedImageGeometry {
    rect: PdfRect,
    bbox_width: f64,
    bbox_height: f64,
    image_x: f64,
    image_y: f64,
    width: f64,
    height: f64,
    rotation_degrees: f64,
}

fn parse_jpeg_info(bytes: &[u8]) -> Result<JpegInfo> {
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
                return Err("Unsupported JPEG color format".into());
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

fn is_jpeg_start_of_frame_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

fn placed_image_annotation_name(image: &PlacedImage, index: usize, modified_at: &str) -> String {
    format!(
        "placed-image-native:{}:{}:{}",
        image.page_index, index, modified_at
    )
}

fn placed_image_geometry(
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

fn pdf_content_number(value: f64) -> String {
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

fn build_jpeg_image_stream(image: &PlacedImage, info: &JpegInfo) -> Stream {
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
    Stream::new(dict, image.bytes.clone())
}

fn build_placed_image_appearance_stream(
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

fn build_placed_image_stamp_dict(
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

fn apply_placed_images(
    document: &mut Document,
    images: &[PlacedImage],
    modified_at: &str,
) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    for (index, image) in images.iter().enumerate() {
        let page_number = image
            .page_index
            .checked_add(1)
            .ok_or("Invalid placed image page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let jpeg_info = parse_jpeg_info(&image.bytes)?;
        let geometry = placed_image_geometry(image, page_view, page_rotation)?;
        let image_ref = document.add_object(build_jpeg_image_stream(image, &jpeg_info));
        let image_name = format!("Im{}", image_ref.0);
        let appearance_ref =
            document.add_object(build_placed_image_appearance_stream(image_ref, &geometry, &image_name));
        let stamp_ref = document.new_object_id();
        let stamp_dict =
            build_placed_image_stamp_dict(image, &geometry, appearance_ref, index, modified_at);
        document.set_object(stamp_ref, Object::Dictionary(stamp_dict));
        append_annots_to_page(document, page_id, &[stamp_ref])?;
    }
    Ok(())
}

fn apply_placed_images_incremental(
    incremental: &mut IncrementalDocument,
    images: &[PlacedImage],
    modified_at: &str,
) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }

    let page_map = incremental.get_prev_documents().get_pages();
    for (index, image) in images.iter().enumerate() {
        let page_number = image
            .page_index
            .checked_add(1)
            .ok_or("Invalid placed image page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let jpeg_info = parse_jpeg_info(&image.bytes)?;
        let geometry = placed_image_geometry(image, page_view, page_rotation)?;
        let image_ref = incremental
            .new_document
            .add_object(build_jpeg_image_stream(image, &jpeg_info));
        let image_name = format!("Im{}", image_ref.0);
        let appearance_ref = incremental
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
        append_annots_to_page_incremental(incremental, page_id, &[stamp_ref])?;
    }
    Ok(())
}
