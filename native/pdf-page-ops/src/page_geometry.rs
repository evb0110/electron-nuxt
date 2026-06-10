fn normalize_page_rotation(value: i64) -> i64 {
    let snapped = ((value as f64) / 90.0).round() as i64 * 90;
    let normalized = ((snapped % 360) + 360) % 360;
    match normalized {
        90 | 180 | 270 => normalized,
        _ => 0,
    }
}

fn resolve_page_rotation(document: &Document, page_id: ObjectId) -> Result<i64> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err("Page tree cycle while resolving Rotate".into());
        }

        let dict = document.get_dictionary(object_id)?;
        if let Ok(object) = dict.get(b"Rotate") {
            let (_, resolved) = document.dereference(object)?;
            return Ok(normalize_page_rotation(resolved.as_i64()?));
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Ok(0)
}

fn intersect_rect(left: PdfRect, right: PdfRect) -> Option<PdfRect> {
    let rect = PdfRect {
        x1: left.x1.max(right.x1),
        y1: left.y1.max(right.y1),
        x2: left.x2.min(right.x2),
        y2: left.y2.min(right.y2),
    };
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return None;
    }
    Some(rect)
}

fn resolve_page_view(document: &Document, page_id: ObjectId) -> Result<PdfRect> {
    let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
    match resolve_inherited_box(document, page_id, b"CropBox") {
        Ok(crop_box) => Ok(intersect_rect(crop_box, media_box).unwrap_or(media_box)),
        Err(_) => Ok(media_box),
    }
}

fn pdf_point_from_marker_point(
    marker_x: f64,
    marker_y: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    let mut norm_x = marker_x;
    let mut norm_y = 1.0 - marker_y;

    match page_rotation {
        90 => {
            norm_x = marker_y;
            norm_y = marker_x;
        }
        180 => {
            norm_x = 1.0 - marker_x;
            norm_y = marker_y;
        }
        270 => {
            norm_x = 1.0 - marker_y;
            norm_y = 1.0 - marker_x;
        }
        _ => {}
    }

    (
        page_view.x1 + norm_x * page_view.width(),
        page_view.y1 + norm_y * page_view.height(),
    )
}

fn marker_rect_to_pdf_rect(
    marker_rect: MarkerRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    validate_marker_rect(marker_rect)?;
    let marker_right = marker_rect.left + marker_rect.width;
    let marker_bottom = marker_rect.top + marker_rect.height;
    let points = [
        pdf_point_from_marker_point(marker_rect.left, marker_rect.top, page_view, page_rotation),
        pdf_point_from_marker_point(marker_right, marker_rect.top, page_view, page_rotation),
        pdf_point_from_marker_point(marker_rect.left, marker_bottom, page_view, page_rotation),
        pdf_point_from_marker_point(marker_right, marker_bottom, page_view, page_rotation),
    ];
    let min_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min);
    let min_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    parse_rect(&Object::Array(vec![
        number_object(min_x),
        number_object(min_y),
        number_object(max_x),
        number_object(max_y),
    ]))
}

fn crop_pages(document: &mut Document, pages: &[u32], margins: CropMargins) -> Result<()> {
    let page_map = document.get_pages();
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        let crop_width = media_box.width() - margins.left - margins.right;
        let crop_height = media_box.height() - margins.top - margins.bottom;
        if crop_width <= 0.0 || crop_height <= 0.0 {
            continue;
        }

        let crop_box = PdfRect {
            x1: media_box.x1 + margins.left,
            y1: media_box.y1 + margins.bottom,
            x2: media_box.x1 + margins.left + crop_width,
            y2: media_box.y1 + margins.bottom + crop_height,
        };
        set_page_crop_box(document, page_id, crop_box)?;
    }
    Ok(())
}

fn remove_crop_from_pages(document: &mut Document, pages: &[u32]) -> Result<()> {
    let page_map = document.get_pages();
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        set_page_crop_box(document, page_id, media_box)?;
    }
    Ok(())
}

fn resolve_page_id(
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    page_number: u32,
) -> Result<ObjectId> {
    page_map.get(&page_number).copied().ok_or_else(|| {
        format!(
            "Page {page_number} is outside the document page range 1-{}",
            page_map.len()
        )
        .into()
    })
}

fn resolve_inherited_box(document: &Document, page_id: ObjectId, key: &[u8]) -> Result<PdfRect> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err(format!(
                "Page tree cycle while resolving {}",
                String::from_utf8_lossy(key)
            )
            .into());
        }

        let dict = document.get_dictionary(object_id)?;
        if let Ok(object) = dict.get(key) {
            let (_, resolved) = document.dereference(object)?;
            return parse_rect(resolved);
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into())
}

fn parse_rect(object: &Object) -> Result<PdfRect> {
    let values = object.as_array()?;
    if values.len() != 4 {
        return Err("PDF rectangle must contain 4 values".into());
    }

    let rect = PdfRect {
        x1: object_to_f64(&values[0])?,
        y1: object_to_f64(&values[1])?,
        x2: object_to_f64(&values[2])?,
        y2: object_to_f64(&values[3])?,
    };
    if !rect.width().is_finite()
        || !rect.height().is_finite()
        || rect.width() <= 0.0
        || rect.height() <= 0.0
    {
        return Err("Invalid PDF rectangle dimensions".into());
    }
    Ok(rect)
}

fn object_to_f64(object: &Object) -> Result<f64> {
    let value = object.as_float()? as f64;
    if !value.is_finite() {
        return Err("PDF rectangle contains a non-finite value".into());
    }
    Ok(value)
}

fn set_page_crop_box(document: &mut Document, page_id: ObjectId, rect: PdfRect) -> Result<()> {
    let page = document.get_dictionary_mut(page_id)?;
    page.set(
        "CropBox",
        Object::Array(vec![
            number_object(rect.x1),
            number_object(rect.y1),
            number_object(rect.x2),
            number_object(rect.y2),
        ]),
    );
    Ok(())
}

fn number_object(value: f64) -> Object {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001
        && rounded >= i64::MIN as f64
        && rounded <= i64::MAX as f64
    {
        Object::Integer(rounded as i64)
    } else {
        Object::Real(value as f32)
    }
}
