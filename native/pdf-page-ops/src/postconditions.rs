fn validate_note_text_document_postconditions(
    document: &Document,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        let target_dict = document.get_dictionary(target_id)?;
        validate_annotation_text_fields(
            target_dict,
            &update.text,
            modified_at,
            "target annotation",
        )?;

        if let Ok(Object::Dictionary(popup_dict)) = target_dict.get(b"Popup") {
            validate_annotation_text_fields(
                popup_dict,
                &update.text,
                modified_at,
                "embedded popup",
            )?;
        }
        if let Some(popup_id) = annotation_related_ref(target_dict, b"Popup") {
            let popup_dict = document.get_dictionary(popup_id)?;
            validate_annotation_text_fields(
                popup_dict,
                &update.text,
                modified_at,
                "popup annotation",
            )?;
        }

        if annotation_subtype(target_dict) == "popup" {
            if let Ok(Object::Dictionary(parent_dict)) = target_dict.get(b"Parent") {
                validate_annotation_text_fields(
                    parent_dict,
                    &update.text,
                    modified_at,
                    "embedded popup parent",
                )?;
            }
            if let Some(parent_id) = annotation_related_ref(target_dict, b"Parent") {
                let parent_dict = document.get_dictionary(parent_id)?;
                validate_annotation_text_fields(
                    parent_dict,
                    &update.text,
                    modified_at,
                    "popup parent annotation",
                )?;
            }
        }
    }
    Ok(())
}

fn validate_free_text_note_document_postconditions(
    document: &Document,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let expected_rect = marker_rect_to_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let annots = get_page_annots(document, page_id)?;
        let matching_refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .filter(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .filter(|dict| annotation_subtype(dict) == "freetext")
                    .and_then(|dict| dict.get(b"NM").ok())
                    .and_then(pdf_string_to_text)
                    .as_deref()
                    == Some(note_name.as_str())
            })
            .collect();

        if matching_refs.len() != 1 {
            return Err(format!(
                "Expected exactly one FreeText annotation named {note_name}, found {}",
                matching_refs.len()
            )
            .into());
        }

        let annot_ref = matching_refs[0];
        let annot_dict = document.get_dictionary(annot_ref)?;
        validate_free_text_annotation_fields(
            document,
            annot_dict,
            note,
            &note_name,
            expected_rect,
            modified_at,
        )?;
        let popup_ref = annotation_related_ref(annot_dict, b"Popup")
            .ok_or("FreeText annotation is missing Popup")?;
        if !annots
            .iter()
            .any(|object| object.as_reference().ok() == Some(popup_ref))
        {
            return Err("FreeText popup is missing from page Annots".into());
        }
        let popup_dict = document.get_dictionary(popup_ref)?;
        validate_popup_annotation_fields(popup_dict, note, expected_rect, modified_at, annot_ref)?;
    }
    Ok(())
}

fn validate_annotation_delete_document_postconditions(
    document: &Document,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    let mut refs_to_delete = HashSet::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if delete.object_number.is_some() || delete.generation_number.is_some() {
            for target_id in resolve_annotation_delete_target_refs(document, page_id, delete)? {
                for object_id in collect_annotation_refs_to_delete(document, target_id)? {
                    refs_to_delete.insert(object_id);
                }
            }
        }
    }

    for page_id in page_map.values().copied() {
        for object in get_page_annots(document, page_id)? {
            if let Ok(object_id) = object.as_reference() {
                if refs_to_delete.contains(&object_id) {
                    return Err("Deleted annotation is still referenced from page Annots".into());
                }
                for delete in deletes {
                    if annotation_matches_stable_delete_name(document, object_id, delete)? {
                        return Err(
                            "Stable-key deleted annotation is still referenced from page Annots"
                                .into(),
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_annotation_text_fields(
    dict: &Dictionary,
    expected_text: &str,
    modified_at: &str,
    label: &str,
) -> Result<()> {
    let contents = dict
        .get(b"Contents")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or_else(|| format!("{label} is missing Contents"))?;
    if contents != expected_text {
        return Err(format!("{label} Contents did not match requested text").into());
    }

    let modified = dict
        .get(b"M")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or_else(|| format!("{label} is missing modification timestamp"))?;
    if modified != modified_at {
        return Err(
            format!("{label} modification timestamp did not match requested timestamp").into(),
        );
    }
    Ok(())
}

fn validate_free_text_annotation_fields(
    document: &Document,
    dict: &Dictionary,
    note: &FreeTextNote,
    note_name: &str,
    expected_rect: PdfRect,
    modified_at: &str,
) -> Result<()> {
    if annotation_subtype(dict) != "freetext" {
        return Err("FreeText annotation has the wrong subtype".into());
    }
    validate_annotation_text_fields(dict, &note.text, modified_at, "FreeText annotation")?;
    validate_optional_author(dict, note.author.as_deref(), "FreeText annotation")?;
    let actual_name = dict
        .get(b"NM")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or("FreeText annotation is missing NM")?;
    if actual_name != note_name {
        return Err("FreeText annotation NM did not match requested note name".into());
    }
    let actual_rect = parse_rect(dict.get(b"Rect")?)?;
    validate_rect_approximately(actual_rect, expected_rect, "FreeText annotation Rect")?;
    validate_appearance(document, dict)?;
    Ok(())
}

fn validate_popup_annotation_fields(
    dict: &Dictionary,
    note: &FreeTextNote,
    expected_rect: PdfRect,
    modified_at: &str,
    expected_parent: ObjectId,
) -> Result<()> {
    if annotation_subtype(dict) != "popup" {
        return Err("FreeText popup has the wrong subtype".into());
    }
    validate_annotation_text_fields(dict, &note.text, modified_at, "FreeText popup")?;
    validate_optional_author(dict, note.author.as_deref(), "FreeText popup")?;
    if annotation_related_ref(dict, b"Parent") != Some(expected_parent) {
        return Err("FreeText popup Parent did not reference the FreeText annotation".into());
    }
    let actual_rect = parse_rect(dict.get(b"Rect")?)?;
    validate_rect_approximately(actual_rect, expected_rect, "FreeText popup Rect")?;
    Ok(())
}

fn validate_optional_author(
    dict: &Dictionary,
    expected_author: Option<&str>,
    label: &str,
) -> Result<()> {
    let expected_author = expected_author.unwrap_or("");
    let actual_author = dict
        .get(b"T")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or_else(|| format!("{label} is missing author"))?;
    if actual_author != expected_author {
        return Err(format!("{label} author did not match requested author").into());
    }
    Ok(())
}

fn validate_appearance(document: &Document, dict: &Dictionary) -> Result<()> {
    let ap_dict = match dict.get(b"AP")? {
        Object::Dictionary(dictionary) => dictionary,
        Object::Reference(reference) => document.get_dictionary(*reference)?,
        _ => return Err("FreeText annotation AP must be a dictionary".into()),
    };
    let normal_ref = ap_dict.get(b"N")?.as_reference()?;
    document.get_object(normal_ref)?;
    Ok(())
}

fn validate_rect_approximately(actual: PdfRect, expected: PdfRect, label: &str) -> Result<()> {
    const EPSILON: f64 = 0.01;
    if (actual.x1 - expected.x1).abs() > EPSILON
        || (actual.y1 - expected.y1).abs() > EPSILON
        || (actual.x2 - expected.x2).abs() > EPSILON
        || (actual.y2 - expected.y2).abs() > EPSILON
    {
        return Err(format!("{label} did not match requested marker geometry").into());
    }
    Ok(())
}

fn resolve_dictionary_object<'a>(
    document: &'a Document,
    object: &'a Object,
    label: &str,
) -> Result<&'a Dictionary> {
    match object {
        Object::Dictionary(dictionary) => Ok(dictionary),
        Object::Reference(object_id) => Ok(document.get_dictionary(*object_id)?),
        _ => Err(format!("{label} must be a dictionary").into()),
    }
}

fn validate_page_labels_document_postconditions(
    document: &Document,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    let catalog = document.get_dictionary(catalog_id(document)?)?;
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        if catalog.get(b"PageLabels").is_ok() {
            return Err("PageLabels should be removed for implicit default labels".into());
        }
        return Ok(());
    }

    let page_labels_object = catalog.get(b"PageLabels")?;
    let page_labels_dict = resolve_dictionary_object(document, page_labels_object, "PageLabels")?;
    let nums = page_labels_dict.get(b"Nums")?.as_array()?;
    let expected_len =
        normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages).len() * 2;
    if nums.len() != expected_len {
        return Err("PageLabels Nums length did not match requested ranges".into());
    }
    Ok(())
}

fn validate_bookmarks_document_postconditions(
    document: &Document,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    let catalog = document.get_dictionary(catalog_id(document)?)?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    if normalized.is_empty() {
        if catalog.get(b"Outlines").is_ok() {
            return Err("Outlines should be removed for an empty bookmark mutation".into());
        }
        return Ok(());
    }

    let outlines_object = catalog.get(b"Outlines")?;
    let outlines_dict = resolve_dictionary_object(document, outlines_object, "Outlines")?;
    if outlines_dict.get(b"First").is_err() || outlines_dict.get(b"Last").is_err() {
        return Err("Outlines root is missing First/Last links".into());
    }
    let count = outlines_dict.get(b"Count")?.as_i64()?;
    if count != i64::try_from(count_bookmark_items(&normalized))? {
        return Err("Outlines Count did not match requested bookmarks".into());
    }
    Ok(())
}

fn validate_shapes_document_postconditions(
    document: &Document,
    shapes: &ShapesMutation,
) -> Result<()> {
    assert_mutation_page_count(document, shapes.total_pages, "Shape mutation")?;
    let deleted_refs = collect_deleted_shape_refs(shapes);
    let expected_stable_keys: HashSet<String> = shapes
        .shapes
        .iter()
        .filter_map(|shape| normalize_managed_shape_stable_key(shape.stable_key.as_deref()))
        .collect();
    let mut found_stable_keys = HashSet::new();
    let page_map = document.get_pages();
    for page_id in page_map.values().copied() {
        for object in get_page_annots(document, page_id)? {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            let annotation_id = format_pdfjs_annotation_ref(object_id);
            if deleted_refs.annotation_ids.contains(&annotation_id) {
                return Err("Deleted shape annotation is still referenced from page Annots".into());
            }
            let Ok(dict) = document.get_dictionary(object_id) else {
                continue;
            };
            if let Some(stable_key) = read_managed_shape_stable_key(dict) {
                if deleted_refs.stable_keys.contains(&stable_key) {
                    return Err(
                        "Deleted stable-key shape is still referenced from page Annots".into(),
                    );
                }
                if expected_stable_keys.contains(&stable_key) {
                    found_stable_keys.insert(stable_key);
                }
            }
        }
    }
    for stable_key in expected_stable_keys {
        if !found_stable_keys.contains(&stable_key) {
            return Err(format!("Saved shape stable key {stable_key} was not found").into());
        }
    }
    Ok(())
}

fn parse_pdfjs_annotation_object_id(value: &str) -> Option<ObjectId> {
    let normalized = normalize_pdfjs_annotation_id(value)?;
    let (object_number, generation_number) = normalized.split_once('R')?;
    let object_number = object_number.parse::<u32>().ok()?;
    let generation_number = if generation_number.is_empty() {
        0
    } else {
        generation_number.parse::<u16>().ok()?
    };
    Some((object_number, generation_number))
}

fn validate_markup_target(
    document: &Document,
    object_id: ObjectId,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<()> {
    let dict = document.get_dictionary(object_id)?;
    if target_subtype != "Highlight" {
        let actual_subtype = canonical_markup_subtype(dict)
            .ok_or("Text-markup target is no longer a markup annotation")?;
        if actual_subtype != target_subtype {
            return Err("Text-markup target subtype did not match requested rewrite".into());
        }
        if read_markup_quad_points(document, dict).is_none() {
            return Err("Text-markup target is missing QuadPoints after rewrite".into());
        }
        if target_subtype == "Squiggly" && dict.get(b"AP").is_err() {
            return Err("Squiggly text-markup target is missing an appearance stream".into());
        }
    }
    if let Some(expected_color) = resolve_hint_target_color(target_subtype, color) {
        let actual_color = read_markup_color(document, dict)
            .ok_or("Text-markup target is missing color after rewrite")?;
        if actual_color != expected_color {
            return Err("Text-markup target color did not match requested rewrite".into());
        }
        if target_subtype == "Highlight" {
            let ca = dict
                .get(b"CA")
                .ok()
                .and_then(|object| object_to_f64(object).ok());
            if ca != Some(1.0) {
                return Err("Highlight text-markup target opacity was not normalized".into());
            }
        }
    }
    Ok(())
}

fn validate_markup_document_postconditions(
    document: &Document,
    markup: &MarkupMutation,
) -> Result<()> {
    for (annotation_id, subtype) in &markup.overrides {
        let Some(object_id) = parse_pdfjs_annotation_object_id(annotation_id) else {
            continue;
        };
        validate_markup_target(document, object_id, subtype, None)?;
    }
    for hint in &markup.hints {
        let Some(annotation_id) = hint.annotation_id.as_deref() else {
            continue;
        };
        let Some(object_id) = parse_pdfjs_annotation_object_id(annotation_id) else {
            continue;
        };
        validate_markup_target(document, object_id, &hint.subtype, hint.color.as_deref())?;
    }
    Ok(())
}
