use super::*;

pub(crate) fn update_note_text(
    document: &mut Document,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    let mut updated_count = 0;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        if update_annotation_text_by_ref(document, target_id, &update.text, modified_at)? {
            updated_count += 1;
        }
    }
    if updated_count != updates.len() {
        return Err(format!(
            "Updated {updated_count} of {} requested note annotation(s)",
            updates.len()
        )
        .into());
    }
    Ok(())
}

pub(crate) fn upsert_free_text_notes(
    document: &mut Document,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    let mut annotation_visits = 0usize;
    upsert_free_text_notes_with_counter(document, notes, modified_at, &mut annotation_visits)
}

pub(crate) fn upsert_free_text_notes_with_counter(
    document: &mut Document,
    notes: &[FreeTextNote],
    modified_at: &str,
    annotation_visits: &mut usize,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    let mut note_pages = Vec::with_capacity(notes.len());
    let mut annotation_indexes = HashMap::new();
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_page_annotation_index(document, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        note_pages.push(page_id);
    }
    let mut blank_ap_ref: Option<ObjectId> = None;
    for (note, page_id) in notes.iter().zip(note_pages) {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let pdf_rect = marker_rect_to_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let existing = annotation_indexes
            .get(&page_id)
            .and_then(|index| index.first_free_text_named(&note_name));

        if let Some(annot_id) = existing {
            let popup_ref = {
                let annot_dict = document.get_dictionary(annot_id)?;
                annotation_related_ref(annot_dict, b"Popup")
            };
            let ensured_popup_ref = ensure_free_text_annotation_fields(
                document,
                annot_id,
                popup_ref,
                note,
                &note_name,
                pdf_rect,
                modified_at,
                &mut blank_ap_ref,
            )?;
            if let Some(popup_id) = ensured_popup_ref {
                annotation_indexes
                    .get_mut(&page_id)
                    .expect("FreeText pages are indexed before mutation")
                    .append_missing_refs(&[popup_id]);
            }
            continue;
        }

        let annot_ref = document.new_object_id();
        let popup_ref = document.new_object_id();
        let ap_ref = get_or_create_blank_appearance_ref(document, &mut blank_ap_ref);
        let annot_dict = build_free_text_annotation_dict(
            note,
            &note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            Some(popup_ref),
        );
        let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_ref);
        document.set_object(annot_ref, Object::Dictionary(annot_dict));
        document.set_object(popup_ref, Object::Dictionary(popup_dict));
        annotation_indexes
            .get_mut(&page_id)
            .expect("FreeText pages are indexed before mutation")
            .append_free_text(&note_name, annot_ref, popup_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index(document, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn upsert_free_text_notes_incremental(
    incremental: &mut IncrementalDocument,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    let mut annotation_visits = 0usize;
    upsert_free_text_notes_incremental_with_counter(
        incremental,
        notes,
        modified_at,
        &mut annotation_visits,
    )
}

pub(crate) fn upsert_free_text_notes_incremental_with_counter(
    incremental: &mut IncrementalDocument,
    notes: &[FreeTextNote],
    modified_at: &str,
    annotation_visits: &mut usize,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_map = incremental.get_prev_documents().get_pages();
    let mut note_pages = Vec::with_capacity(notes.len());
    let mut annotation_indexes = HashMap::new();
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) =
                build_page_annotation_index(incremental.get_prev_documents(), page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        note_pages.push(page_id);
    }
    let mut blank_ap_ref: Option<ObjectId> = None;
    for (note, page_id) in notes.iter().zip(note_pages) {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let pdf_rect = marker_rect_to_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let existing = annotation_indexes
            .get(&page_id)
            .and_then(|index| index.first_free_text_named(&note_name));

        if let Some(annot_id) = existing {
            let popup_ref = {
                let revision = AppendedRevision::new(incremental);
                let annot_dict = revision.dictionary(annot_id)?;
                annotation_related_ref(annot_dict, b"Popup")
            };
            incremental.opt_clone_object_to_new_document(annot_id)?;
            let popup_ref = ensure_free_text_incremental_annotation_fields(
                incremental,
                annot_id,
                popup_ref,
                note,
                &note_name,
                pdf_rect,
                modified_at,
                &mut blank_ap_ref,
            )?;
            if let Some(popup_id) = popup_ref {
                annotation_indexes
                    .get_mut(&page_id)
                    .expect("FreeText pages are indexed before mutation")
                    .append_missing_refs(&[popup_id]);
            }
            continue;
        }

        let annot_ref = incremental.new_document.new_object_id();
        let popup_ref = incremental.new_document.new_object_id();
        let ap_ref =
            get_or_create_blank_appearance_ref(&mut incremental.new_document, &mut blank_ap_ref);
        let annot_dict = build_free_text_annotation_dict(
            note,
            &note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            Some(popup_ref),
        );
        let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_ref);
        incremental
            .new_document
            .set_object(annot_ref, Object::Dictionary(annot_dict));
        incremental
            .new_document
            .set_object(popup_ref, Object::Dictionary(popup_dict));
        annotation_indexes
            .get_mut(&page_id)
            .expect("FreeText pages are indexed before mutation")
            .append_free_text(&note_name, annot_ref, popup_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index_incremental(incremental, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn ensure_free_text_annotation_fields(
    document: &mut Document,
    annot_id: ObjectId,
    popup_ref: Option<ObjectId>,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    blank_ap_ref: &mut Option<ObjectId>,
) -> Result<Option<ObjectId>> {
    let popup_ref = match popup_ref {
        Some(popup_id) => Some(popup_id),
        None => Some(document.new_object_id()),
    };
    let ap_ref = get_or_create_blank_appearance_ref(document, blank_ap_ref);
    {
        let annot_dict = document.get_dictionary_mut(annot_id)?;
        set_free_text_annotation_fields(
            annot_dict,
            note,
            note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            popup_ref,
        );
    }
    if let Some(popup_id) = popup_ref {
        if document.get_object(popup_id).is_err() {
            let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
            document.set_object(popup_id, Object::Dictionary(popup_dict));
        } else if let Ok(popup_dict) = document.get_dictionary_mut(popup_id) {
            set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
        }
    }
    Ok(popup_ref)
}

pub(crate) fn ensure_free_text_incremental_annotation_fields(
    incremental: &mut IncrementalDocument,
    annot_id: ObjectId,
    popup_ref: Option<ObjectId>,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    blank_ap_ref: &mut Option<ObjectId>,
) -> Result<Option<ObjectId>> {
    let popup_ref = match popup_ref {
        Some(popup_id) => {
            if incremental
                .get_prev_documents()
                .get_object(popup_id)
                .is_ok()
            {
                incremental.opt_clone_object_to_new_document(popup_id)?;
            }
            Some(popup_id)
        }
        None => Some(incremental.new_document.new_object_id()),
    };
    let ap_ref = get_or_create_blank_appearance_ref(&mut incremental.new_document, blank_ap_ref);
    {
        let annot_dict = incremental.new_document.get_dictionary_mut(annot_id)?;
        set_free_text_annotation_fields(
            annot_dict,
            note,
            note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            popup_ref,
        );
    }
    if let Some(popup_id) = popup_ref {
        if incremental.new_document.get_object(popup_id).is_err() {
            let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
            incremental
                .new_document
                .set_object(popup_id, Object::Dictionary(popup_dict));
        } else if let Ok(popup_dict) = incremental.new_document.get_dictionary_mut(popup_id) {
            set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
        }
    }
    Ok(popup_ref)
}

pub(crate) fn build_free_text_annotation_dict(
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    ap_ref: ObjectId,
    popup_ref: Option<ObjectId>,
) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(b"FreeText".to_vec()));
    dict.set("F", Object::Integer(4));
    set_free_text_annotation_fields(
        &mut dict,
        note,
        note_name,
        pdf_rect,
        modified_at,
        ap_ref,
        popup_ref,
    );
    dict
}

pub(crate) fn set_free_text_annotation_fields(
    dict: &mut Dictionary,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    ap_ref: ObjectId,
    popup_ref: Option<ObjectId>,
) {
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&note.text),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.set(
        "T",
        Object::String(
            encode_pdf_text_string(note.author.as_deref().unwrap_or("")),
            StringFormat::Hexadecimal,
        ),
    );
    let mut ap_dict = Dictionary::new();
    ap_dict.set("N", Object::Reference(ap_ref));
    dict.set("AP", Object::Dictionary(ap_dict));
    dict.set(
        "NM",
        Object::String(encode_pdf_text_string(note_name), StringFormat::Hexadecimal),
    );
    if let Some(popup_id) = popup_ref {
        dict.set("Popup", Object::Reference(popup_id));
    }
    set_rgb_color(dict, "C", note.color.as_deref());
    set_rgb_color(dict, "IC", note.color.as_deref());
}

pub(crate) fn build_popup_annotation_dict(
    note: &FreeTextNote,
    pdf_rect: PdfRect,
    modified_at: &str,
    parent_ref: ObjectId,
) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(b"Popup".to_vec()));
    dict.set("F", Object::Integer(28));
    set_popup_annotation_fields(&mut dict, note, pdf_rect, modified_at, parent_ref);
    dict
}

pub(crate) fn set_popup_annotation_fields(
    dict: &mut Dictionary,
    note: &FreeTextNote,
    pdf_rect: PdfRect,
    modified_at: &str,
    parent_ref: ObjectId,
) {
    dict.set("Parent", Object::Reference(parent_ref));
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&note.text),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.set(
        "T",
        Object::String(
            encode_pdf_text_string(note.author.as_deref().unwrap_or("")),
            StringFormat::Hexadecimal,
        ),
    );
}

pub(crate) fn get_or_create_blank_appearance_ref(
    document: &mut Document,
    blank_ap_ref: &mut Option<ObjectId>,
) -> ObjectId {
    if let Some(object_id) = *blank_ap_ref {
        return object_id;
    }

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set(
        "BBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
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
    dict.set("Resources", Object::Dictionary(Dictionary::new()));
    let object_id = document.add_object(Stream::new(dict, Vec::new()));
    *blank_ap_ref = Some(object_id);
    object_id
}

pub(crate) fn replayable_free_text_note_name_from_parts(
    stable_key: &str,
    created_at: Option<u64>,
) -> String {
    match created_at {
        Some(created_at) if created_at > 0 => {
            format!("evb-note:{}:created:{created_at}", stable_key.trim())
        }
        _ => format!("evb-note:{}", stable_key.trim()),
    }
}

pub(crate) fn replayable_free_text_note_name(note: &FreeTextNote) -> String {
    replayable_free_text_note_name_from_parts(&note.stable_key, note.created_at)
}

pub(crate) struct PageAnnotationIndex {
    annots: Vec<Object>,
    annotation_refs: HashSet<ObjectId>,
    first_free_text_by_name: HashMap<String, ObjectId>,
    named_free_text: Vec<(ObjectId, String)>,
    dirty: bool,
}

impl PageAnnotationIndex {
    fn first_free_text_named(&self, note_name: &str) -> Option<ObjectId> {
        self.first_free_text_by_name.get(note_name).copied()
    }

    pub(crate) fn append_missing_refs(&mut self, refs: &[ObjectId]) {
        for object_id in refs {
            if self.annotation_refs.insert(*object_id) {
                self.annots.push(Object::Reference(*object_id));
                self.dirty = true;
            }
        }
    }

    fn append_free_text(&mut self, note_name: &str, annot_ref: ObjectId, popup_ref: ObjectId) {
        self.first_free_text_by_name
            .entry(note_name.to_string())
            .or_insert(annot_ref);
        self.named_free_text
            .push((annot_ref, note_name.to_string()));
        self.append_missing_refs(&[annot_ref, popup_ref]);
    }

    fn matching_stable_delete_refs(&self, delete: &AnnotationDelete) -> Vec<ObjectId> {
        let Some(stable_key) = delete.stable_key.as_deref().map(str::trim) else {
            return Vec::new();
        };
        if stable_key.is_empty() {
            return Vec::new();
        }
        let exact_name = replayable_free_text_note_name_from_parts(stable_key, delete.created_at);
        let stable_prefix = format!(
            "{}:created:",
            replayable_free_text_note_name_from_parts(stable_key, None)
        );
        self.named_free_text
            .iter()
            .filter_map(|(object_id, note_name)| {
                let matches = note_name == &exact_name
                    || (delete.created_at.is_none_or(|created_at| created_at == 0)
                        && note_name.starts_with(&stable_prefix));
                matches.then_some(*object_id)
            })
            .collect()
    }
}

pub(crate) fn build_page_annotation_index(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<(PageAnnotationIndex, usize)> {
    let annots = get_page_annots(document, page_id)?;
    let mut annotation_refs = HashSet::new();
    let mut first_free_text_by_name = HashMap::new();
    let mut named_free_text = Vec::new();
    let mut scanned = 0usize;
    for object in &annots {
        scanned += 1;
        let Ok(object_id) = object.as_reference() else {
            continue;
        };
        annotation_refs.insert(object_id);
        let Ok(dictionary) = document.dictionary(object_id) else {
            continue;
        };
        if annotation_subtype(dictionary) != "freetext" {
            continue;
        }
        let Some(note_name) = dictionary.get(b"NM").ok().and_then(pdf_string_to_text) else {
            continue;
        };
        first_free_text_by_name
            .entry(note_name.clone())
            .or_insert(object_id);
        named_free_text.push((object_id, note_name));
    }
    Ok((
        PageAnnotationIndex {
            annots,
            annotation_refs,
            first_free_text_by_name,
            named_free_text,
            dirty: false,
        },
        scanned,
    ))
}

pub(crate) fn write_page_annotation_index(
    document: &mut Document,
    page_id: ObjectId,
    index: PageAnnotationIndex,
) -> Result<()> {
    if index.dirty {
        document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(index.annots));
    }
    Ok(())
}

pub(crate) fn write_page_annotation_index_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    index: PageAnnotationIndex,
) -> Result<()> {
    if index.dirty {
        incremental.opt_clone_object_to_new_document(page_id)?;
        incremental
            .new_document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(index.annots));
    }
    Ok(())
}

pub(crate) fn get_page_annots(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<Vec<Object>> {
    let page = document.dictionary(page_id)?;
    let annots = match page.get(b"Annots") {
        Ok(object) => object,
        Err(_) => return Ok(Vec::new()),
    };
    let resolved = document.resolved(annots)?;
    Ok(resolved.as_array().cloned().unwrap_or_default())
}

pub(crate) fn append_annots_to_page(
    document: &mut Document,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    let mut annots = get_page_annots(document, page_id)?;
    annots.extend(refs.iter().copied().map(Object::Reference));
    let page = document.get_dictionary_mut(page_id)?;
    page.set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn append_annots_to_page_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    incremental.opt_clone_object_to_new_document(page_id)?;
    let mut annots = match get_page_annots(&incremental.new_document, page_id) {
        Ok(annots) => annots,
        Err(_) => get_page_annots(incremental.get_prev_documents(), page_id)?,
    };
    annots.extend(refs.iter().copied().map(Object::Reference));
    let page = incremental.new_document.get_dictionary_mut(page_id)?;
    page.set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn collect_annotation_refs_to_delete(
    document: &impl PdfObjectSource,
    target_id: ObjectId,
) -> Result<Vec<ObjectId>> {
    if document.dictionary(target_id).is_err() {
        return Err(format!(
            "Annotation delete target {}R{} was not found",
            target_id.0, target_id.1
        )
        .into());
    }

    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = vec![target_id];
    while let Some(object_id) = pending.pop() {
        if !seen.insert(object_id) {
            continue;
        }
        refs.push(object_id);

        let dict = match document.dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if let Some(popup_id) = annotation_related_ref(dict, b"Popup") {
            pending.push(popup_id);
        }
        if let Some(parent_id) = annotation_related_ref(dict, b"Parent") {
            if let Ok(parent_dict) = document.dictionary(parent_id) {
                let parent_subtype = annotation_subtype(parent_dict);
                if parent_subtype == "freetext" || parent_subtype == "popup" {
                    pending.push(parent_id);
                }
            }
        }
    }

    Ok(refs)
}

pub(crate) fn annotation_matches_stable_delete_name(
    document: &impl PdfObjectSource,
    object_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<bool> {
    let stable_key = match delete.stable_key.as_deref().map(str::trim) {
        Some(stable_key) if !stable_key.is_empty() => stable_key,
        _ => return Ok(false),
    };
    let dict = match document.dictionary(object_id) {
        Ok(dict) => dict,
        Err(_) => return Ok(false),
    };
    let target_dict = if annotation_subtype(dict) == "popup" {
        match annotation_related_ref(dict, b"Parent") {
            Some(parent_id) => match document.dictionary(parent_id) {
                Ok(parent_dict) => parent_dict,
                Err(_) => return Ok(false),
            },
            None => return Ok(false),
        }
    } else {
        dict
    };
    if annotation_subtype(target_dict) != "freetext" {
        return Ok(false);
    }
    let Some(note_name) = target_dict.get(b"NM").ok().and_then(pdf_string_to_text) else {
        return Ok(false);
    };
    let exact_name = replayable_free_text_note_name_from_parts(stable_key, delete.created_at);
    if note_name == exact_name {
        return Ok(true);
    }
    if delete.created_at.is_some_and(|created_at| created_at > 0) {
        return Ok(false);
    }
    let stable_prefix = format!(
        "{}:created:",
        replayable_free_text_note_name_from_parts(stable_key, None)
    );
    Ok(note_name.starts_with(&stable_prefix))
}

pub(crate) fn resolve_annotation_delete_target_refs(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<Vec<ObjectId>> {
    if let (Some(object_number), Some(generation_number)) =
        (delete.object_number, delete.generation_number)
    {
        return Ok(vec![(object_number, generation_number)]);
    }

    let (index, _) = build_page_annotation_index(document, page_id)?;
    resolve_annotation_delete_target_refs_from_index(&index, delete)
}

fn resolve_annotation_delete_target_refs_from_index(
    index: &PageAnnotationIndex,
    delete: &AnnotationDelete,
) -> Result<Vec<ObjectId>> {
    let matching_refs = index.matching_stable_delete_refs(delete);

    match matching_refs.len() {
        1 => Ok(matching_refs),
        0 => Err("No annotation matched requested stable-key delete target".into()),
        _ => Err("Stable-key delete target matched multiple annotations".into()),
    }
}

pub(crate) fn collect_delete_refs(
    document: &Document,
    deletes: &[AnnotationDelete],
) -> Result<HashSet<ObjectId>> {
    let page_map = document.get_pages();
    let mut refs_to_delete = HashSet::new();
    let mut annotation_indexes = HashMap::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            entry.insert(build_page_annotation_index(document, page_id)?.0);
        }
        let index = annotation_indexes
            .get(&page_id)
            .expect("Annotation-delete pages are indexed before lookup");
        let target_refs = if let (Some(object_number), Some(generation_number)) =
            (delete.object_number, delete.generation_number)
        {
            vec![(object_number, generation_number)]
        } else {
            resolve_annotation_delete_target_refs_from_index(index, delete)?
        };
        for target_id in target_refs {
            for object_id in collect_annotation_refs_to_delete(document, target_id)? {
                refs_to_delete.insert(object_id);
            }
        }
    }
    Ok(refs_to_delete)
}

pub(crate) fn filter_annots_without_refs(
    annots: Vec<Object>,
    refs_to_delete: &HashSet<ObjectId>,
) -> (Vec<Object>, bool) {
    let mut removed = false;
    let filtered = annots
        .into_iter()
        .filter(|object| {
            let should_remove = object
                .as_reference()
                .ok()
                .is_some_and(|object_id| refs_to_delete.contains(&object_id));
            if should_remove {
                removed = true;
            }
            !should_remove
        })
        .collect();
    (filtered, removed)
}

pub(crate) fn delete_annotations(
    document: &mut Document,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let refs_to_delete = collect_delete_refs(document, deletes)?;
    let page_map = document.get_pages();
    let mut removed_any = false;
    for page_id in page_map.values().copied() {
        let annots = get_page_annots(document, page_id)?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, &refs_to_delete);
        if !removed {
            continue;
        }
        let page = document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }

    if !removed_any {
        return Err("No requested annotation delete target was referenced from page Annots".into());
    }
    Ok(())
}

pub(crate) fn delete_annotations_incremental(
    incremental: &mut IncrementalDocument,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let refs_to_delete = collect_delete_refs(incremental.get_prev_documents(), deletes)?;
    let page_map = incremental.get_prev_documents().get_pages();
    let mut removed_any = false;
    for page_id in page_map.values().copied() {
        let annots = get_page_annots(&incremental.new_document, page_id)
            .or_else(|_| get_page_annots(incremental.get_prev_documents(), page_id))?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, &refs_to_delete);
        if !removed {
            continue;
        }
        incremental.opt_clone_object_to_new_document(page_id)?;
        let page = incremental.new_document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }

    if !removed_any {
        return Err("No requested annotation delete target was referenced from page Annots".into());
    }
    Ok(())
}

pub(crate) fn update_note_text_incremental(
    incremental: &mut IncrementalDocument,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    let mut updated_count = 0;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        if update_annotation_text_incremental_by_ref(
            incremental,
            target_id,
            &update.text,
            modified_at,
        )? {
            updated_count += 1;
        }
    }
    if updated_count != updates.len() {
        return Err(format!(
            "Updated {updated_count} of {} requested note annotation(s)",
            updates.len()
        )
        .into());
    }
    Ok(())
}

pub(crate) fn update_annotation_text_by_ref(
    document: &mut Document,
    target_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<bool> {
    let target_dict = match document.get_dictionary(target_id) {
        Ok(dict) => dict,
        Err(_) => return Ok(false),
    };
    let target_subtype = annotation_subtype(target_dict);
    let popup_ref = annotation_related_ref(target_dict, b"Popup");
    let parent_ref = if target_subtype == "popup" {
        annotation_related_ref(target_dict, b"Parent")
    } else {
        None
    };

    let target_dict = document.get_dictionary_mut(target_id)?;
    set_annotation_dict_contents(target_dict, text, modified_at);
    if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
        set_annotation_dict_contents(popup_dict, text, modified_at);
    }
    if target_subtype == "popup" {
        if let Ok(Object::Dictionary(parent_dict)) = target_dict.get_mut(b"Parent") {
            set_annotation_dict_contents(parent_dict, text, modified_at);
        }
    }

    if let Some(popup_id) = popup_ref {
        set_annotation_object_contents(document, popup_id, text, modified_at)?;
    }
    if let Some(parent_id) = parent_ref {
        set_annotation_object_contents(document, parent_id, text, modified_at)?;
    }

    Ok(true)
}

pub(crate) fn update_annotation_text_incremental_by_ref(
    incremental: &mut IncrementalDocument,
    target_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<bool> {
    let target_dict = match incremental.get_prev_documents().get_dictionary(target_id) {
        Ok(dict) => dict,
        Err(_) => return Ok(false),
    };
    let target_subtype = annotation_subtype(target_dict);
    let popup_ref = annotation_related_ref(target_dict, b"Popup");
    let parent_ref = if target_subtype == "popup" {
        annotation_related_ref(target_dict, b"Parent")
    } else {
        None
    };

    incremental.opt_clone_object_to_new_document(target_id)?;
    let target_dict = incremental.new_document.get_dictionary_mut(target_id)?;
    set_annotation_dict_contents(target_dict, text, modified_at);
    if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
        set_annotation_dict_contents(popup_dict, text, modified_at);
    }
    if target_subtype == "popup" {
        if let Ok(Object::Dictionary(parent_dict)) = target_dict.get_mut(b"Parent") {
            set_annotation_dict_contents(parent_dict, text, modified_at);
        }
    }

    if let Some(popup_id) = popup_ref {
        set_annotation_incremental_object_contents(incremental, popup_id, text, modified_at)?;
    }
    if let Some(parent_id) = parent_ref {
        set_annotation_incremental_object_contents(incremental, parent_id, text, modified_at)?;
    }

    Ok(true)
}

pub(crate) fn set_annotation_object_contents(
    document: &mut Document,
    object_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<()> {
    if let Ok(dict) = document.get_dictionary_mut(object_id) {
        set_annotation_dict_contents(dict, text, modified_at);
    }
    Ok(())
}

pub(crate) fn set_annotation_incremental_object_contents(
    incremental: &mut IncrementalDocument,
    object_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<()> {
    if incremental
        .get_prev_documents()
        .get_dictionary(object_id)
        .is_err()
    {
        return Ok(());
    }
    incremental.opt_clone_object_to_new_document(object_id)?;
    let dict = incremental.new_document.get_dictionary_mut(object_id)?;
    set_annotation_dict_contents(dict, text, modified_at);
    Ok(())
}

pub(crate) fn set_annotation_dict_contents(dict: &mut Dictionary, text: &str, modified_at: &str) {
    dict.set(
        "Contents",
        Object::String(encode_pdf_text_string(text), StringFormat::Hexadecimal),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
}

pub(crate) fn pdf_string_to_text(object: &Object) -> Option<String> {
    let bytes = object.as_str().ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for chunk in bytes[2..].chunks_exact(2) {
            units.push(u16::from_be_bytes([chunk[0], chunk[1]]));
        }
        return String::from_utf16(&units).ok();
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

pub(crate) fn encode_pdf_text_string(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + (text.len() * 2));
    bytes.push(0xFE);
    bytes.push(0xFF);
    for code_unit in text.encode_utf16() {
        bytes.push((code_unit >> 8) as u8);
        bytes.push((code_unit & 0xFF) as u8);
    }
    bytes
}

pub(crate) fn rect_object(rect: PdfRect) -> Object {
    Object::Array(vec![
        number_object(rect.x1),
        number_object(rect.y1),
        number_object(rect.x2),
        number_object(rect.y2),
    ])
}

pub(crate) fn annotation_related_ref(dict: &Dictionary, key: &[u8]) -> Option<ObjectId> {
    dict.get(key).and_then(Object::as_reference).ok()
}

pub(crate) fn annotation_subtype(dict: &Dictionary) -> String {
    dict.get(b"Subtype")
        .and_then(Object::as_name)
        .ok()
        .map(|name| {
            String::from_utf8_lossy(name)
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn parse_hex_color_component(high: u8, low: u8) -> Option<f64> {
    let high = parse_hex_digit(high)?;
    let low = parse_hex_digit(low)?;
    Some(f64::from(high * 16 + low) / 255.0)
}

pub(crate) fn parse_rgb_number(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.0, 255.0) / 255.0)
}

pub(crate) fn parse_pdf_color(color: Option<&str>) -> Option<[f64; 3]> {
    let trimmed = color?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("transparent")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return None;
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        let bytes = hex.as_bytes();
        if bytes.len() == 3 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[0])?,
                parse_hex_color_component(bytes[1], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[2])?,
            ]);
        }
        if bytes.len() == 6 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[3])?,
                parse_hex_color_component(bytes[4], bytes[5])?,
            ]);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let args = lower
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| {
            lower
                .strip_prefix("rgba(")
                .and_then(|value| value.strip_suffix(')'))
        })?;
    let mut parts = args.split(',');
    Some([
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
    ])
}

pub(crate) fn set_rgb_color(dict: &mut Dictionary, key: &str, color: Option<&str>) {
    if let Some(rgb) = parse_pdf_color(color) {
        dict.set(
            key,
            Object::Array(vec![
                number_object(rgb[0]),
                number_object(rgb[1]),
                number_object(rgb[2]),
            ]),
        );
        return;
    }
    dict.remove(key.as_bytes());
}
