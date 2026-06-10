fn parse_margin(value: &str, label: &str) -> Result<f64> {
    let parsed = value.parse::<f64>()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("Invalid {label} margin").into());
    }
    Ok(parsed)
}

fn read_pages_file(path: &PathBuf) -> Result<Vec<u32>> {
    let contents = fs::read_to_string(path)?;
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
        pages.push(page);
    }
    if pages.is_empty() {
        return Err("At least one page must be selected".into());
    }
    Ok(pages)
}

fn read_note_text_updates(path: &PathBuf) -> Result<Vec<NoteTextUpdate>> {
    let contents = fs::read_to_string(path)?;
    let parsed: NoteTextUpdatesFile = serde_json::from_str(&contents)?;
    if parsed.updates.is_empty() {
        return Err("At least one note text update is required".into());
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    Ok(parsed.updates)
}

fn validate_free_text_notes(notes: &[FreeTextNote]) -> Result<()> {
    for note in notes {
        if note.stable_key.trim().is_empty() {
            return Err("Invalid FreeText note stable key".into());
        }
        validate_marker_rect(note.marker_rect)?;
    }
    Ok(())
}

fn validate_annotation_deletes(deletes: &[AnnotationDelete]) -> Result<()> {
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
        if (has_ref && !has_valid_ref) || (!has_valid_ref && !has_stable_key) {
            return Err("Annotation delete must include a valid object ref or stable key".into());
        }
    }
    Ok(())
}

fn validate_marker_rect(rect: MarkerRect) -> Result<()> {
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

fn read_note_changes(path: &PathBuf) -> Result<NoteChangesFile> {
    let contents = fs::read_to_string(path)?;
    let parsed: NoteChangesFile = serde_json::from_str(&contents)?;
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
    Ok(parsed)
}

fn validate_page_labels_mutation(page_labels: &PageLabelsMutation) -> Result<()> {
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

fn count_bookmark_items(items: &[BookmarkEntry]) -> usize {
    items
        .iter()
        .map(|item| 1 + count_bookmark_items(&item.items))
        .sum()
}

fn validate_bookmark_items(items: &[BookmarkEntry], depth: usize) -> Result<()> {
    if depth > 64 {
        return Err("Bookmark tree is too deeply nested".into());
    }
    for item in items {
        if let Some(color) = item.color.as_deref() {
            if parse_pdf_color(Some(color)).is_none() {
                return Err("Invalid bookmark color".into());
            }
        }
        validate_bookmark_items(&item.items, depth + 1)?;
    }
    Ok(())
}

fn validate_bookmarks_mutation(bookmarks: &BookmarksMutation) -> Result<()> {
    if bookmarks.total_pages == 0 {
        return Err("Invalid bookmark page count".into());
    }
    if count_bookmark_items(&bookmarks.items) > 5_000 {
        return Err("Too many bookmark items".into());
    }
    validate_bookmark_items(&bookmarks.items, 0)
}

fn is_unit_number(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn validate_shape_point(point: &ShapePoint) -> Result<()> {
    if !is_unit_number(point.x) || !is_unit_number(point.y) {
        return Err("Invalid shape point".into());
    }
    Ok(())
}

fn validate_shape_points(points: &[ShapePoint], min_len: usize) -> Result<()> {
    if points.len() < min_len {
        return Err("Shape has too few points".into());
    }
    for point in points {
        validate_shape_point(point)?;
    }
    Ok(())
}

fn validate_shape_geometry(shape: &ShapeAnnotation) -> Result<()> {
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

fn validate_shapes_mutation(shapes: &ShapesMutation) -> Result<()> {
    if shapes.total_pages == 0 {
        return Err("Invalid shape page count".into());
    }
    if shapes.shapes.len() > 4_096
        || shapes.deleted_annotation_ids.len() > 4_096
        || shapes.deleted_stable_keys.len() > 4_096
    {
        return Err("Too many shape mutations".into());
    }
    let mut point_count = 0usize;
    for shape in &shapes.shapes {
        if shape.page_index >= shapes.total_pages {
            return Err("Shape page index is outside the mutation page count".into());
        }
        point_count += shape.points.len();
        point_count += shape.strokes.iter().map(Vec::len).sum::<usize>();
        if point_count > 20_000 {
            return Err("Too many shape points".into());
        }
        validate_shape_geometry(shape)?;
    }
    Ok(())
}

fn is_supported_markup_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
    )
}

fn validate_markup_mutation(markup: &MarkupMutation) -> Result<()> {
    if markup.overrides.len() > 4_096 || markup.hints.len() > 4_096 {
        return Err("Too many text-markup mutations".into());
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
                return Err("Text-markup hint string is too long".into());
            }
        }
    }
    Ok(())
}

fn read_native_mutations(path: &PathBuf) -> Result<NativeMutationsFile> {
    let contents = fs::read_to_string(path)?;
    let parsed: NativeMutationsFile = serde_json::from_str(&contents)?;
    if parsed.updates.is_empty()
        && parsed.free_text_notes.is_empty()
        && parsed.deletes.is_empty()
        && parsed.page_labels.is_none()
        && parsed.bookmarks.is_none()
        && parsed.shapes.is_none()
        && parsed.markup.is_none()
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
    Ok(parsed)
}
