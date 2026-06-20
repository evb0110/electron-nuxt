struct SkipWriter<W: Write> {
    inner: W,
    bytes_to_skip: usize,
}

impl<W: Write> SkipWriter<W> {
    fn new(inner: W, bytes_to_skip: usize) -> Self {
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

fn append_note_text_update(
    input_path: &PathBuf,
    output_path: &PathBuf,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
    }

    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    update_note_text_incremental(&mut incremental, updates, modified_at)?;

    let previous_bytes = incremental.get_prev_documents_bytes();
    let output_bytes = fs::read(output_path)?;
    if output_bytes.as_slice() != previous_bytes {
        return Err(
            "Append output must already contain an exact byte-for-byte copy of the input PDF"
                .into(),
        );
    }
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
    )?;
    if should_run_full_incremental_post_save_validation() {
        let output_document = Document::load(output_path)?;
        validate_note_text_document_postconditions(&output_document, updates, modified_at)?;
    }
    Ok(())
}

fn append_note_changes(
    input_path: &PathBuf,
    output_path: &PathBuf,
    changes: &NoteChangesFile,
    modified_at: &str,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
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
    let output_bytes = fs::read(output_path)?;
    if output_bytes.as_slice() != previous_bytes {
        return Err(
            "Append output must already contain an exact byte-for-byte copy of the input PDF"
                .into(),
        );
    }
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
    )?;
    if should_run_full_incremental_post_save_validation() {
        let output_document = Document::load(output_path)?;
        validate_note_text_document_postconditions(
            &output_document,
            &changes.updates,
            modified_at,
        )?;
        validate_free_text_note_document_postconditions(
            &output_document,
            &changes.free_text_notes,
            modified_at,
        )?;
        validate_annotation_delete_document_postconditions(&output_document, &changes.deletes)?;
    }
    Ok(())
}

fn apply_native_mutations(
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

fn apply_native_mutations_incremental(
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

fn append_native_mutations(
    input_path: &PathBuf,
    output_path: &PathBuf,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    let mut incremental = IncrementalDocument::load(input_path)?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
    }

    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    apply_native_mutations_incremental(&mut incremental, mutations, modified_at)?;

    let previous_bytes = incremental.get_prev_documents_bytes();
    let output_bytes = fs::read(output_path)?;
    if output_bytes.as_slice() != previous_bytes {
        return Err(
            "Append output must already contain an exact byte-for-byte copy of the input PDF"
                .into(),
        );
    }
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
    )?;
    if should_run_full_incremental_post_save_validation() {
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
    }
    Ok(())
}

fn collect_incremental_append_object_ids(incremental: &IncrementalDocument) -> Vec<ObjectId> {
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

fn should_write_incremental_object(object: &Object) -> bool {
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

fn should_run_full_incremental_post_save_validation_for(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        Some("0") => false,
        Some(value) if value.eq_ignore_ascii_case("false") => false,
        Some(value) if value.eq_ignore_ascii_case("no") => false,
        _ => true,
    }
}

fn should_run_full_incremental_post_save_validation() -> bool {
    let value = env::var("EVB_PDF_PAGE_OPS_FULL_INCREMENTAL_VALIDATE").ok();
    should_run_full_incremental_post_save_validation_for(value.as_deref())
}

fn validate_incremental_append_output(
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
            "Native incremental append /Prev pointer does not match the previous revision"
                .into(),
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

fn validate_expected_incremental_objects(
    appended_bytes: &[u8],
    previous_len: u64,
    expected_object_ids: &[ObjectId],
    xref_entries: &HashMap<ObjectId, u64>,
) -> Result<()> {
    for object_id in expected_object_ids {
        let xref_offset = xref_entries
            .get(object_id)
            .ok_or_else(|| format!("Native incremental append xref is missing object {object_id:?}"))?;
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

fn parse_incremental_xref_table(
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

fn parse_incremental_xref_stream(
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
    if !contains_bytes(dictionary_bytes, b"/Type/XRef")
        && !(contains_bytes(dictionary_bytes, b"/Type") && contains_bytes(dictionary_bytes, b"/XRef"))
    {
        return Err("Native incremental append xref stream is missing /Type /XRef".into());
    }
    if contains_bytes(dictionary_bytes, b"/Filter") {
        return Err("Native incremental append xref stream uses an unsupported filter".into());
    }
    parse_number_after_marker(dictionary_bytes, b"/Size")
        .ok_or("Native incremental append xref stream is missing /Size")?;
    let w_values = parse_number_array_after_marker(dictionary_bytes, b"/W")
        .ok_or("Native incremental append xref stream is missing /W")?;
    if w_values.as_slice() != [1, 4, 2] {
        return Err("Native incremental append xref stream has unsupported /W widths".into());
    }
    let index_values = parse_number_array_after_marker(dictionary_bytes, b"/Index")
        .ok_or("Native incremental append xref stream is missing /Index")?;
    if index_values.len() % 2 != 0 {
        return Err("Native incremental append xref stream has an invalid /Index array".into());
    }

    let stream_content_start = skip_stream_line_ending(xref_bytes, stream_marker_offset + b"stream".len());
    let endstream_offset = find_bytes(&xref_bytes[stream_content_start..], b"endstream")
        .map(|offset| stream_content_start + offset)
        .ok_or("Native incremental append xref stream is missing endstream")?;
    let mut stream_content_end = endstream_offset;
    if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\n' {
        stream_content_end -= 1;
        if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\r' {
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
                .get(content_cursor..content_cursor + 7)
                .ok_or("Native incremental append xref stream ended early")?;
            content_cursor += 7;
            if entry[0] == 1 {
                let offset = u32::from_be_bytes([entry[1], entry[2], entry[3], entry[4]]) as u64;
                let generation = u16::from_be_bytes([entry[5], entry[6]]);
                entries.insert((start_object + object_index, generation), offset);
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

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn find_last_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_number_after_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

fn parse_number_after_last_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_last_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

fn parse_number_array_after_marker(bytes: &[u8], marker: &[u8]) -> Option<Vec<u64>> {
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

fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

fn skip_stream_line_ending(bytes: &[u8], index: usize) -> usize {
    match bytes.get(index..) {
        Some(bytes) if bytes.starts_with(b"\r\n") => index + 2,
        Some(bytes) if bytes.starts_with(b"\n") || bytes.starts_with(b"\r") => index + 1,
        _ => index,
    }
}

fn parse_u64_token(bytes: &[u8], index: usize) -> Option<(u64, usize)> {
    let mut index = skip_ascii_whitespace(bytes, index);
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if start == index {
        return None;
    }
    let value = std::str::from_utf8(&bytes[start..index]).ok()?.parse().ok()?;
    Some((value, index))
}

fn parse_u32_token(bytes: &[u8], index: usize) -> Option<(u32, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u32::try_from(value).ok()?, index))
}

fn parse_u16_token(bytes: &[u8], index: usize) -> Option<(u16, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u16::try_from(value).ok()?, index))
}

fn parse_non_whitespace_byte(bytes: &[u8], index: usize) -> Option<(u8, usize)> {
    let index = skip_ascii_whitespace(bytes, index);
    Some((*bytes.get(index)?, index + 1))
}

fn parse_non_whitespace_token(bytes: &[u8], index: usize) -> Option<(&[u8], usize)> {
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
