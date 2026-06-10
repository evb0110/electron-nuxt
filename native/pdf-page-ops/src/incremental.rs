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

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(output_path, previous_len)?;
    let output_document = Document::load(output_path)?;
    validate_note_text_document_postconditions(&output_document, updates, modified_at)?;
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

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(output_path, previous_len)?;
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

    let output = OpenOptions::new().append(true).open(output_path)?;
    let mut writer = SkipWriter::new(output, previous_len);
    incremental.save_to(&mut writer)?;
    writer.flush()?;

    validate_incremental_append_output(output_path, previous_len)?;
    let output_document = Document::load(output_path)?;
    validate_note_text_document_postconditions(&output_document, &mutations.updates, modified_at)?;
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
    Ok(())
}

fn validate_incremental_append_output(output_path: &PathBuf, previous_len: usize) -> Result<()> {
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
    if !contains_bytes(&appended_bytes, b"%%EOF") {
        return Err("Native incremental append is missing an EOF marker".into());
    }

    let prev_offset = parse_number_after_last_marker(&appended_bytes, b"/Prev")
        .ok_or("Native incremental append is missing a /Prev pointer")?;
    if prev_offset >= previous_len {
        return Err(
            "Native incremental append /Prev pointer does not reference the previous revision"
                .into(),
        );
    }

    let startxref_offset = parse_number_after_last_marker(&appended_bytes, b"startxref")
        .ok_or("Native incremental append is missing startxref")?;
    if startxref_offset < previous_len || startxref_offset >= final_len {
        return Err("Native incremental append startxref is outside the appended revision".into());
    }

    Ok(())
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

fn parse_number_after_last_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let mut index = find_last_bytes(bytes, marker)? + marker.len();
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if start == index {
        return None;
    }
    std::str::from_utf8(&bytes[start..index]).ok()?.parse().ok()
}
