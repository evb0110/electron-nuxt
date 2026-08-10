use super::*;

pub(crate) fn parse_margin(value: &str, label: &str) -> Result<f64> {
    let parsed = value.parse::<f64>()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("Invalid {label} margin").into());
    }
    Ok(parsed)
}

pub(crate) fn read_pages_file(path: &Path) -> Result<Vec<u32>> {
    read_pages_file_with_limits(path, MAX_SIDECAR_BYTES, MAX_COLLECTION_ITEMS)
}

fn read_pages_file_with_limits(
    path: &Path,
    max_bytes: usize,
    max_items: usize,
) -> Result<Vec<u32>> {
    let bytes = read_file_bounded(path, max_bytes, "page selection file").map_err(|error| {
        if error.code == NativeErrorCode::Io {
            domain_error(NativeErrorCode::InvalidRequest, error.message)
        } else {
            Box::new(error)
        }
    })?;
    let contents = std::str::from_utf8(&bytes).map_err(|error| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            format!("Invalid page selection file UTF-8: {error}"),
        )
    })?;
    let mut pages = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let page = trimmed
            .parse::<u32>()
            .map_err(|_| format!("Invalid page number on line {}", index + 1))?;
        if page == 0 {
            return Err(format!("Invalid page number on line {}", index + 1).into());
        }
        if pages.len() == max_items {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("Page selection exceeds the {max_items}-item admission ceiling"),
            ));
        }
        pages.push(page);
    }
    if pages.is_empty() {
        return Err("At least one page must be selected".into());
    }
    Ok(pages)
}

pub(crate) fn read_note_text_updates(path: &Path) -> Result<Vec<NoteTextUpdate>> {
    let parsed: NoteTextUpdatesFile = read_json_sidecar(path, "note text updates")?;
    if parsed.updates.is_empty() {
        return Err("At least one note text update is required".into());
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_note_text_budget(&parsed.updates)?;
    Ok(parsed.updates)
}

pub(crate) fn validate_free_text_notes(notes: &[FreeTextNote]) -> Result<()> {
    for note in notes {
        if note.stable_key.trim().is_empty() {
            return Err("Invalid FreeText note stable key".into());
        }
        validate_marker_rect(note.marker_rect)?;
    }
    Ok(())
}

pub(crate) fn validate_annotation_deletes(deletes: &[AnnotationDelete]) -> Result<()> {
    for delete in deletes {
        let has_ref = delete.object_number.is_some() || delete.generation_number.is_some();
        let has_valid_ref = matches!(
            (delete.object_number, delete.generation_number),
            (Some(object_number), Some(_generation_number)) if object_number > 0
        );
        let has_stable_key = delete
            .stable_key
            .as_deref()
            .is_some_and(|stable_key| !stable_key.trim().is_empty());
        if (!has_stable_key || has_ref) && !has_valid_ref {
            return Err("Annotation delete must include a valid object ref or stable key".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_marker_rect(rect: MarkerRect) -> Result<()> {
    if !rect.left.is_finite()
        || !rect.top.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.left < 0.0
        || rect.top < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.left + rect.width > 1.0
        || rect.top + rect.height > 1.0
    {
        return Err("Invalid FreeText note marker rectangle".into());
    }
    Ok(())
}

pub(crate) fn read_note_changes(path: &Path) -> Result<NoteChangesFile> {
    let parsed: NoteChangesFile = read_json_sidecar(path, "note changes")?;
    if parsed.updates.is_empty() && parsed.free_text_notes.is_empty() && parsed.deletes.is_empty() {
        return Err("At least one note change is required".into());
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_free_text_notes(&parsed.free_text_notes)?;
    validate_annotation_deletes(&parsed.deletes)?;
    validate_mutation_collection_budget(&[
        parsed.updates.len(),
        parsed.free_text_notes.len(),
        parsed.deletes.len(),
    ])?;
    validate_note_changes_text_budget(&parsed)?;
    Ok(parsed)
}

pub(crate) fn validate_page_labels_mutation(page_labels: &PageLabelsMutation) -> Result<()> {
    if page_labels.total_pages == 0 {
        return Err("Invalid page-label page count".into());
    }
    for range in &page_labels.ranges {
        if range.start_page == 0 || range.start_number == 0 {
            return Err("Invalid page-label range".into());
        }
        if let Some(style) = range.style.as_deref() {
            if !matches!(style, "D" | "R" | "r" | "A" | "a") {
                return Err("Invalid page-label style".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn count_bookmark_items(items: &[BookmarkEntry]) -> usize {
    items
        .iter()
        .map(|item| 1 + count_bookmark_items(&item.items))
        .sum()
}

pub(crate) fn validate_bookmark_items(items: &[BookmarkEntry], depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Bookmark tree is too deeply nested",
        ));
    }
    for item in items {
        if item.title.len() > 4_096 {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Bookmark title exceeds the 4096-byte admission ceiling",
            ));
        }
        if let Some(color) = item.color.as_deref() {
            if parse_pdf_color(Some(color)).is_none() {
                return Err("Invalid bookmark color".into());
            }
        }
        validate_bookmark_items(&item.items, depth + 1)?;
    }
    Ok(())
}

pub(crate) fn validate_bookmarks_mutation(bookmarks: &BookmarksMutation) -> Result<()> {
    if bookmarks.total_pages == 0 {
        return Err("Invalid bookmark page count".into());
    }
    if count_bookmark_items(&bookmarks.items) > 5_000 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many bookmark items",
        ));
    }
    validate_bookmark_items(&bookmarks.items, 0)
}

pub(crate) fn is_unit_number(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

pub(crate) fn validate_shape_point(point: &ShapePoint) -> Result<()> {
    if !is_unit_number(point.x) || !is_unit_number(point.y) {
        return Err("Invalid shape point".into());
    }
    Ok(())
}

pub(crate) fn validate_shape_points(points: &[ShapePoint], min_len: usize) -> Result<()> {
    if points.len() < min_len {
        return Err("Shape has too few points".into());
    }
    for point in points {
        validate_shape_point(point)?;
    }
    Ok(())
}

pub(crate) fn validate_shape_geometry(shape: &ShapeAnnotation) -> Result<()> {
    if !matches!(
        shape.shape_type.as_str(),
        "rectangle" | "circle" | "line" | "arrow" | "polyline" | "polygon"
    ) {
        return Err("Invalid shape type".into());
    }
    if !is_unit_number(shape.x)
        || !is_unit_number(shape.y)
        || !shape.width.is_finite()
        || shape.width < 0.0
        || !shape.height.is_finite()
        || shape.height < 0.0
        || !shape.stroke_width.is_finite()
        || shape.stroke_width < 0.0
        || !is_unit_number(shape.opacity)
    {
        return Err("Invalid shape style or bounds".into());
    }
    if shape.color.trim().is_empty()
        || shape.color.eq_ignore_ascii_case("transparent")
        || shape.color.eq_ignore_ascii_case("none")
        || parse_pdf_color(Some(&shape.color)).is_none()
    {
        return Err("Invalid shape color".into());
    }
    if let Some(fill_color) = shape.fill_color.as_deref() {
        if !fill_color.trim().is_empty()
            && !fill_color.eq_ignore_ascii_case("transparent")
            && !fill_color.eq_ignore_ascii_case("none")
            && parse_pdf_color(Some(fill_color)).is_none()
        {
            return Err("Invalid shape fill color".into());
        }
    }
    if let Some(pdf_subtype) = shape.pdf_subtype.as_deref() {
        if !matches!(
            pdf_subtype,
            "Square" | "Circle" | "Line" | "PolyLine" | "Polygon" | "Ink"
        ) {
            return Err("Invalid shape PDF subtype".into());
        }
    }
    for line_end_style in [
        shape.line_start_style.as_deref(),
        shape.line_end_style.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !matches!(line_end_style, "none" | "openArrow" | "closedArrow") {
            return Err("Invalid shape line ending style".into());
        }
    }

    match shape.shape_type.as_str() {
        "rectangle" | "circle" => {
            if shape.width <= 0.0
                || shape.height <= 0.0
                || shape.x + shape.width > 1.0
                || shape.y + shape.height > 1.0
            {
                return Err("Invalid rectangular shape geometry".into());
            }
        }
        "line" | "arrow" => {
            if !shape.x2.is_some_and(is_unit_number) || !shape.y2.is_some_and(is_unit_number) {
                return Err("Invalid line shape geometry".into());
            }
        }
        "polyline" if shape.pdf_subtype.as_deref() == Some("Ink") => {
            if shape.strokes.is_empty() {
                validate_shape_points(&shape.points, 2)?;
            } else {
                for stroke in &shape.strokes {
                    validate_shape_points(stroke, 2)?;
                }
            }
        }
        "polyline" | "polygon" => validate_shape_points(&shape.points, 2)?,
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_shapes_mutation(shapes: &ShapesMutation) -> Result<()> {
    if shapes.total_pages == 0 {
        return Err("Invalid shape page count".into());
    }
    if shapes.shapes.len() > 4_096
        || shapes.deleted_annotation_ids.len() > 4_096
        || shapes.deleted_stable_keys.len() > 4_096
    {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many shape mutations",
        ));
    }
    let mut point_count = 0usize;
    for shape in &shapes.shapes {
        if shape.page_index >= shapes.total_pages {
            return Err("Shape page index is outside the mutation page count".into());
        }
        point_count += shape.points.len();
        point_count += shape.strokes.iter().map(Vec::len).sum::<usize>();
        if point_count > 20_000 {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Too many shape points",
            ));
        }
        validate_shape_geometry(shape)?;
    }
    Ok(())
}

pub(crate) fn is_supported_markup_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
    )
}

pub(crate) fn validate_markup_mutation(markup: &MarkupMutation) -> Result<()> {
    if markup.overrides.len() > 4_096 || markup.hints.len() > MAX_MARKUP_SUBTYPE_HINTS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many text-markup mutations",
        ));
    }
    if markup.overrides.is_empty() && markup.hints.is_empty() {
        return Err("Text-markup mutation must include at least one rewrite".into());
    }
    for (annotation_id, subtype) in &markup.overrides {
        if annotation_id.trim().is_empty() || annotation_id.len() > 2_048 {
            return Err("Invalid text-markup override annotation id".into());
        }
        if !is_supported_markup_subtype(subtype) {
            return Err("Invalid text-markup override subtype".into());
        }
    }
    for hint in &markup.hints {
        if !is_supported_markup_subtype(&hint.subtype) {
            return Err("Invalid text-markup hint subtype".into());
        }
        validate_marker_rect(hint.marker_rect)?;
        for value in [
            hint.annotation_id.as_deref(),
            hint.color.as_deref(),
            hint.id.as_deref(),
            hint.source.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 2_048 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Text-markup hint string is too long",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_placed_images(images: &[PlacedImage]) -> Result<()> {
    if images.len() > 16 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many placed image mutations",
        ));
    }
    for image in images {
        if !image.mime_type.eq_ignore_ascii_case("image/jpeg") {
            return Err("Native placed images only support JPEG payloads".into());
        }
        validate_marker_rect(MarkerRect {
            left: image.x,
            top: image.y,
            width: image.width,
            height: image.height,
        })?;
        if image
            .rotation_degrees
            .is_some_and(|rotation| !rotation.is_finite())
        {
            return Err("Invalid placed image rotation".into());
        }
    }
    let payloads = validate_placed_image_payloads(images)?;
    for (image, bytes) in images.iter().zip(payloads) {
        *image.validated_bytes.borrow_mut() = Some(bytes);
    }
    Ok(())
}

pub(crate) fn read_native_mutations(path: &Path) -> Result<NativeMutationsFile> {
    let parsed: NativeMutationsFile = read_json_sidecar(path, "native PDF mutations")?;
    if parsed.updates.is_empty()
        && parsed.free_text_notes.is_empty()
        && parsed.deletes.is_empty()
        && parsed.page_labels.is_none()
        && parsed.bookmarks.is_none()
        && parsed.shapes.is_none()
        && parsed.markup.is_none()
        && parsed.placed_images.is_empty()
    {
        return Err("At least one native PDF mutation is required".into());
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_free_text_notes(&parsed.free_text_notes)?;
    validate_annotation_deletes(&parsed.deletes)?;
    if let Some(page_labels) = &parsed.page_labels {
        validate_page_labels_mutation(page_labels)?;
    }
    if let Some(bookmarks) = &parsed.bookmarks {
        validate_bookmarks_mutation(bookmarks)?;
    }
    if let Some(shapes) = &parsed.shapes {
        validate_shapes_mutation(shapes)?;
    }
    if let Some(markup) = &parsed.markup {
        validate_markup_mutation(markup)?;
    }
    validate_placed_images(&parsed.placed_images)?;
    validate_mutation_collection_budget(&[
        parsed.updates.len(),
        parsed.free_text_notes.len(),
        parsed.deletes.len(),
        parsed.placed_images.len(),
    ])?;
    validate_native_mutation_text_budget(&parsed)?;
    Ok(parsed)
}

fn validate_mutation_collection_budget(lengths: &[usize]) -> Result<()> {
    let total = lengths
        .iter()
        .try_fold(0usize, |total, length| total.checked_add(*length))
        .unwrap_or(usize::MAX);
    if total > MAX_COLLECTION_ITEMS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "Mutation collections exceed the {MAX_COLLECTION_ITEMS}-item admission ceiling"
            ),
        ));
    }
    Ok(())
}

fn consume_text_bytes(total: &mut usize, value: &str) -> Result<()> {
    *total = total.checked_add(value.len()).unwrap_or(usize::MAX);
    if *total > MAX_AGGREGATE_TEXT_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Mutation text exceeds the {MAX_AGGREGATE_TEXT_BYTES}-byte admission ceiling"),
        ));
    }
    Ok(())
}

fn validate_note_text_budget(updates: &[NoteTextUpdate]) -> Result<()> {
    let mut total = 0usize;
    for update in updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    Ok(())
}

fn validate_note_changes_text_budget(changes: &NoteChangesFile) -> Result<()> {
    let mut total = 0usize;
    for update in &changes.updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    for note in &changes.free_text_notes {
        consume_text_bytes(&mut total, &note.stable_key)?;
        consume_text_bytes(&mut total, &note.text)?;
        for value in [note.author.as_deref(), note.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    for delete in &changes.deletes {
        if let Some(stable_key) = delete.stable_key.as_deref() {
            consume_text_bytes(&mut total, stable_key)?;
        }
    }
    Ok(())
}

fn consume_bookmark_text(total: &mut usize, items: &[BookmarkEntry]) -> Result<()> {
    for item in items {
        consume_text_bytes(total, &item.title)?;
        for value in [item.named_dest.as_deref(), item.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(total, value)?;
        }
        consume_bookmark_text(total, &item.items)?;
    }
    Ok(())
}

fn validate_native_mutation_text_budget(mutations: &NativeMutationsFile) -> Result<()> {
    let mut total = 0usize;
    for update in &mutations.updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    for note in &mutations.free_text_notes {
        consume_text_bytes(&mut total, &note.stable_key)?;
        consume_text_bytes(&mut total, &note.text)?;
        for value in [note.author.as_deref(), note.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    for delete in &mutations.deletes {
        if let Some(stable_key) = delete.stable_key.as_deref() {
            consume_text_bytes(&mut total, stable_key)?;
        }
    }
    if let Some(labels) = &mutations.page_labels {
        for range in &labels.ranges {
            consume_text_bytes(&mut total, &range.prefix)?;
            if let Some(style) = range.style.as_deref() {
                consume_text_bytes(&mut total, style)?;
            }
        }
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        consume_text_bytes(&mut total, &bookmarks.untitled_label)?;
        consume_bookmark_text(&mut total, &bookmarks.items)?;
    }
    if let Some(shapes) = &mutations.shapes {
        for shape in &shapes.shapes {
            for value in [
                Some(shape.shape_type.as_str()),
                Some(shape.color.as_str()),
                shape.fill_color.as_deref(),
                shape.annotation_id.as_deref(),
                shape.stable_key.as_deref(),
                shape.pdf_subtype.as_deref(),
                shape.line_start_style.as_deref(),
                shape.line_end_style.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                consume_text_bytes(&mut total, value)?;
            }
        }
        for value in shapes
            .deleted_annotation_ids
            .iter()
            .chain(&shapes.deleted_stable_keys)
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    if let Some(markup) = &mutations.markup {
        for (annotation_id, subtype) in &markup.overrides {
            consume_text_bytes(&mut total, annotation_id)?;
            consume_text_bytes(&mut total, subtype)?;
        }
        for hint in &markup.hints {
            consume_text_bytes(&mut total, &hint.subtype)?;
            for value in [
                hint.annotation_id.as_deref(),
                hint.color.as_deref(),
                hint.id.as_deref(),
                hint.source.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                consume_text_bytes(&mut total, value)?;
            }
        }
    }
    for image in &mutations.placed_images {
        consume_text_bytes(&mut total, &image.mime_type)?;
        consume_text_bytes(&mut total, &image.bytes_path.to_string_lossy())?;
        consume_text_bytes(&mut total, &image.sha256)?;
    }
    Ok(())
}

#[cfg(test)]
mod bounded_input_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-page-ops-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn page_selection_admission_reports_typed_byte_and_item_limits() {
        let path = temp_path("page-selection-limit");
        fs::write(&path, b"1\n2\n").unwrap();

        for error in [
            read_pages_file_with_limits(&path, 3, 10).unwrap_err(),
            read_pages_file_with_limits(&path, 16, 1).unwrap_err(),
        ] {
            let native = error.downcast_ref::<NativeError>().unwrap();
            assert_eq!(native.code, NativeErrorCode::TooLarge);
        }
        fs::remove_file(path).unwrap();
    }
}
