use super::*;

const FULL_POSTCONDITION_AUDIT_ENV: &str = "EVB_PDF_PAGE_OPS_FULL_POSTCONDITION_AUDIT";

/// Production saves validate the pages named by the mutation projection. A
/// full page-tree audit is still available for explicit diagnostics and test
/// runs, but it must never be an accidental cost of a sparse save.
fn full_postcondition_audit_requested() -> bool {
    matches!(
        std::env::var_os(FULL_POSTCONDITION_AUDIT_ENV).as_deref(),
        Some(value) if value == "1"
    )
}

pub(crate) fn validate_appended_revision_postconditions(
    document: &impl PdfObjectSource,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    validate_note_text_document_postconditions(document, &mutations.updates, modified_at)?;
    validate_free_text_note_document_postconditions(
        document,
        &mutations.free_text_notes,
        modified_at,
    )?;
    validate_free_text_editor_document_postconditions(
        document,
        &mutations.free_text_editors,
        modified_at,
    )?;
    validate_annotation_delete_document_postconditions(document, &mutations.deletes)?;
    if let Some(page_labels) = &mutations.page_labels {
        if mutations.continuation.as_ref().is_some_and(|continuation| {
            continuation.family == NativeMutationContinuationFamily::PageLabels
        }) {
            validate_page_labels_fragment_postconditions(document, page_labels)?;
        } else {
            validate_page_labels_document_postconditions(document, page_labels)?;
        }
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        if let Some(continuation) = mutations.continuation.as_ref().filter(|continuation| {
            continuation.family == NativeMutationContinuationFamily::Bookmarks
        }) {
            validate_bookmarks_fragment_postconditions(
                document,
                bookmarks,
                &continuation.bookmark_path,
            )?;
        } else {
            validate_bookmarks_document_postconditions(document, bookmarks)?;
        }
    }
    if let Some(shapes) = &mutations.shapes {
        validate_shapes_document_postconditions(document, shapes)?;
    }
    if let Some(markup) = &mutations.markup {
        validate_markup_document_postconditions(document, markup)?;
    }
    validate_placed_image_document_postconditions(document, &mutations.placed_images, modified_at)
}

pub(crate) fn validate_note_text_document_postconditions(
    document: &impl PdfObjectSource,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        let target_dict = document.dictionary(target_id)?;
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
            let popup_dict = document.dictionary(popup_id)?;
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
                let parent_dict = document.dictionary(parent_id)?;
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

pub(crate) fn validate_free_text_note_document_postconditions(
    document: &impl PdfObjectSource,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_resolver = PageTreeResolver::new(document)?;
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
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
                    .dictionary(*object_id)
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
        let annot_dict = document.dictionary(annot_ref)?;
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
        let popup_dict = document.dictionary(popup_ref)?;
        validate_popup_annotation_fields(popup_dict, note, expected_rect, modified_at, annot_ref)?;
    }
    Ok(())
}

pub(crate) fn validate_free_text_editor_document_postconditions(
    document: &impl PdfObjectSource,
    editors: &[FreeTextEditor],
    modified_at: &str,
) -> Result<()> {
    if editors.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(document)?;
    for editor in editors {
        let page_number = editor
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText editor page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let expected_rect = validate_free_text_editor_rect(editor, page_view)?;
        let expected_name = free_text_editor_name(editor);
        let page_annotation_refs = get_page_annots(document, page_id)?
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect::<Vec<_>>();
        let matching_refs: Vec<ObjectId> =
            if let Some(annotation_id) = editor.annotation_id.as_deref() {
                let object_id = parse_pdfjs_annotation_object_id(annotation_id)
                    .ok_or("Invalid imported FreeText annotation id")?;
                page_annotation_refs
                    .into_iter()
                    .filter(|candidate| *candidate == object_id)
                    .collect()
            } else {
                page_annotation_refs
                    .into_iter()
                    .filter(|object_id| {
                        document
                            .dictionary(*object_id)
                            .ok()
                            .filter(|dict| annotation_subtype(dict) == "freetext")
                            .and_then(|dict| dict.get(b"NM").ok())
                            .and_then(pdf_string_to_text)
                            .as_deref()
                            == Some(expected_name.as_str())
                    })
                    .collect()
            };
        if matching_refs.len() != 1 {
            return Err(format!(
                "Expected exactly one FreeText editor named {expected_name}, found {}",
                matching_refs.len()
            )
            .into());
        }
        let dict = document.dictionary(matching_refs[0])?;
        validate_annotation_text_fields(dict, &editor.text, modified_at, "FreeText editor")?;
        let actual_rect = parse_rect(dict.get(b"Rect")?)?;
        validate_rect_approximately(actual_rect, expected_rect, "FreeText editor Rect")?;
        if dict.get(b"Popup").is_ok() {
            return Err("FreeText editor unexpectedly contains a Popup".into());
        }
        let rotation = dict.get(b"Rotate")?.as_i64()?;
        if rotation != i64::from(editor.rotation) {
            return Err("FreeText editor rotation did not match the requested rotation".into());
        }
        let default_appearance = dict
            .get(b"DA")
            .ok()
            .and_then(|object| object.as_str().ok())
            .ok_or("FreeText editor is missing DA")?;
        if !String::from_utf8_lossy(default_appearance).contains("/Helv") {
            return Err("FreeText editor DA is missing Helvetica".into());
        }
        validate_appearance(document, dict)?;
    }
    Ok(())
}

pub(crate) fn validate_annotation_delete_document_postconditions(
    document: &impl PdfObjectSource,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let page_resolver = PageTreeResolver::new(document)?;
    let mut refs_to_delete = HashSet::new();
    let mut touched_page_ids = HashSet::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        touched_page_ids.insert(page_id);
        if let (Some(object_number), Some(generation_number)) =
            (delete.object_number, delete.generation_number)
        {
            let target_id = (object_number, generation_number);
            refs_to_delete.insert(target_id);
            if document.dictionary(target_id).is_ok() {
                for object_id in collect_annotation_refs_to_delete(document, target_id)? {
                    refs_to_delete.insert(object_id);
                }
            }
        }
    }
    for object_id in &refs_to_delete {
        if let Some(page_id) = annotation_page_id(document, *object_id) {
            touched_page_ids.insert(page_id);
        }
    }

    let mut validate_page = |page_id| {
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
        Ok(())
    };

    if full_postcondition_audit_requested() {
        page_resolver.for_each_page_id(document, &mut validate_page)?;
    } else {
        for page_id in touched_page_ids {
            validate_page(page_id)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_placed_image_document_postconditions(
    document: &impl PdfObjectSource,
    images: &[PlacedImage],
    modified_at: &str,
) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }

    let page_resolver = PageTreeResolver::new(document)?;
    for (index, image) in images.iter().enumerate() {
        let page_number = image
            .page_index
            .checked_add(1)
            .ok_or("Invalid placed image page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let expected_geometry = placed_image_geometry(image, page_view, page_rotation)?;
        let expected_name = placed_image_annotation_name(image, index, modified_at);
        let found = get_page_annots(document, page_id)?
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .any(|object_id| {
                validate_placed_image_annotation(
                    document,
                    object_id,
                    &expected_name,
                    expected_geometry.rect,
                    modified_at,
                )
                .is_ok()
            });
        if !found {
            return Err("Placed image stamp annotation was not found".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_placed_image_annotation(
    document: &impl PdfObjectSource,
    object_id: ObjectId,
    expected_name: &str,
    expected_rect: PdfRect,
    modified_at: &str,
) -> Result<()> {
    let dict = document.dictionary(object_id)?;
    if annotation_subtype(dict) != "stamp" {
        return Err("Placed image annotation has the wrong subtype".into());
    }
    let actual_name = dict
        .get(b"NM")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or("Placed image annotation is missing NM")?;
    if actual_name != expected_name {
        return Err("Placed image annotation NM did not match requested name".into());
    }
    let modified = dict
        .get(b"M")
        .ok()
        .and_then(pdf_string_to_text)
        .ok_or("Placed image annotation is missing modification timestamp")?;
    if modified != modified_at {
        return Err("Placed image annotation modification timestamp did not match".into());
    }
    let actual_rect = parse_rect(dict.get(b"Rect")?)?;
    validate_rect_approximately(actual_rect, expected_rect, "Placed image annotation Rect")?;
    validate_placed_image_appearance(document, dict)?;
    Ok(())
}

pub(crate) fn validate_placed_image_appearance(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> Result<()> {
    let ap_dict = match dict.get(b"AP")? {
        Object::Dictionary(dictionary) => dictionary,
        Object::Reference(reference) => document.dictionary(*reference)?,
        _ => return Err("Placed image annotation AP must be a dictionary".into()),
    };
    let normal_ref = ap_dict.get(b"N")?.as_reference()?;
    let appearance = document.object(normal_ref)?;
    if !matches!(appearance, Object::Stream(_)) {
        return Err("Placed image appearance must be a stream".into());
    }
    Ok(())
}

pub(crate) fn validate_annotation_text_fields(
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

pub(crate) fn validate_free_text_annotation_fields(
    document: &impl PdfObjectSource,
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

pub(crate) fn validate_popup_annotation_fields(
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

pub(crate) fn validate_optional_author(
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

pub(crate) fn validate_appearance(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> Result<()> {
    let ap_dict = match dict.get(b"AP")? {
        Object::Dictionary(dictionary) => dictionary,
        Object::Reference(reference) => document.dictionary(*reference)?,
        _ => return Err("FreeText annotation AP must be a dictionary".into()),
    };
    let normal_ref = ap_dict.get(b"N")?.as_reference()?;
    document.object(normal_ref)?;
    Ok(())
}

pub(crate) fn validate_rect_approximately(
    actual: PdfRect,
    expected: PdfRect,
    label: &str,
) -> Result<()> {
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

pub(crate) fn resolve_dictionary_object<'a>(
    document: &'a impl PdfObjectSource,
    object: &'a Object,
    label: &str,
) -> Result<&'a Dictionary> {
    match object {
        Object::Dictionary(dictionary) => Ok(dictionary),
        Object::Reference(object_id) => Ok(document.dictionary(*object_id)?),
        _ => Err(format!("{label} must be a dictionary").into()),
    }
}

pub(crate) fn validate_page_labels_document_postconditions(
    document: &impl PdfObjectSource,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    let catalog = document.dictionary(document.root_id()?)?;
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        if catalog.get(b"PageLabels").is_ok() {
            return Err("PageLabels should be removed for implicit default labels".into());
        }
        return Ok(());
    }

    let page_labels_object = catalog.get(b"PageLabels")?;
    let page_labels_dict = resolve_dictionary_object(document, page_labels_object, "PageLabels")?;
    let nums = page_labels_dict.get(b"Nums")?.as_array()?;
    let expected_ranges = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    if nums.len() != expected_ranges.len() * 2 {
        return Err("PageLabels Nums length did not match requested ranges".into());
    }
    for (objects, expected) in nums.chunks_exact(2).zip(expected_ranges) {
        validate_page_label_entry(objects, &expected)?;
    }
    Ok(())
}

fn validate_page_label_entry(objects: &[Object], expected: &PageLabelRange) -> Result<()> {
    if objects[0].as_i64()? != i64::from(expected.start_page.saturating_sub(1)) {
        return Err("PageLabels range start did not match the requested page".into());
    }
    let range = objects[1].as_dict()?;
    match expected.style.as_deref() {
        Some(style) if range.get(b"S")?.as_name()? == style.as_bytes() => {}
        Some(_) => return Err("PageLabels range style did not match the request".into()),
        None if range.get(b"S").is_err() => {}
        None => return Err("PageLabels range unexpectedly retained a style".into()),
    }
    if expected.prefix.is_empty() {
        if range.get(b"P").is_ok() {
            return Err("PageLabels range unexpectedly retained a prefix".into());
        }
    } else if range.get(b"P")?.as_str()? != encode_pdf_text_string(&expected.prefix) {
        return Err("PageLabels range prefix did not match the request".into());
    }
    if expected.style.is_some() && expected.start_number > 1 {
        if range.get(b"St")?.as_i64()? != i64::from(expected.start_number) {
            return Err("PageLabels range start number did not match the request".into());
        }
    } else if range.get(b"St").is_ok() {
        return Err("PageLabels range unexpectedly retained a start number".into());
    }
    Ok(())
}

fn validate_page_labels_fragment_postconditions(
    document: &impl PdfObjectSource,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    let catalog = document.dictionary(document.root_id()?)?;
    let page_labels_object = catalog.get(b"PageLabels")?;
    let page_labels_dict = resolve_dictionary_object(document, page_labels_object, "PageLabels")?;
    let nums = page_labels_dict.get(b"Nums")?.as_array()?;
    if nums.len() % 2 != 0 {
        return Err("PageLabels Nums must contain key/value pairs".into());
    }
    let expected_ranges = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    for expected in expected_ranges {
        let expected_start = i64::from(expected.start_page.saturating_sub(1));
        let Some(objects) = nums
            .chunks_exact(2)
            .find(|objects| objects[0].as_i64().ok() == Some(expected_start))
        else {
            return Err("PageLabels continuation range was not retained".into());
        };
        validate_page_label_entry(objects, &expected)?;
    }
    Ok(())
}

pub(crate) fn validate_bookmarks_document_postconditions(
    document: &impl PdfObjectSource,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    let catalog = document.dictionary(document.root_id()?)?;
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

    let outlines_id = catalog.get(b"Outlines")?.as_reference()?;
    let outlines = document.dictionary(outlines_id)?;
    if outlines.get(b"Count")?.as_i64()? != i64::try_from(count_bookmark_items(&normalized))? {
        return Err("Outlines Count did not match requested bookmarks".into());
    }
    let first = outlines.get(b"First")?.as_reference()?;
    let last = outlines.get(b"Last")?.as_reference()?;
    let page_resolver = PageTreeResolver::new(document)?;
    validate_bookmark_level(
        document,
        &page_resolver,
        &normalized,
        outlines_id,
        first,
        last,
        None,
    )
}

fn outline_level_item_at_postcondition(
    document: &impl PdfObjectSource,
    parent_id: ObjectId,
    index: u32,
) -> Result<ObjectId> {
    let parent = document.dictionary(parent_id)?;
    let mut current = parent.get(b"First")?.as_reference()?;
    for _ in 0..index {
        current = document.dictionary(current)?.get(b"Next")?.as_reference()?;
    }
    Ok(current)
}

fn resolve_bookmark_parent_postcondition(
    document: &impl PdfObjectSource,
    outlines_id: ObjectId,
    path: &[u32],
) -> Result<ObjectId> {
    path.iter().try_fold(outlines_id, |parent_id, index| {
        outline_level_item_at_postcondition(document, parent_id, *index)
    })
}

fn validate_bookmarks_fragment_postconditions(
    document: &impl PdfObjectSource,
    bookmarks: &BookmarksMutation,
    bookmark_path: &[u32],
) -> Result<()> {
    let catalog = document.dictionary(document.root_id()?)?;
    let outlines_id = catalog.get(b"Outlines")?.as_reference()?;
    let parent_id = resolve_bookmark_parent_postcondition(document, outlines_id, bookmark_path)?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    if normalized.is_empty() {
        return Ok(());
    }
    let parent = document.dictionary(parent_id)?;
    let last = parent.get(b"Last")?.as_reference()?;
    let mut first = last;
    // The fragment is one outline level. Descendants are validated recursively
    // by `validate_bookmark_level`, but they are not part of this level's
    // Prev/Next chain.
    for _ in 1..normalized.len() {
        first = document.dictionary(first)?.get(b"Prev")?.as_reference()?;
    }
    let previous = document
        .dictionary(first)?
        .get(b"Prev")
        .ok()
        .and_then(|value| value.as_reference().ok());
    validate_bookmark_level(
        document,
        &PageTreeResolver::new(document)?,
        &normalized,
        parent_id,
        first,
        last,
        previous,
    )
}

fn validate_bookmark_level(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    items: &[BookmarkEntry],
    parent_id: ObjectId,
    first: ObjectId,
    last: ObjectId,
    initial_previous: Option<ObjectId>,
) -> Result<()> {
    let mut current = Some(first);
    let mut previous = initial_previous;
    for item in items {
        let object_id = current.ok_or("Outline chain ended before all bookmarks were validated")?;
        let bookmark = document.dictionary(object_id)?;
        if bookmark.get(b"Parent")?.as_reference()? != parent_id {
            return Err("Bookmark parent did not match its outline level".into());
        }
        match previous {
            Some(previous_id) if bookmark.get(b"Prev")?.as_reference()? == previous_id => {}
            Some(_) => return Err("Bookmark Prev link did not match its sibling".into()),
            None if bookmark.get(b"Prev").is_err() => {}
            None => return Err("First bookmark unexpectedly contained a Prev link".into()),
        }
        if bookmark.get(b"Title")?.as_str()? != encode_pdf_text_string(&item.title) {
            return Err("Bookmark title did not match the request".into());
        }
        validate_bookmark_destination(document, page_resolver, bookmark, item)?;

        if item.items.is_empty() {
            if bookmark.get(b"First").is_ok()
                || bookmark.get(b"Last").is_ok()
                || bookmark.get(b"Count").is_ok()
            {
                return Err("Leaf bookmark unexpectedly contained child links".into());
            }
        } else {
            let child_first = bookmark.get(b"First")?.as_reference()?;
            let child_last = bookmark.get(b"Last")?.as_reference()?;
            if bookmark.get(b"Count")?.as_i64()?
                != i64::try_from(count_bookmark_items(&item.items))?
            {
                return Err("Bookmark child count did not match the request".into());
            }
            validate_bookmark_level(
                document,
                page_resolver,
                &item.items,
                object_id,
                child_first,
                child_last,
                None,
            )?;
        }

        previous = Some(object_id);
        current = bookmark.get(b"Next").and_then(Object::as_reference).ok();
    }
    if current.is_some() {
        return Err("Outline chain contained more bookmarks than requested".into());
    }
    if previous != Some(last) {
        return Err("Outline Last link did not match the final requested bookmark".into());
    }
    Ok(())
}

fn validate_bookmark_destination(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    bookmark: &Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(page_index) = item.page_index {
        let page_id = page_resolver.page_id(
            document,
            page_index
                .checked_add(1)
                .ok_or("Invalid bookmark page index")?,
        )?;
        let page_view = resolve_page_view(document, page_id)?;
        let expected_top = resolve_bookmark_destination_top(&page_view, item.page_y_ratio);
        let destination = bookmark.get(b"Dest")?.as_array()?;
        if destination.len() != 5
            || destination[0].as_reference()? != page_id
            || destination[1].as_name()? != b"XYZ"
            || !destination[2].is_null()
            || (f64::from(destination[3].as_float()?) - expected_top).abs() > 0.01
            || !destination[4].is_null()
        {
            return Err("Bookmark destination did not match the requested page position".into());
        }
        return Ok(());
    }

    if let Some(named_dest) = item.named_dest.as_deref() {
        if bookmark.get(b"Dest")?.as_str()? != named_dest.as_bytes() {
            return Err("Bookmark named destination did not match the request".into());
        }
    } else if bookmark.get(b"Dest").is_ok() {
        return Err("Bookmark unexpectedly retained a destination".into());
    }
    Ok(())
}

pub(crate) fn validate_shapes_document_postconditions(
    document: &impl PdfObjectSource,
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
    let page_resolver = PageTreeResolver::new(document)?;
    let mut touched_page_ids = HashSet::new();
    for shape in &shapes.shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        touched_page_ids.insert(page_resolver.page_id(document, page_number)?);
    }
    for annotation_id in &deleted_refs.annotation_ids {
        let Some(annotation_id) = parse_pdfjs_annotation_object_id(annotation_id) else {
            continue;
        };
        let Some(page_id) = annotation_page_id(document, annotation_id) else {
            continue;
        };
        touched_page_ids.insert(page_id);
    }

    let mut validate_page = |page_id| {
        for object in get_page_annots(document, page_id)? {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            let annotation_id = format_pdfjs_annotation_ref(object_id);
            if deleted_refs.annotation_ids.contains(&annotation_id) {
                return Err("Deleted shape annotation is still referenced from page Annots".into());
            }
            let Ok(dict) = document.dictionary(object_id) else {
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
        Ok(())
    };
    if full_postcondition_audit_requested() {
        page_resolver.for_each_page_id(document, &mut validate_page)?;
    } else {
        for page_id in touched_page_ids {
            validate_page(page_id)?;
        }
    }
    for stable_key in expected_stable_keys {
        if !found_stable_keys.contains(&stable_key) {
            return Err(format!("Saved shape stable key {stable_key} was not found").into());
        }
    }
    Ok(())
}

pub(crate) fn parse_pdfjs_annotation_object_id(value: &str) -> Option<ObjectId> {
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

pub(crate) fn validate_markup_target(
    document: &impl PdfObjectSource,
    object_id: ObjectId,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<()> {
    let dict = document.dictionary(object_id)?;
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

pub(crate) fn validate_markup_document_postconditions(
    document: &impl PdfObjectSource,
    markup: &MarkupMutation,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    for (annotation_id, subtype) in &markup.overrides {
        let Some(object_id) = parse_pdfjs_annotation_object_id(annotation_id) else {
            continue;
        };
        validate_markup_target(document, object_id, subtype, None)?;
    }
    for hint in &markup.hints {
        match hint
            .annotation_id
            .as_deref()
            .and_then(parse_pdfjs_annotation_object_id)
        {
            Some(object_id) => {
                validate_markup_target(document, object_id, &hint.subtype, hint.color.as_deref())?;
            }
            None => {
                if is_new_markup_hint_data(hint) {
                    validate_new_markup_target(document, &page_resolver, hint)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_new_markup_target(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    hint: &MarkupSubtypeHint,
) -> Result<()> {
    let page_number = hint
        .page_index
        .checked_add(1)
        .ok_or("Invalid text-markup hint page index")?;
    let page_id = page_resolver.page_id(document, page_number)?;
    let expected_name = markup_annotation_name(hint)
        .ok_or("New text-markup annotation is missing a stable identity")?;
    let matching_refs: Vec<ObjectId> = get_page_annots(document, page_id)?
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            document
                .dictionary(*object_id)
                .ok()
                .filter(|dict| canonical_markup_subtype(dict).as_deref() == Some(&hint.subtype))
                .and_then(|dict| dict.get(b"NM").ok())
                .and_then(pdf_string_to_text)
                .as_deref()
                == Some(expected_name.as_str())
        })
        .collect();
    if matching_refs.len() != 1 {
        return Err(format!(
            "Expected exactly one text-markup annotation named {expected_name}, found {}",
            matching_refs.len()
        )
        .into());
    }

    let object_id = matching_refs[0];
    validate_markup_target(document, object_id, &hint.subtype, hint.color.as_deref())?;
    let page_view = resolve_page_view(document, page_id)?;
    let page_rotation = resolve_page_rotation(document, page_id)?;
    let (expected_quads, expected_rect) = markup_hint_pdf_quads(hint, page_view, page_rotation)?;
    let dict = document.dictionary(object_id)?;
    let actual_quads = read_markup_quad_points(document, dict)
        .ok_or("New text-markup annotation is missing QuadPoints")?;
    if actual_quads.len() != expected_quads.len()
        || actual_quads
            .iter()
            .zip(expected_quads.iter())
            .any(|(actual, expected)| (actual - expected).abs() > 0.01)
    {
        return Err(
            "New text-markup annotation QuadPoints did not match requested geometry".into(),
        );
    }
    let actual_rect = read_pdf_rect_from_dict(document, dict)
        .ok_or("New text-markup annotation is missing Rect")?;
    validate_rect_approximately(actual_rect, expected_rect, "Text-markup annotation Rect")?;
    Ok(())
}
