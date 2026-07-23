use super::*;

pub(crate) struct SkipWriter<W: Write> {
    pub(crate) inner: W,
    pub(crate) bytes_to_skip: usize,
}

impl<W: Write> SkipWriter<W> {
    pub(crate) fn new(inner: W, bytes_to_skip: usize) -> Self {
        Self {
            inner,
            bytes_to_skip,
        }
    }
}

impl<W: Write> Write for SkipWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let skipped = self.bytes_to_skip.min(buf.len());
        self.bytes_to_skip -= skipped;
        if skipped == buf.len() {
            return Ok(buf.len());
        }
        let written = self.inner.write(&buf[skipped..])?;
        Ok(skipped + written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub(crate) fn append_paths_refer_to_same_file(input_path: &PathBuf, output_path: &PathBuf) -> bool {
    if input_path == output_path {
        return true;
    }

    match (fs::canonicalize(input_path), fs::canonicalize(output_path)) {
        (Ok(input), Ok(output)) => input == output,
        _ => false,
    }
}

pub(crate) fn assert_append_output_seeded(
    input_path: &PathBuf,
    output_path: &PathBuf,
    previous_bytes: &[u8],
) -> Result<()> {
    if append_paths_refer_to_same_file(input_path, output_path) {
        return Ok(());
    }

    let output_bytes = fs::read(output_path)?;
    if output_bytes.as_slice() == previous_bytes {
        return Ok(());
    }

    Err("Append output must already contain an exact byte-for-byte copy of the input PDF".into())
}

pub(crate) fn append_note_text_update(
    input_path: &PathBuf,
    output_path: &PathBuf,
    updates: &[NoteTextUpdate],
    modified_at: &str,
    _incremental_validation: IncrementalValidationMode,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by native page ops",
        ));
    }

    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    update_note_text_incremental(&mut incremental, updates, modified_at)?;

    let previous_bytes = incremental.get_prev_documents_bytes();
    assert_append_output_seeded(input_path, output_path, previous_bytes)?;
    let previous_len = previous_bytes.len();
    let previous_xref_start = incremental.get_prev_documents().xref_start;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(
        output_path,
        previous_len,
        previous_xref_start,
        &expected_object_ids,
    )
    .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    let output_document = Document::load(output_path)?;
    validate_note_text_document_postconditions(&output_document, updates, modified_at)?;
    Ok(())
}

pub(crate) fn append_note_changes(
    input_path: &PathBuf,
    output_path: &PathBuf,
    changes: &NoteChangesFile,
    modified_at: &str,
    _incremental_validation: IncrementalValidationMode,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by native page ops",
        ));
    }

    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    if !changes.updates.is_empty() {
        update_note_text_incremental(&mut incremental, &changes.updates, modified_at)?;
    }
    if !changes.free_text_notes.is_empty() {
        upsert_free_text_notes_incremental(
            &mut incremental,
            &changes.free_text_notes,
            modified_at,
        )?;
    }
    if !changes.deletes.is_empty() {
        delete_annotations_incremental(&mut incremental, &changes.deletes)?;
    }

    let previous_bytes = incremental.get_prev_documents_bytes();
    assert_append_output_seeded(input_path, output_path, previous_bytes)?;
    let previous_len = previous_bytes.len();
    let previous_xref_start = incremental.get_prev_documents().xref_start;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(
        output_path,
        previous_len,
        previous_xref_start,
        &expected_object_ids,
    )
    .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    let output_document = Document::load(output_path)?;
    validate_note_text_document_postconditions(&output_document, &changes.updates, modified_at)?;
    validate_free_text_note_document_postconditions(
        &output_document,
        &changes.free_text_notes,
        modified_at,
    )?;
    validate_annotation_delete_document_postconditions(&output_document, &changes.deletes)?;
    Ok(())
}

pub(crate) fn apply_native_mutations(
    document: &mut Document,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    if !mutations.updates.is_empty() {
        update_note_text(document, &mutations.updates, modified_at)?;
    }
    if !mutations.free_text_notes.is_empty() {
        upsert_free_text_notes(document, &mutations.free_text_notes, modified_at)?;
    }
    if !mutations.deletes.is_empty() {
        delete_annotations(document, &mutations.deletes)?;
    }
    if let Some(page_labels) = &mutations.page_labels {
        set_page_labels(document, page_labels)?;
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        set_bookmarks(document, bookmarks)?;
    }
    if let Some(shapes) = &mutations.shapes {
        apply_shape_annotations(document, shapes, modified_at)?;
    }
    if let Some(markup) = &mutations.markup {
        apply_markup_mutations(document, markup)?;
    }
    if !mutations.placed_images.is_empty() {
        apply_placed_images(document, &mutations.placed_images, modified_at)?;
    }
    Ok(())
}

pub(crate) fn apply_native_mutations_incremental(
    incremental: &mut IncrementalDocument,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    if !mutations.updates.is_empty() {
        update_note_text_incremental(incremental, &mutations.updates, modified_at)?;
    }
    if !mutations.free_text_notes.is_empty() {
        upsert_free_text_notes_incremental(incremental, &mutations.free_text_notes, modified_at)?;
    }
    if !mutations.deletes.is_empty() {
        delete_annotations_incremental(incremental, &mutations.deletes)?;
    }
    if let Some(page_labels) = &mutations.page_labels {
        set_page_labels_incremental(incremental, page_labels)?;
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        set_bookmarks_incremental(incremental, bookmarks)?;
    }
    if let Some(shapes) = &mutations.shapes {
        apply_shape_annotations_incremental(incremental, shapes, modified_at)?;
    }
    if let Some(markup) = &mutations.markup {
        apply_markup_mutations_incremental(incremental, markup)?;
    }
    if !mutations.placed_images.is_empty() {
        apply_placed_images_incremental(incremental, &mutations.placed_images, modified_at)?;
    }
    Ok(())
}

pub(crate) fn append_native_mutations(
    input_path: &PathBuf,
    output_path: &PathBuf,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    incremental_validation: IncrementalValidationMode,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by native page ops",
        ));
    }

    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    apply_native_mutations_incremental(&mut incremental, mutations, modified_at)?;

    let previous_bytes = incremental.get_prev_documents_bytes();
    assert_append_output_seeded(input_path, output_path, previous_bytes)?;
    let previous_len = previous_bytes.len();
    let previous_xref_start = incremental.get_prev_documents().xref_start;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(
        output_path,
        previous_len,
        previous_xref_start,
        &expected_object_ids,
    )
    .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    if should_run_full_native_mutation_validation(incremental_validation, mutations) {
        let output_document = Document::load(output_path)?;
        validate_note_text_document_postconditions(
            &output_document,
            &mutations.updates,
            modified_at,
        )?;
        validate_free_text_note_document_postconditions(
            &output_document,
            &mutations.free_text_notes,
            modified_at,
        )?;
        validate_annotation_delete_document_postconditions(&output_document, &mutations.deletes)?;
        if let Some(page_labels) = &mutations.page_labels {
            validate_page_labels_document_postconditions(&output_document, page_labels)?;
        }
        if let Some(bookmarks) = &mutations.bookmarks {
            validate_bookmarks_document_postconditions(&output_document, bookmarks)?;
        }
        if let Some(shapes) = &mutations.shapes {
            validate_shapes_document_postconditions(&output_document, shapes)?;
        }
        if let Some(markup) = &mutations.markup {
            validate_markup_document_postconditions(&output_document, markup)?;
        }
        validate_placed_image_document_postconditions(
            &output_document,
            &mutations.placed_images,
            modified_at,
        )?;
    } else {
        validate_incremental_metadata_postconditions(&incremental, mutations)?;
    }
    Ok(())
}

pub(crate) fn collect_incremental_append_object_ids(
    incremental: &IncrementalDocument,
) -> Vec<ObjectId> {
    incremental
        .new_document
        .objects
        .iter()
        .filter_map(|(&object_id, object)| {
            if should_write_incremental_object(object) {
                Some(object_id)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn should_write_incremental_object(object: &Object) -> bool {
    object
        .type_name()
        .map(|name| {
            ![
                b"ObjStm".as_slice(),
                b"XRef".as_slice(),
                b"Linearized".as_slice(),
            ]
            .contains(&name)
        })
        .unwrap_or(true)
}

pub(crate) fn validate_incremental_metadata_postconditions(
    incremental: &IncrementalDocument,
    mutations: &NativeMutationsFile,
) -> Result<()> {
    if let Some(page_labels) = &mutations.page_labels {
        validate_incremental_page_labels_postconditions(incremental, page_labels)?;
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        validate_incremental_bookmarks_postconditions(incremental, bookmarks)?;
    }
    Ok(())
}

fn validate_incremental_page_labels_postconditions(
    incremental: &IncrementalDocument,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    let catalog_id = catalog_id(incremental.get_prev_documents())?;
    let catalog = incremental.new_document.get_dictionary(catalog_id)?;
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        if catalog.get(b"PageLabels").is_ok() {
            return Err("PageLabels should be removed for implicit default labels".into());
        }
        return Ok(());
    }

    let page_labels_dict = catalog.get(b"PageLabels")?.as_dict()?;
    let nums = page_labels_dict.get(b"Nums")?.as_array()?;
    let expected_ranges = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    if nums.len() != expected_ranges.len() * 2 {
        return Err("PageLabels Nums length did not match requested ranges".into());
    }
    for (objects, expected) in nums.chunks_exact(2).zip(expected_ranges) {
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
    }
    Ok(())
}

fn validate_incremental_bookmarks_postconditions(
    incremental: &IncrementalDocument,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    let catalog_id = catalog_id(incremental.get_prev_documents())?;
    let catalog = incremental.new_document.get_dictionary(catalog_id)?;
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
    let outlines = incremental.new_document.get_dictionary(outlines_id)?;
    if outlines.get(b"Count")?.as_i64()? != i64::try_from(count_bookmark_items(&normalized))? {
        return Err("Outlines Count did not match requested bookmarks".into());
    }
    let first = outlines.get(b"First")?.as_reference()?;
    let last = outlines.get(b"Last")?.as_reference()?;
    let page_map = incremental.get_prev_documents().get_pages();
    validate_incremental_bookmark_level(
        incremental,
        &page_map,
        &normalized,
        outlines_id,
        first,
        last,
    )
}

fn validate_incremental_bookmark_level(
    incremental: &IncrementalDocument,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    items: &[BookmarkEntry],
    parent_id: ObjectId,
    first: ObjectId,
    last: ObjectId,
) -> Result<()> {
    let mut current = Some(first);
    let mut previous = None;
    for item in items {
        let object_id = current.ok_or("Outline chain ended before all bookmarks were validated")?;
        let bookmark = incremental.new_document.get_dictionary(object_id)?;
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
        validate_incremental_bookmark_destination(
            incremental.get_prev_documents(),
            page_map,
            bookmark,
            item,
        )?;

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
            validate_incremental_bookmark_level(
                incremental,
                page_map,
                &item.items,
                object_id,
                child_first,
                child_last,
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

fn validate_incremental_bookmark_destination(
    base_document: &Document,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    bookmark: &Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(page_index) = item.page_index {
        let page_id = resolve_page_id(
            page_map,
            page_index
                .checked_add(1)
                .ok_or("Invalid bookmark page index")?,
        )?;
        let page_view = resolve_page_view(base_document, page_id)?;
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

pub(crate) fn incremental_validation_mode_from_environment_value(
    value: Option<&str>,
) -> IncrementalValidationMode {
    match value.map(str::trim) {
        Some("0") => IncrementalValidationMode::TailOnly,
        Some(value) if value.eq_ignore_ascii_case("false") => IncrementalValidationMode::TailOnly,
        Some(value) if value.eq_ignore_ascii_case("no") => IncrementalValidationMode::TailOnly,
        _ => IncrementalValidationMode::Full,
    }
}

pub(crate) fn resolve_incremental_validation_mode(
    explicit: Option<IncrementalValidationMode>,
) -> IncrementalValidationMode {
    explicit.unwrap_or_else(|| {
        let value = env::var("EVB_PDF_PAGE_OPS_FULL_INCREMENTAL_VALIDATE").ok();
        incremental_validation_mode_from_environment_value(value.as_deref())
    })
}

pub(crate) fn should_run_full_native_mutation_validation(
    mode: IncrementalValidationMode,
    mutations: &NativeMutationsFile,
) -> bool {
    mode == IncrementalValidationMode::Full
        || mutations.page_labels.is_none() && mutations.bookmarks.is_none()
        || !mutations.updates.is_empty()
        || !mutations.free_text_notes.is_empty()
        || !mutations.deletes.is_empty()
        || mutations.shapes.is_some()
        || mutations.markup.is_some()
        || !mutations.placed_images.is_empty()
}

pub(crate) fn validate_incremental_append_output(
    output_path: &PathBuf,
    previous_len: usize,
    previous_xref_start: usize,
    expected_object_ids: &[ObjectId],
) -> Result<()> {
    let final_len = fs::metadata(output_path)?.len();
    let previous_len = u64::try_from(previous_len)?;
    if final_len <= previous_len {
        return Err("Native incremental append did not grow the PDF".into());
    }

    let mut output = File::open(output_path)?;
    output.seek(SeekFrom::Start(previous_len))?;
    let mut appended_bytes = Vec::new();
    output.read_to_end(&mut appended_bytes)?;
    if appended_bytes.is_empty() {
        return Err("Native incremental append produced no revision bytes".into());
    }
    let eof_offset = find_last_bytes(&appended_bytes, b"%%EOF")
        .ok_or("Native incremental append is missing an EOF marker")?;
    if !appended_bytes[eof_offset + b"%%EOF".len()..]
        .iter()
        .all(|byte| byte.is_ascii_whitespace())
    {
        return Err("Native incremental append has trailing bytes after EOF".into());
    }

    let prev_offset = parse_number_after_last_marker(&appended_bytes, b"/Prev")
        .ok_or("Native incremental append is missing a /Prev pointer")?;
    if prev_offset != u64::try_from(previous_xref_start)? {
        return Err(
            "Native incremental append /Prev pointer does not match the previous revision".into(),
        );
    }

    let startxref_offset = parse_number_after_last_marker(&appended_bytes, b"startxref")
        .ok_or("Native incremental append is missing startxref")?;
    if startxref_offset < previous_len || startxref_offset >= final_len {
        return Err("Native incremental append startxref is outside the appended revision".into());
    }

    let xref_relative_offset = usize::try_from(startxref_offset - previous_len)?;
    let xref_entries = if appended_bytes
        .get(xref_relative_offset..)
        .is_some_and(|bytes| bytes.starts_with(b"xref"))
    {
        parse_incremental_xref_table(&appended_bytes, xref_relative_offset)?
    } else {
        parse_incremental_xref_stream(&appended_bytes, xref_relative_offset)?
    };
    validate_expected_incremental_objects(
        &appended_bytes,
        previous_len,
        expected_object_ids,
        &xref_entries,
    )?;

    Ok(())
}

pub(crate) fn validate_expected_incremental_objects(
    appended_bytes: &[u8],
    previous_len: u64,
    expected_object_ids: &[ObjectId],
    xref_entries: &HashMap<ObjectId, u64>,
) -> Result<()> {
    for object_id in expected_object_ids {
        let xref_offset = xref_entries.get(object_id).ok_or_else(|| {
            format!("Native incremental append xref is missing object {object_id:?}")
        })?;
        if *xref_offset < previous_len {
            return Err(format!(
                "Native incremental append xref for object {object_id:?} points before the appended revision"
            )
            .into());
        }
        let relative_offset = usize::try_from(*xref_offset - previous_len)?;
        let object_header = format!("{} {} obj", object_id.0, object_id.1);
        if !appended_bytes
            .get(relative_offset..)
            .is_some_and(|bytes| bytes.starts_with(object_header.as_bytes()))
        {
            return Err(format!(
                "Native incremental append xref for object {object_id:?} does not point to its object header"
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn parse_incremental_xref_table(
    appended_bytes: &[u8],
    xref_relative_offset: usize,
) -> Result<HashMap<ObjectId, u64>> {
    let mut cursor = xref_relative_offset + b"xref".len();
    let mut entries = HashMap::new();
    loop {
        cursor = skip_ascii_whitespace(appended_bytes, cursor);
        if appended_bytes
            .get(cursor..)
            .is_some_and(|bytes| bytes.starts_with(b"trailer"))
        {
            let trailer_bytes = &appended_bytes[cursor..];
            parse_number_after_marker(trailer_bytes, b"/Size")
                .ok_or("Native incremental append trailer is missing /Size")?;
            return Ok(entries);
        }

        let (start_object, next_cursor) = parse_u32_token(appended_bytes, cursor)
            .ok_or("Native incremental append xref table has an invalid subsection start")?;
        let (entry_count, next_cursor) = parse_u32_token(appended_bytes, next_cursor)
            .ok_or("Native incremental append xref table has an invalid subsection length")?;
        cursor = next_cursor;

        for index in 0..entry_count {
            let (offset, next_cursor) = parse_u64_token(appended_bytes, cursor)
                .ok_or("Native incremental append xref table has an invalid entry offset")?;
            let (generation, next_cursor) = parse_u16_token(appended_bytes, next_cursor)
                .ok_or("Native incremental append xref table has an invalid generation")?;
            let (kind, next_cursor) = parse_non_whitespace_byte(appended_bytes, next_cursor)
                .ok_or("Native incremental append xref table has an invalid entry type")?;
            cursor = next_cursor;
            if kind == b'n' {
                entries.insert((start_object + index, generation), offset);
            }
        }
    }
}

pub(crate) fn parse_incremental_xref_stream(
    appended_bytes: &[u8],
    xref_relative_offset: usize,
) -> Result<HashMap<ObjectId, u64>> {
    let xref_bytes = appended_bytes
        .get(xref_relative_offset..)
        .ok_or("Native incremental append xref stream offset is invalid")?;
    let (xref_object_number, cursor) = parse_u32_token(xref_bytes, 0)
        .ok_or("Native incremental append xref stream has an invalid object number")?;
    let (xref_generation, cursor) = parse_u16_token(xref_bytes, cursor)
        .ok_or("Native incremental append xref stream has an invalid generation")?;
    let (object_marker, _) = parse_non_whitespace_token(xref_bytes, cursor)
        .ok_or("Native incremental append xref stream has an invalid object header")?;
    if object_marker != b"obj" || xref_generation != 0 {
        return Err("Native incremental append xref stream object header is invalid".into());
    }

    let stream_marker_offset = find_bytes(xref_bytes, b"stream")
        .ok_or("Native incremental append xref stream is missing stream data")?;
    let dictionary_bytes = &xref_bytes[..stream_marker_offset];
    if !(contains_bytes(dictionary_bytes, b"/Type/XRef")
        || contains_bytes(dictionary_bytes, b"/Type") && contains_bytes(dictionary_bytes, b"/XRef"))
    {
        return Err("Native incremental append xref stream is missing /Type /XRef".into());
    }
    if contains_bytes(dictionary_bytes, b"/Filter") {
        return Err(domain_error(
            NativeErrorCode::UnsupportedFilter,
            "Native incremental append xref stream uses an unsupported filter",
        ));
    }
    parse_number_after_marker(dictionary_bytes, b"/Size")
        .ok_or("Native incremental append xref stream is missing /Size")?;
    let w_values = parse_number_array_after_marker(dictionary_bytes, b"/W")
        .ok_or("Native incremental append xref stream is missing /W")?;
    if w_values.len() != 3 || w_values.iter().any(|width| *width > 8) {
        return Err("Native incremental append xref stream has unsupported /W widths".into());
    }
    let widths = [
        usize::try_from(w_values[0])?,
        usize::try_from(w_values[1])?,
        usize::try_from(w_values[2])?,
    ];
    let entry_stride = widths
        .iter()
        .try_fold(0usize, |total, width| total.checked_add(*width))
        .filter(|stride| *stride > 0)
        .ok_or("Native incremental append xref stream has an invalid /W stride")?;
    let index_values = parse_number_array_after_marker(dictionary_bytes, b"/Index")
        .ok_or("Native incremental append xref stream is missing /Index")?;
    if index_values.len() % 2 != 0 {
        return Err("Native incremental append xref stream has an invalid /Index array".into());
    }

    let stream_content_start =
        skip_stream_line_ending(xref_bytes, stream_marker_offset + b"stream".len());
    let endstream_offset = find_bytes(&xref_bytes[stream_content_start..], b"endstream")
        .map(|offset| stream_content_start + offset)
        .ok_or("Native incremental append xref stream is missing endstream")?;
    let mut stream_content_end = endstream_offset;
    if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\n' {
        stream_content_end -= 1;
        if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\r'
        {
            stream_content_end -= 1;
        }
    }
    let stream_content = &xref_bytes[stream_content_start..stream_content_end];
    let declared_length = parse_number_after_marker(dictionary_bytes, b"/Length")
        .ok_or("Native incremental append xref stream is missing /Length")?;
    if declared_length != u64::try_from(stream_content.len())? {
        return Err("Native incremental append xref stream length does not match /Length".into());
    }

    let mut entries = HashMap::new();
    let mut content_cursor = 0;
    for pair in index_values.chunks(2) {
        let start_object = u32::try_from(pair[0])?;
        let entry_count = u32::try_from(pair[1])?;
        for object_index in 0..entry_count {
            let entry = stream_content
                .get(content_cursor..content_cursor + entry_stride)
                .ok_or("Native incremental append xref stream ended early")?;
            content_cursor += entry_stride;
            let mut field_cursor = 0usize;
            let entry_type = if widths[0] == 0 {
                1
            } else {
                read_xref_stream_field(entry, &mut field_cursor, widths[0])?
            };
            let offset = read_xref_stream_field(entry, &mut field_cursor, widths[1])?;
            let generation = read_xref_stream_field(entry, &mut field_cursor, widths[2])?;
            if entry_type == 1 {
                entries.insert(
                    (start_object + object_index, u16::try_from(generation)?),
                    offset,
                );
            }
        }
    }
    if content_cursor != stream_content.len() {
        return Err("Native incremental append xref stream contains extra entry bytes".into());
    }
    let xref_absolute_offset = parse_number_after_last_marker(appended_bytes, b"startxref")
        .ok_or("Native incremental append is missing startxref")?;
    entries
        .get(&(xref_object_number, 0))
        .filter(|offset| **offset == xref_absolute_offset)
        .ok_or("Native incremental append xref stream does not point to itself")?;

    Ok(entries)
}

#[doc(hidden)]
pub fn fuzz_parse_incremental_xref_table(data: &[u8]) {
    let _ = parse_incremental_xref_table(data, 0);
}

#[doc(hidden)]
pub fn fuzz_parse_incremental_xref_stream(data: &[u8]) {
    let _ = parse_incremental_xref_stream(data, 0);
}

pub(crate) fn read_xref_stream_field(
    entry: &[u8],
    cursor: &mut usize,
    width: usize,
) -> Result<u64> {
    let bytes = entry
        .get(
            *cursor
                ..cursor
                    .checked_add(width)
                    .ok_or("Invalid xref field width")?,
        )
        .ok_or("Native incremental append xref stream field ended early")?;
    *cursor += width;
    bytes.iter().try_fold(0u64, |value, byte| {
        value
            .checked_mul(256)
            .and_then(|value| value.checked_add(u64::from(*byte)))
            .ok_or_else(|| "Native incremental append xref stream field overflow".into())
    })
}

pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

pub(crate) fn find_last_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

pub(crate) fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub(crate) fn parse_number_after_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

pub(crate) fn parse_number_after_last_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_last_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

pub(crate) fn parse_number_array_after_marker(bytes: &[u8], marker: &[u8]) -> Option<Vec<u64>> {
    let mut index = skip_ascii_whitespace(bytes, find_bytes(bytes, marker)? + marker.len());
    if bytes.get(index) != Some(&b'[') {
        return None;
    }
    index += 1;
    let mut values = Vec::new();
    loop {
        index = skip_ascii_whitespace(bytes, index);
        match bytes.get(index) {
            Some(b']') => return Some(values),
            Some(_) => {
                let (value, next_index) = parse_u64_token(bytes, index)?;
                values.push(value);
                index = next_index;
            }
            None => return None,
        }
    }
}

pub(crate) fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

pub(crate) fn skip_stream_line_ending(bytes: &[u8], index: usize) -> usize {
    match bytes.get(index..) {
        Some(bytes) if bytes.starts_with(b"\r\n") => index + 2,
        Some(bytes) if bytes.starts_with(b"\n") || bytes.starts_with(b"\r") => index + 1,
        _ => index,
    }
}

pub(crate) fn parse_u64_token(bytes: &[u8], index: usize) -> Option<(u64, usize)> {
    let mut index = skip_ascii_whitespace(bytes, index);
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if start == index {
        return None;
    }
    let value = std::str::from_utf8(&bytes[start..index])
        .ok()?
        .parse()
        .ok()?;
    Some((value, index))
}

pub(crate) fn parse_u32_token(bytes: &[u8], index: usize) -> Option<(u32, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u32::try_from(value).ok()?, index))
}

pub(crate) fn parse_u16_token(bytes: &[u8], index: usize) -> Option<(u16, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u16::try_from(value).ok()?, index))
}

pub(crate) fn parse_non_whitespace_byte(bytes: &[u8], index: usize) -> Option<(u8, usize)> {
    let index = skip_ascii_whitespace(bytes, index);
    Some((*bytes.get(index)?, index + 1))
}

pub(crate) fn parse_non_whitespace_token(bytes: &[u8], index: usize) -> Option<(&[u8], usize)> {
    let mut index = skip_ascii_whitespace(bytes, index);
    let start = index;
    while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if start == index {
        return None;
    }
    Some((&bytes[start..index], index))
}

#[cfg(test)]
mod xref_stream_canary_tests {
    use super::*;

    #[test]
    fn accepts_dynamic_xref_stream_widths_and_stride() {
        let appended = b"5 0 obj\n<</Type/XRef/Size 6/W[1 2 1]/Index[5 1]/Length 4>>\nstream\n\x01\x00\x00\x00\nendstream\nendobj\nstartxref\n0\n%%EOF\n";
        let entries = parse_incremental_xref_stream(appended, 0).unwrap();
        assert_eq!(entries.get(&(5, 0)), Some(&0));
    }
}
