use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy)]
struct CropMargins {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

#[derive(Clone, Copy)]
struct PdfRect {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
}

impl PdfRect {
    fn width(self) -> f64 {
        self.x2 - self.x1
    }

    fn height(self) -> f64 {
        self.y2 - self.y1
    }
}

enum Operation {
    Crop {
        pages_file: PathBuf,
        margins: CropMargins,
    },
    RemoveCrop {
        pages_file: PathBuf,
    },
    UpdateNoteText {
        updates_file: PathBuf,
        modified_at: String,
        append: bool,
    },
    SaveNoteChanges {
        changes_file: PathBuf,
        modified_at: String,
        append: bool,
    },
    SaveMutations {
        mutations_file: PathBuf,
        modified_at: String,
        append: bool,
    },
}

struct Config {
    operation: Operation,
    input_path: PathBuf,
    output_path: PathBuf,
}

#[derive(Deserialize)]
struct NoteTextUpdatesFile {
    updates: Vec<NoteTextUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteChangesFile {
    #[serde(default)]
    updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    deletes: Vec<AnnotationDelete>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMutationsFile {
    #[serde(default)]
    updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    deletes: Vec<AnnotationDelete>,
    page_labels: Option<PageLabelsMutation>,
    bookmarks: Option<BookmarksMutation>,
    shapes: Option<ShapesMutation>,
    markup: Option<MarkupMutation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteTextUpdate {
    object_number: u32,
    generation_number: u16,
    text: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkerRect {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreeTextNote {
    page_index: u32,
    stable_key: String,
    text: String,
    marker_rect: MarkerRect,
    author: Option<String>,
    color: Option<String>,
    created_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageLabelsMutation {
    total_pages: u32,
    #[serde(default)]
    ranges: Vec<PageLabelRange>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageLabelRange {
    start_page: u32,
    style: Option<String>,
    prefix: String,
    start_number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarksMutation {
    total_pages: u32,
    untitled_label: String,
    #[serde(default)]
    items: Vec<BookmarkEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkEntry {
    title: String,
    page_index: Option<u32>,
    named_dest: Option<String>,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    italic: bool,
    color: Option<String>,
    #[serde(default)]
    items: Vec<BookmarkEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapesMutation {
    total_pages: u32,
    #[serde(default)]
    rewrite_shape_state: bool,
    #[serde(default)]
    shapes: Vec<ShapeAnnotation>,
    #[serde(default)]
    deleted_annotation_ids: Vec<String>,
    #[serde(default)]
    deleted_stable_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkupMutation {
    #[serde(default)]
    overrides: Vec<(String, String)>,
    #[serde(default)]
    hints: Vec<MarkupSubtypeHint>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkupSubtypeHint {
    subtype: String,
    page_index: u32,
    marker_rect: MarkerRect,
    #[serde(default)]
    annotation_id: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    page_markup_index: Option<u32>,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapePoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeAnnotation {
    #[serde(rename = "type")]
    shape_type: String,
    page_index: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    x2: Option<f64>,
    #[serde(default)]
    y2: Option<f64>,
    color: String,
    #[serde(default)]
    fill_color: Option<String>,
    opacity: f64,
    stroke_width: f64,
    #[serde(default)]
    points: Vec<ShapePoint>,
    #[serde(default)]
    strokes: Vec<Vec<ShapePoint>>,
    #[serde(default)]
    annotation_id: Option<String>,
    #[serde(default)]
    stable_key: Option<String>,
    #[serde(default)]
    pdf_subtype: Option<String>,
    #[serde(default)]
    line_start_style: Option<String>,
    #[serde(default)]
    line_end_style: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    modified_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationDelete {
    page_index: u32,
    object_number: Option<u32>,
    generation_number: Option<u16>,
    stable_key: Option<String>,
    created_at: Option<u64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if env::args().skip(1).any(|arg| arg == "--version") {
        println!("evb-pdf-page-ops {VERSION}");
        return Ok(());
    }

    mutate_pdf(parse_args()?)
}

fn parse_args() -> Result<Config> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut updates_file = None;
    let mut changes_file = None;
    let mut mutations_file = None;
    let mut modified_at = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;
    let mut append = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => {
                input_path = Some(PathBuf::from(args.next().ok_or("Missing --input value")?))
            }
            "--output" => {
                output_path = Some(PathBuf::from(args.next().ok_or("Missing --output value")?))
            }
            "--pages-file" => {
                pages_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --pages-file value")?,
                ))
            }
            "--updates-file" => {
                updates_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --updates-file value")?,
                ))
            }
            "--changes-file" => {
                changes_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --changes-file value")?,
                ))
            }
            "--mutations-file" => {
                mutations_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --mutations-file value")?,
                ))
            }
            "--modified-at" => {
                modified_at = Some(args.next().ok_or("Missing --modified-at value")?)
            }
            "--top" => {
                top = Some(parse_margin(
                    &args.next().ok_or("Missing --top value")?,
                    "top",
                )?)
            }
            "--bottom" => {
                bottom = Some(parse_margin(
                    &args.next().ok_or("Missing --bottom value")?,
                    "bottom",
                )?)
            }
            "--left" => {
                left = Some(parse_margin(
                    &args.next().ok_or("Missing --left value")?,
                    "left",
                )?)
            }
            "--right" => {
                right = Some(parse_margin(
                    &args.next().ok_or("Missing --right value")?,
                    "right",
                )?)
            }
            "--append" => {
                append = true;
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    let operation = match command.as_str() {
        "crop" => Operation::Crop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
            margins: CropMargins {
                top: top.ok_or("Missing --top value")?,
                bottom: bottom.ok_or("Missing --bottom value")?,
                left: left.ok_or("Missing --left value")?,
                right: right.ok_or("Missing --right value")?,
            },
        },
        "remove-crop" => Operation::RemoveCrop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
        },
        "update-note-text" => Operation::UpdateNoteText {
            updates_file: updates_file.ok_or("Missing --updates-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
        },
        "save-note-changes" => Operation::SaveNoteChanges {
            changes_file: changes_file.ok_or("Missing --changes-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
        },
        "save-mutations" => Operation::SaveMutations {
            mutations_file: mutations_file.ok_or("Missing --mutations-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
        },
        _ => return Err(format!("Unknown command: {command}").into()),
    };

    Ok(Config {
        operation,
        input_path: input_path.ok_or("Missing --input value")?,
        output_path: output_path.ok_or("Missing --output value")?,
    })
}

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
        if !matches!(pdf_subtype, "Square" | "Circle" | "Line" | "PolyLine" | "Polygon" | "Ink")
        {
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
    matches!(subtype, "Highlight" | "Underline" | "StrikeOut" | "Squiggly")
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

fn mutate_pdf(config: Config) -> Result<()> {
    if let Operation::UpdateNoteText {
        updates_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let updates = read_note_text_updates(updates_file)?;
        append_note_text_update(
            &config.input_path,
            &config.output_path,
            &updates,
            modified_at,
        )?;
        return Ok(());
    }
    if let Operation::SaveNoteChanges {
        changes_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let changes = read_note_changes(changes_file)?;
        append_note_changes(
            &config.input_path,
            &config.output_path,
            &changes,
            modified_at,
        )?;
        return Ok(());
    }
    if let Operation::SaveMutations {
        mutations_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let mutations = read_native_mutations(mutations_file)?;
        append_native_mutations(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
        )?;
        return Ok(());
    }

    let mut document = Document::load(&config.input_path)?;
    if document.is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
    }

    match config.operation {
        Operation::Crop {
            pages_file,
            margins,
        } => {
            let pages = read_pages_file(&pages_file)?;
            crop_pages(&mut document, &pages, margins)?;
        }
        Operation::RemoveCrop { pages_file } => {
            let pages = read_pages_file(&pages_file)?;
            remove_crop_from_pages(&mut document, &pages)?;
        }
        Operation::UpdateNoteText {
            updates_file,
            modified_at,
            append: _,
        } => {
            let updates = read_note_text_updates(&updates_file)?;
            update_note_text(&mut document, &updates, &modified_at)?;
        }
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: _,
        } => {
            let changes = read_note_changes(&changes_file)?;
            update_note_text(&mut document, &changes.updates, &modified_at)?;
            upsert_free_text_notes(&mut document, &changes.free_text_notes, &modified_at)?;
            delete_annotations(&mut document, &changes.deletes)?;
        }
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: _,
        } => {
            let mutations = read_native_mutations(&mutations_file)?;
            apply_native_mutations(&mut document, &mutations, &modified_at)?;
        }
    }

    document.save(&config.output_path)?;
    Ok(())
}

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
        upsert_free_text_notes_incremental(
            incremental,
            &mutations.free_text_notes,
            modified_at,
        )?;
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

fn update_note_text(
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

fn upsert_free_text_notes(
    document: &mut Document,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_map = document.get_pages();
    let mut blank_ap_ref: Option<ObjectId> = None;
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let pdf_rect = marker_rect_to_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let annots = get_page_annots(document, page_id)?;
        let existing = find_existing_free_text_note(document, &annots, &note_name)?;

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
                if !annots
                    .iter()
                    .any(|object| object.as_reference().ok() == Some(popup_id))
                {
                    append_annots_to_page(document, page_id, &[popup_id])?;
                }
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
        append_annots_to_page(document, page_id, &[annot_ref, popup_ref])?;
    }
    Ok(())
}

fn upsert_free_text_notes_incremental(
    incremental: &mut IncrementalDocument,
    notes: &[FreeTextNote],
    modified_at: &str,
) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }

    let page_map = incremental.get_prev_documents().get_pages();
    let mut blank_ap_ref: Option<ObjectId> = None;
    for note in notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText note page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let pdf_rect = marker_rect_to_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let annots = get_page_annots(incremental.get_prev_documents(), page_id)?;
        let existing =
            find_existing_free_text_note(incremental.get_prev_documents(), &annots, &note_name)?;

        if let Some(annot_id) = existing {
            let popup_ref = {
                let annot_dict = incremental.get_prev_documents().get_dictionary(annot_id)?;
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
                if !annots
                    .iter()
                    .any(|object| object.as_reference().ok() == Some(popup_id))
                {
                    append_annots_to_page_incremental(incremental, page_id, &[popup_id])?;
                }
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
        append_annots_to_page_incremental(incremental, page_id, &[annot_ref, popup_ref])?;
    }
    Ok(())
}

fn ensure_free_text_annotation_fields(
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

fn ensure_free_text_incremental_annotation_fields(
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

fn build_free_text_annotation_dict(
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

fn set_free_text_annotation_fields(
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

fn build_popup_annotation_dict(
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

fn set_popup_annotation_fields(
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

fn get_or_create_blank_appearance_ref(
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

fn replayable_free_text_note_name_from_parts(stable_key: &str, created_at: Option<u64>) -> String {
    match created_at {
        Some(created_at) if created_at > 0 => {
            format!("evb-note:{}:created:{created_at}", stable_key.trim())
        }
        _ => format!("evb-note:{}", stable_key.trim()),
    }
}

fn replayable_free_text_note_name(note: &FreeTextNote) -> String {
    replayable_free_text_note_name_from_parts(&note.stable_key, note.created_at)
}

fn find_existing_free_text_note(
    document: &Document,
    annots: &[Object],
    note_name: &str,
) -> Result<Option<ObjectId>> {
    for object in annots {
        let annot_id = match object.as_reference() {
            Ok(id) => id,
            Err(_) => continue,
        };
        let dict = match document.get_dictionary(annot_id) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if annotation_subtype(dict) != "freetext" {
            continue;
        }
        let name_matches =
            dict.get(b"NM").ok().and_then(pdf_string_to_text).as_deref() == Some(note_name);
        if name_matches {
            return Ok(Some(annot_id));
        }
    }
    Ok(None)
}

fn get_page_annots(document: &Document, page_id: ObjectId) -> Result<Vec<Object>> {
    let page = document.get_dictionary(page_id)?;
    let annots = match page.get(b"Annots") {
        Ok(object) => object,
        Err(_) => return Ok(Vec::new()),
    };
    let (_, resolved) = document.dereference(annots)?;
    Ok(resolved.as_array().cloned().unwrap_or_default())
}

fn append_annots_to_page(
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

fn append_annots_to_page_incremental(
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

fn collect_annotation_refs_to_delete(
    document: &Document,
    target_id: ObjectId,
) -> Result<Vec<ObjectId>> {
    if document.get_dictionary(target_id).is_err() {
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

        let dict = match document.get_dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if let Some(popup_id) = annotation_related_ref(dict, b"Popup") {
            pending.push(popup_id);
        }
        if let Some(parent_id) = annotation_related_ref(dict, b"Parent") {
            if let Ok(parent_dict) = document.get_dictionary(parent_id) {
                let parent_subtype = annotation_subtype(parent_dict);
                if parent_subtype == "freetext" || parent_subtype == "popup" {
                    pending.push(parent_id);
                }
            }
        }
    }

    Ok(refs)
}

fn annotation_matches_stable_delete_name(
    document: &Document,
    object_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<bool> {
    let stable_key = match delete.stable_key.as_deref().map(str::trim) {
        Some(stable_key) if !stable_key.is_empty() => stable_key,
        _ => return Ok(false),
    };
    let dict = match document.get_dictionary(object_id) {
        Ok(dict) => dict,
        Err(_) => return Ok(false),
    };
    let target_dict = if annotation_subtype(dict) == "popup" {
        match annotation_related_ref(dict, b"Parent") {
            Some(parent_id) => match document.get_dictionary(parent_id) {
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

fn resolve_annotation_delete_target_refs(
    document: &Document,
    page_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<Vec<ObjectId>> {
    if let (Some(object_number), Some(generation_number)) =
        (delete.object_number, delete.generation_number)
    {
        return Ok(vec![(object_number, generation_number)]);
    }

    let annots = get_page_annots(document, page_id)?;
    let matching_refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter_map(|object_id| {
            let is_free_text = document
                .get_dictionary(object_id)
                .map(|dict| annotation_subtype(dict) == "freetext")
                .unwrap_or(false);
            if !is_free_text {
                return None;
            }
            match annotation_matches_stable_delete_name(document, object_id, delete) {
                Ok(true) => Some(Ok(object_id)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect::<Result<Vec<_>>>()?;

    match matching_refs.len() {
        1 => Ok(matching_refs),
        0 => Err("No annotation matched requested stable-key delete target".into()),
        _ => Err("Stable-key delete target matched multiple annotations".into()),
    }
}

fn collect_delete_refs(
    document: &Document,
    deletes: &[AnnotationDelete],
) -> Result<HashSet<ObjectId>> {
    let page_map = document.get_pages();
    let mut refs_to_delete = HashSet::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        for target_id in resolve_annotation_delete_target_refs(document, page_id, delete)? {
            for object_id in collect_annotation_refs_to_delete(document, target_id)? {
                refs_to_delete.insert(object_id);
            }
        }
    }
    Ok(refs_to_delete)
}

fn filter_annots_without_refs(
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

fn delete_annotations(document: &mut Document, deletes: &[AnnotationDelete]) -> Result<()> {
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

fn delete_annotations_incremental(
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

fn update_note_text_incremental(
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

fn update_annotation_text_by_ref(
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

fn update_annotation_text_incremental_by_ref(
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

fn set_annotation_object_contents(
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

fn set_annotation_incremental_object_contents(
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

fn set_annotation_dict_contents(dict: &mut Dictionary, text: &str, modified_at: &str) {
    dict.set(
        "Contents",
        Object::String(encode_pdf_text_string(text), StringFormat::Hexadecimal),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
}

fn pdf_string_to_text(object: &Object) -> Option<String> {
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

fn encode_pdf_text_string(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + (text.len() * 2));
    bytes.push(0xFE);
    bytes.push(0xFF);
    for code_unit in text.encode_utf16() {
        bytes.push((code_unit >> 8) as u8);
        bytes.push((code_unit & 0xFF) as u8);
    }
    bytes
}

fn rect_object(rect: PdfRect) -> Object {
    Object::Array(vec![
        number_object(rect.x1),
        number_object(rect.y1),
        number_object(rect.x2),
        number_object(rect.y2),
    ])
}

fn annotation_related_ref(dict: &Dictionary, key: &[u8]) -> Option<ObjectId> {
    dict.get(key).and_then(Object::as_reference).ok()
}

fn annotation_subtype(dict: &Dictionary) -> String {
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

fn parse_hex_color_component(value: &str) -> Option<f64> {
    u8::from_str_radix(value, 16)
        .ok()
        .map(|component| f64::from(component) / 255.0)
}

fn parse_rgb_number(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.0, 255.0) / 255.0)
}

fn parse_pdf_color(color: Option<&str>) -> Option<[f64; 3]> {
    let trimmed = color?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("transparent")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return None;
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        if hex.len() == 3 {
            let r = &hex[0..1];
            let g = &hex[1..2];
            let b = &hex[2..3];
            return Some([
                parse_hex_color_component(&format!("{r}{r}"))?,
                parse_hex_color_component(&format!("{g}{g}"))?,
                parse_hex_color_component(&format!("{b}{b}"))?,
            ]);
        }
        if hex.len() == 6 {
            return Some([
                parse_hex_color_component(&hex[0..2])?,
                parse_hex_color_component(&hex[2..4])?,
                parse_hex_color_component(&hex[4..6])?,
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

fn set_rgb_color(dict: &mut Dictionary, key: &str, color: Option<&str>) {
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

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

fn normalize_page_label_style(style: Option<&str>) -> Option<String> {
    match style {
        Some("D" | "R" | "r" | "A" | "a") => style.map(ToOwned::to_owned),
        Some(_) => Some("D".to_string()),
        None => None,
    }
}

fn normalize_page_label_ranges(
    ranges: &[PageLabelRange],
    total_pages: u32,
) -> Vec<PageLabelRange> {
    if total_pages == 0 {
        return Vec::new();
    }

    let mut deduped = std::collections::BTreeMap::new();
    for range in ranges {
        let start_page = clamp_u32(range.start_page.max(1), 1, total_pages);
        deduped.insert(
            start_page,
            PageLabelRange {
                start_page,
                style: normalize_page_label_style(range.style.as_deref()),
                prefix: range.prefix.clone(),
                start_number: range.start_number.max(1),
            },
        );
    }
    deduped.entry(1).or_insert_with(|| PageLabelRange {
        start_page: 1,
        style: Some("D".to_string()),
        prefix: String::new(),
        start_number: 1,
    });
    deduped.into_values().collect()
}

fn is_implicit_default_page_labels(ranges: &[PageLabelRange], total_pages: u32) -> bool {
    let normalized = normalize_page_label_ranges(ranges, total_pages);
    normalized.len() == 1
        && normalized[0].start_page == 1
        && normalized[0].style.as_deref() == Some("D")
        && normalized[0].prefix.is_empty()
        && normalized[0].start_number == 1
}

fn catalog_id(document: &Document) -> Result<ObjectId> {
    document.trailer.get(b"Root")?.as_reference().map_err(Into::into)
}

fn assert_mutation_page_count(document: &Document, total_pages: u32, label: &str) -> Result<()> {
    let actual_pages = u32::try_from(document.get_pages().len())?;
    if total_pages != actual_pages {
        return Err(format!(
            "{label} page count {total_pages} does not match document page count {actual_pages}"
        )
        .into());
    }
    Ok(())
}

fn set_page_labels_on_catalog(catalog: &mut Dictionary, page_labels: &PageLabelsMutation) {
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        catalog.remove(b"PageLabels");
        return;
    }

    let normalized = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    let mut nums = Vec::with_capacity(normalized.len() * 2);
    for range in normalized {
        nums.push(Object::Integer(i64::from(range.start_page.saturating_sub(1))));
        let mut label_dict = Dictionary::new();
        label_dict.set("Type", Object::Name(b"PageLabel".to_vec()));
        if let Some(style) = range.style.as_deref() {
            label_dict.set("S", Object::Name(style.as_bytes().to_vec()));
        }
        if !range.prefix.is_empty() {
            label_dict.set(
                "P",
                Object::String(
                    encode_pdf_text_string(&range.prefix),
                    StringFormat::Hexadecimal,
                ),
            );
        }
        if range.style.is_some() && range.start_number > 1 {
            label_dict.set("St", Object::Integer(i64::from(range.start_number)));
        }
        nums.push(Object::Dictionary(label_dict));
    }

    let mut page_labels_dict = Dictionary::new();
    page_labels_dict.set("Nums", Object::Array(nums));
    catalog.set("PageLabels", Object::Dictionary(page_labels_dict));
}

fn set_page_labels(document: &mut Document, page_labels: &PageLabelsMutation) -> Result<()> {
    assert_mutation_page_count(document, page_labels.total_pages, "Page-label mutation")?;
    let catalog_id = catalog_id(document)?;
    let catalog = document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

fn set_page_labels_incremental(
    incremental: &mut IncrementalDocument,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        page_labels.total_pages,
        "Page-label mutation",
    )?;
    let catalog_id = catalog_id(incremental.get_prev_documents())?;
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

fn normalize_bookmark_color(color: Option<&str>) -> Option<String> {
    parse_pdf_color(color).map(|rgb| {
        let to_byte = |value: f64| -> u8 { (value.clamp(0.0, 1.0) * 255.0).round() as u8 };
        format!(
            "#{:02x}{:02x}{:02x}",
            to_byte(rgb[0]),
            to_byte(rgb[1]),
            to_byte(rgb[2])
        )
    })
}

fn normalize_bookmark_entries(
    items: &[BookmarkEntry],
    total_pages: u32,
    untitled_label: &str,
) -> Vec<BookmarkEntry> {
    if total_pages == 0 {
        return Vec::new();
    }
    let max_page_index = total_pages - 1;
    items
        .iter()
        .map(|item| {
            let title = item.title.trim();
            let named_dest = item
                .named_dest
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            BookmarkEntry {
                title: if title.is_empty() {
                    untitled_label.to_string()
                } else {
                    title.to_string()
                },
                page_index: item.page_index.map(|page_index| page_index.min(max_page_index)),
                named_dest,
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

struct OutlineBuildResult {
    first: Option<ObjectId>,
    last: Option<ObjectId>,
    visible_count: i64,
}

struct BookmarkNode<'a> {
    object_id: ObjectId,
    item: &'a BookmarkEntry,
    visible_count: i64,
}

fn set_bookmark_destination(
    base_document: &Document,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    dict: &mut Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(page_index) = item.page_index {
        let page_number = page_index
            .checked_add(1)
            .ok_or("Invalid bookmark page index")?;
        let page_id = resolve_page_id(page_map, page_number)?;
        let page_view = resolve_page_view(base_document, page_id)?;
        dict.set(
            "Dest",
            Object::Array(vec![
                Object::Reference(page_id),
                Object::Name(b"XYZ".to_vec()),
                Object::Null,
                number_object(page_view.y2),
                Object::Null,
            ]),
        );
        return Ok(());
    }

    if let Some(named_dest) = item.named_dest.as_deref() {
        dict.set(
            "Dest",
            Object::String(named_dest.as_bytes().to_vec(), StringFormat::Literal),
        );
    }
    Ok(())
}

fn set_bookmark_style(dict: &mut Dictionary, item: &BookmarkEntry) {
    let flags = (if item.italic { 1 } else { 0 }) | (if item.bold { 2 } else { 0 });
    if flags > 0 {
        dict.set("F", Object::Integer(flags));
    }
    if let Some(rgb) = parse_pdf_color(item.color.as_deref()) {
        dict.set(
            "C",
            Object::Array(vec![
                number_object(rgb[0]),
                number_object(rgb[1]),
                number_object(rgb[2]),
            ]),
        );
    }
}

fn build_bookmark_dict(
    base_document: &Document,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    item: &BookmarkEntry,
) -> Result<Dictionary> {
    let mut dict = Dictionary::new();
    dict.set(
        "Title",
        Object::String(encode_pdf_text_string(&item.title), StringFormat::Hexadecimal),
    );
    set_bookmark_destination(base_document, page_map, &mut dict, item)?;
    set_bookmark_style(&mut dict, item);
    Ok(dict)
}

fn build_outline_level(
    document: &mut Document,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    items: &[BookmarkEntry],
    parent_ref: ObjectId,
) -> Result<OutlineBuildResult> {
    if items.is_empty() {
        return Ok(OutlineBuildResult {
            first: None,
            last: None,
            visible_count: 0,
        });
    }

    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        let dict = build_bookmark_dict(document, page_map, item)?;
        let object_id = document.new_object_id();
        document.set_object(object_id, Object::Dictionary(dict));
        nodes.push(BookmarkNode {
            object_id,
            item,
            visible_count: 1,
        });
    }

    for index in 0..nodes.len() {
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| nodes.get(previous_index))
            .map(|node| node.object_id);
        let next = nodes.get(index + 1).map(|node| node.object_id);
        let dict = document.get_dictionary_mut(nodes[index].object_id)?;
        dict.set("Parent", Object::Reference(parent_ref));
        if let Some(previous) = previous {
            dict.set("Prev", Object::Reference(previous));
        }
        if let Some(next) = next {
            dict.set("Next", Object::Reference(next));
        }
    }

    for node in &mut nodes {
        let child_result = build_outline_level(document, page_map, &node.item.items, node.object_id)?;
        if let (Some(first), Some(last)) = (child_result.first, child_result.last) {
            let dict = document.get_dictionary_mut(node.object_id)?;
            dict.set("First", Object::Reference(first));
            dict.set("Last", Object::Reference(last));
            if child_result.visible_count > 0 {
                dict.set("Count", Object::Integer(child_result.visible_count));
            }
            node.visible_count += child_result.visible_count;
        }
    }

    Ok(OutlineBuildResult {
        first: nodes.first().map(|node| node.object_id),
        last: nodes.last().map(|node| node.object_id),
        visible_count: nodes.iter().map(|node| node.visible_count).sum(),
    })
}

fn build_outline_level_incremental(
    incremental: &mut IncrementalDocument,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    items: &[BookmarkEntry],
    parent_ref: ObjectId,
) -> Result<OutlineBuildResult> {
    if items.is_empty() {
        return Ok(OutlineBuildResult {
            first: None,
            last: None,
            visible_count: 0,
        });
    }

    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        let dict = build_bookmark_dict(incremental.get_prev_documents(), page_map, item)?;
        let object_id = incremental.new_document.new_object_id();
        incremental
            .new_document
            .set_object(object_id, Object::Dictionary(dict));
        nodes.push(BookmarkNode {
            object_id,
            item,
            visible_count: 1,
        });
    }

    for index in 0..nodes.len() {
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| nodes.get(previous_index))
            .map(|node| node.object_id);
        let next = nodes.get(index + 1).map(|node| node.object_id);
        let dict = incremental
            .new_document
            .get_dictionary_mut(nodes[index].object_id)?;
        dict.set("Parent", Object::Reference(parent_ref));
        if let Some(previous) = previous {
            dict.set("Prev", Object::Reference(previous));
        }
        if let Some(next) = next {
            dict.set("Next", Object::Reference(next));
        }
    }

    for node in &mut nodes {
        let child_result = build_outline_level_incremental(
            incremental,
            page_map,
            &node.item.items,
            node.object_id,
        )?;
        if let (Some(first), Some(last)) = (child_result.first, child_result.last) {
            let dict = incremental
                .new_document
                .get_dictionary_mut(node.object_id)?;
            dict.set("First", Object::Reference(first));
            dict.set("Last", Object::Reference(last));
            if child_result.visible_count > 0 {
                dict.set("Count", Object::Integer(child_result.visible_count));
            }
            node.visible_count += child_result.visible_count;
        }
    }

    Ok(OutlineBuildResult {
        first: nodes.first().map(|node| node.object_id),
        last: nodes.last().map(|node| node.object_id),
        visible_count: nodes.iter().map(|node| node.visible_count).sum(),
    })
}

fn set_bookmarks_on_catalog(
    document: &mut Document,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    assert_mutation_page_count(document, bookmarks.total_pages, "Bookmark mutation")?;
    let normalized =
        normalize_bookmark_entries(&bookmarks.items, bookmarks.total_pages, &bookmarks.untitled_label);
    let catalog_id = catalog_id(document)?;
    if normalized.is_empty() {
        let catalog = document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    }

    let page_map = document.get_pages();
    let outlines_ref = document.new_object_id();
    let mut outlines_dict = Dictionary::new();
    outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    document.set_object(outlines_ref, Object::Dictionary(outlines_dict));
    let tree = build_outline_level(document, &page_map, &normalized, outlines_ref)?;
    let outlines_dict = document.get_dictionary_mut(outlines_ref)?;
    let (Some(first), Some(last)) = (tree.first, tree.last) else {
        let catalog = document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    };
    outlines_dict.set("First", Object::Reference(first));
    outlines_dict.set("Last", Object::Reference(last));
    outlines_dict.set("Count", Object::Integer(tree.visible_count));
    let catalog = document.get_dictionary_mut(catalog_id)?;
    catalog.set("Outlines", Object::Reference(outlines_ref));
    Ok(())
}

fn set_bookmarks(document: &mut Document, bookmarks: &BookmarksMutation) -> Result<()> {
    set_bookmarks_on_catalog(document, bookmarks)
}

fn set_bookmarks_incremental(
    incremental: &mut IncrementalDocument,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        bookmarks.total_pages,
        "Bookmark mutation",
    )?;
    let normalized =
        normalize_bookmark_entries(&bookmarks.items, bookmarks.total_pages, &bookmarks.untitled_label);
    let catalog_id = catalog_id(incremental.get_prev_documents())?;
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    if normalized.is_empty() {
        let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    }

    let page_map = incremental.get_prev_documents().get_pages();
    let outlines_ref = incremental.new_document.new_object_id();
    let mut outlines_dict = Dictionary::new();
    outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    incremental
        .new_document
        .set_object(outlines_ref, Object::Dictionary(outlines_dict));
    let tree = build_outline_level_incremental(incremental, &page_map, &normalized, outlines_ref)?;
    let outlines_dict = incremental.new_document.get_dictionary_mut(outlines_ref)?;
    let (Some(first), Some(last)) = (tree.first, tree.last) else {
        let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    };
    outlines_dict.set("First", Object::Reference(first));
    outlines_dict.set("Last", Object::Reference(last));
    outlines_dict.set("Count", Object::Integer(tree.visible_count));
    let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
    catalog.set("Outlines", Object::Reference(outlines_ref));
    Ok(())
}

fn normalize_managed_shape_stable_key(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.starts_with("evb-shape:") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn read_managed_shape_stable_key(dict: &Dictionary) -> Option<String> {
    dict.get(b"EVBShapeKey")
        .ok()
        .and_then(pdf_string_to_text)
        .and_then(|value| normalize_managed_shape_stable_key(Some(&value)))
}

fn write_managed_shape_stable_key(dict: &mut Dictionary, stable_key: Option<&str>) -> bool {
    let Some(stable_key) = normalize_managed_shape_stable_key(stable_key) else {
        return false;
    };
    if read_managed_shape_stable_key(dict).as_deref() == Some(stable_key.as_str()) {
        return false;
    }
    dict.set(
        "EVBShapeKey",
        Object::String(encode_pdf_text_string(&stable_key), StringFormat::Hexadecimal),
    );
    true
}

fn format_pdfjs_annotation_ref(object_id: ObjectId) -> String {
    if object_id.1 == 0 {
        format!("{}R", object_id.0)
    } else {
        format!("{}R{}", object_id.0, object_id.1)
    }
}

fn normalize_pdfjs_annotation_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (object, generation) = trimmed.split_once('R')?;
    if object.is_empty() || !object.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let object_number = object.parse::<u32>().ok()?;
    if object_number == 0 {
        return None;
    }
    if generation.is_empty() {
        return Some(format!("{object_number}R"));
    }
    if !generation
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let generation_number = generation.parse::<u16>().ok()?;
    if generation_number == 0 {
        Some(format!("{object_number}R"))
    } else {
        Some(format!("{object_number}R{generation_number}"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct RgbColor {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Clone)]
struct MarkupHintState {
    hint: MarkupSubtypeHint,
    consumed: bool,
}

#[derive(Clone)]
struct MarkupAnnotationCandidate {
    color: Option<RgbColor>,
    marker_rect: Option<MarkerRect>,
    object_id: ObjectId,
    page_markup_index: u32,
    quad_points: Option<Vec<f64>>,
    rect: Option<PdfRect>,
    ref_tag: String,
    subtype: String,
}

const MIN_MARKUP_SUBTYPE_HINT_IOU: f64 = 0.45;
const DUPLICATE_MARKUP_SUBTYPE_HINT_IOU: f64 = 0.92;
const EXPLICIT_REF_MATCH_SCORE: f64 = 100.0;
const GEOMETRY_MATCH_WEIGHT: f64 = 10.0;
const COLOR_MATCH_WEIGHT: f64 = 1.5;
const PAGE_MARKUP_INDEX_MATCH_BONUS: f64 = 0.25;
const PAGE_MARKUP_INDEX_MISMATCH_PENALTY: f64 = 0.08;
const MAX_RGB_DISTANCE: f64 = 441.6729559300637;
const HIGHLIGHT_DISPLAY_OPACITY: f64 = 0.35;
const SQUIGGLY_APPEARANCE_STROKE_WIDTH: f64 = 1.0;
const SQUIGGLY_APPEARANCE_MAX_AMPLITUDE: f64 = 2.0;
const SQUIGGLY_APPEARANCE_MIN_AMPLITUDE: f64 = 0.6;
const SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO: f64 = 0.07;
const MIN_POINT_MARKER_SIZE: f64 = 0.0016;
const SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO: f64 = 0.35;
const MIN_TEXT_MARKUP_QUAD_HEIGHT: f64 = 0.01;

fn markup_subtype_pdf_name(subtype: &str) -> Option<&'static str> {
    match subtype {
        "Highlight" => Some("Highlight"),
        "Underline" => Some("Underline"),
        "StrikeOut" => Some("StrikeOut"),
        "Squiggly" => Some("Squiggly"),
        _ => None,
    }
}

fn canonical_markup_subtype(dict: &Dictionary) -> Option<String> {
    match annotation_subtype(dict).as_str() {
        "highlight" => Some("Highlight".to_string()),
        "underline" => Some("Underline".to_string()),
        "strikeout" => Some("StrikeOut".to_string()),
        "squiggly" => Some("Squiggly".to_string()),
        _ => None,
    }
}

fn resolve_object<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document.dereference(object).ok().map(|(_, resolved)| resolved)
}

fn object_to_markup_color_channel(value: f64, all_channels_are_unit_range: bool) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    let scaled = if all_channels_are_unit_range {
        value * 255.0
    } else {
        value
    };
    Some(scaled.round().clamp(0.0, 255.0) as u8)
}

fn read_markup_color(document: &Document, dict: &Dictionary) -> Option<RgbColor> {
    let object = dict.get(b"C").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.len() < 3 {
        return None;
    }
    let channels = [
        object_to_f64(&values[0]).ok()?,
        object_to_f64(&values[1]).ok()?,
        object_to_f64(&values[2]).ok()?,
    ];
    let all_channels_are_unit_range = channels.iter().all(|channel| (0.0..=1.0).contains(channel));
    Some(RgbColor {
        r: object_to_markup_color_channel(channels[0], all_channels_are_unit_range)?,
        g: object_to_markup_color_channel(channels[1], all_channels_are_unit_range)?,
        b: object_to_markup_color_channel(channels[2], all_channels_are_unit_range)?,
    })
}

fn read_pdf_rect_from_dict(document: &Document, dict: &Dictionary) -> Option<PdfRect> {
    let object = dict.get(b"Rect").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.len() < 4 {
        return None;
    }
    let x1 = object_to_f64(&values[0]).ok()?;
    let y1 = object_to_f64(&values[1]).ok()?;
    let x2 = object_to_f64(&values[2]).ok()?;
    let y2 = object_to_f64(&values[3]).ok()?;
    let rect = PdfRect {
        x1: x1.min(x2),
        y1: y1.min(y2),
        x2: x1.max(x2),
        y2: y1.max(y2),
    };
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return None;
    }
    Some(rect)
}

fn read_markup_quad_points(document: &Document, dict: &Dictionary) -> Option<Vec<f64>> {
    let object = dict.get(b"QuadPoints").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.is_empty() || values.len() % 8 != 0 {
        return None;
    }
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let parsed = object_to_f64(value).ok()?;
        if !parsed.is_finite() {
            return None;
        }
        result.push(parsed);
    }
    Some(result)
}

fn marker_point_from_pdf_point(
    x: f64,
    y: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    let norm_x = (x - page_view.x1) / page_view.width();
    let norm_y = (y - page_view.y1) / page_view.height();
    match page_rotation {
        90 => (norm_y, norm_x),
        180 => (1.0 - norm_x, norm_y),
        270 => (1.0 - norm_y, 1.0 - norm_x),
        _ => (norm_x, 1.0 - norm_y),
    }
}

fn normalize_marker_rect_bounds(
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Option<MarkerRect> {
    let width = right - left;
    let height = bottom - top;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let clamped_left = left.clamp(0.0, 1.0);
    let clamped_top = top.clamp(0.0, 1.0);
    let clamped_width = width.clamp(0.0, 1.0 - clamped_left);
    let clamped_height = height.clamp(0.0, 1.0 - clamped_top);
    if clamped_width <= 0.0 || clamped_height <= 0.0 {
        return None;
    }
    Some(MarkerRect {
        left: clamped_left,
        top: clamped_top,
        width: clamped_width,
        height: clamped_height,
    })
}

fn marker_rect_from_pdf_rect(
    rect: PdfRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Option<MarkerRect> {
    let corners = [
        marker_point_from_pdf_point(rect.x1, rect.y1, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x1, rect.y2, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x2, rect.y1, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x2, rect.y2, page_view, page_rotation),
    ];
    let mut left = corners.iter().map(|point| point.0).fold(f64::INFINITY, f64::min);
    let mut top = corners.iter().map(|point| point.1).fold(f64::INFINITY, f64::min);
    let mut right = corners
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut bottom = corners
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    if right - left < MIN_POINT_MARKER_SIZE {
        let center = left + (right - left) / 2.0;
        left = center - MIN_POINT_MARKER_SIZE / 2.0;
        right = left + MIN_POINT_MARKER_SIZE;
    }
    if bottom - top < MIN_POINT_MARKER_SIZE {
        let center = top + (bottom - top) / 2.0;
        top = center - MIN_POINT_MARKER_SIZE / 2.0;
        bottom = top + MIN_POINT_MARKER_SIZE;
    }
    normalize_marker_rect_bounds(left, top, right, bottom)
}

fn marker_rect_iou(left: Option<MarkerRect>, right: Option<MarkerRect>) -> f64 {
    let (Some(left), Some(right)) = (left, right) else {
        return 0.0;
    };
    let intersection_left = left.left.max(right.left);
    let intersection_top = left.top.max(right.top);
    let intersection_right = (left.left + left.width).min(right.left + right.width);
    let intersection_bottom = (left.top + left.height).min(right.top + right.height);
    let intersection_width = (intersection_right - intersection_left).max(0.0);
    let intersection_height = (intersection_bottom - intersection_top).max(0.0);
    let intersection_area = intersection_width * intersection_height;
    if intersection_area <= 0.0 {
        return 0.0;
    }
    let union_area = (left.width * left.height) + (right.width * right.height) - intersection_area;
    if union_area <= 0.0 {
        return 0.0;
    }
    intersection_area / union_area
}

fn parse_rgb_channel_token(token: &str) -> Option<u8> {
    let trimmed = token.trim();
    if let Some(percent) = trimmed.strip_suffix('%') {
        let parsed = percent.trim().parse::<f64>().ok()?;
        if !parsed.is_finite() {
            return None;
        }
        return Some(((parsed / 100.0) * 255.0).round().clamp(0.0, 255.0) as u8);
    }
    let parsed = trimmed.parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.round().clamp(0.0, 255.0) as u8)
}

fn parse_css_rgb_color(value: Option<&str>) -> Option<RgbColor> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix('#') {
        if hex.len() == 3 {
            let mut expanded = String::with_capacity(6);
            for character in hex.chars() {
                expanded.push(character);
                expanded.push(character);
            }
            return parse_css_rgb_color(Some(&format!("#{expanded}")));
        }
        if hex.len() == 6 {
            return Some(RgbColor {
                r: u8::from_str_radix(&hex[0..2], 16).ok()?,
                g: u8::from_str_radix(&hex[2..4], 16).ok()?,
                b: u8::from_str_radix(&hex[4..6], 16).ok()?,
            });
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
    let channels: Vec<&str> = if args.contains(',') {
        args.split(',').collect()
    } else {
        args.split_whitespace().collect()
    };
    if channels.len() < 3 {
        return None;
    }
    Some(RgbColor {
        r: parse_rgb_channel_token(channels[0])?,
        g: parse_rgb_channel_token(channels[1])?,
        b: parse_rgb_channel_token(channels[2])?,
    })
}

fn resolve_hint_target_color(target_subtype: &str, color: Option<&str>) -> Option<RgbColor> {
    let parsed = parse_css_rgb_color(color)?;
    if target_subtype != "Highlight" {
        return Some(parsed);
    }
    let blend = |channel: u8| -> u8 {
        ((f64::from(channel) * HIGHLIGHT_DISPLAY_OPACITY)
            + (255.0 * (1.0 - HIGHLIGHT_DISPLAY_OPACITY)))
            .round()
            .clamp(0.0, 255.0) as u8
    };
    Some(RgbColor {
        r: blend(parsed.r),
        g: blend(parsed.g),
        b: blend(parsed.b),
    })
}

fn write_markup_color(dict: &mut Dictionary, color: RgbColor) {
    dict.set(
        "C",
        Object::Array(vec![
            number_object(f64::from(color.r) / 255.0),
            number_object(f64::from(color.g) / 255.0),
            number_object(f64::from(color.b) / 255.0),
        ]),
    );
}

fn color_similarity(left: Option<RgbColor>, right: Option<RgbColor>) -> Option<f64> {
    let (Some(left), Some(right)) = (left, right) else {
        return None;
    };
    let distance = ((f64::from(left.r) - f64::from(right.r)).powi(2)
        + (f64::from(left.g) - f64::from(right.g)).powi(2)
        + (f64::from(left.b) - f64::from(right.b)).powi(2))
    .sqrt();
    Some((1.0 - (distance / MAX_RGB_DISTANCE)).max(0.0))
}

fn hint_colors_conflict(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    match color_similarity(
        parse_css_rgb_color(left.color.as_deref()),
        parse_css_rgb_color(right.color.as_deref()),
    ) {
        Some(similarity) => similarity < 0.98,
        None => false,
    }
}

fn normalize_hint_annotation_ref(hint: &MarkupSubtypeHint) -> Option<String> {
    hint.annotation_id
        .as_deref()
        .and_then(normalize_pdfjs_annotation_id)
}

fn subtype_hints_share_identity(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    if left.subtype != right.subtype {
        return false;
    }
    (left
        .id
        .as_deref()
        .zip(right.id.as_deref())
        .is_some_and(|(left_id, right_id)| left_id == right_id))
        || normalize_hint_annotation_ref(left)
            .zip(normalize_hint_annotation_ref(right))
            .is_some_and(|(left_ref, right_ref)| left_ref == right_ref)
}

fn subtype_hints_share_geometry(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    left.page_index == right.page_index
        && left.subtype == right.subtype
        && !hint_colors_conflict(left, right)
        && marker_rect_iou(Some(left.marker_rect), Some(right.marker_rect))
            >= DUPLICATE_MARKUP_SUBTYPE_HINT_IOU
}

fn merge_subtype_hints(
    existing: &MarkupSubtypeHint,
    incoming: &MarkupSubtypeHint,
) -> MarkupSubtypeHint {
    MarkupSubtypeHint {
        subtype: existing.subtype.clone(),
        page_index: existing.page_index,
        marker_rect: existing.marker_rect,
        annotation_id: existing
            .annotation_id
            .clone()
            .or_else(|| incoming.annotation_id.clone()),
        color: existing.color.clone().or_else(|| incoming.color.clone()),
        id: existing.id.clone().or_else(|| incoming.id.clone()),
        page_markup_index: existing.page_markup_index.or(incoming.page_markup_index),
        source: existing.source.clone().or_else(|| incoming.source.clone()),
    }
}

fn dedupe_markup_subtype_hints(hints: &[MarkupSubtypeHint]) -> Vec<MarkupHintState> {
    let mut deduped: Vec<MarkupSubtypeHint> = Vec::new();
    for hint in hints {
        let existing_index = deduped.iter().position(|existing| {
            subtype_hints_share_identity(existing, hint)
                || subtype_hints_share_geometry(existing, hint)
        });
        if let Some(index) = existing_index {
            deduped[index] = merge_subtype_hints(&deduped[index], hint);
        } else {
            deduped.push(hint.clone());
        }
    }
    deduped
        .into_iter()
        .map(|hint| MarkupHintState {
            hint,
            consumed: false,
        })
        .collect()
}

fn can_use_geometry_only_subtype_hint(hint: &MarkupSubtypeHint) -> bool {
    hint.subtype == "Highlight"
        || match hint.source.as_deref() {
            Some(source) => source == "editor-live",
            None => true,
        }
}

fn score_subtype_hint_for_candidate(
    hint_state: &MarkupHintState,
    candidate: &MarkupAnnotationCandidate,
) -> Option<f64> {
    if hint_state.consumed {
        return None;
    }
    let hint = &hint_state.hint;
    let hint_ref = normalize_hint_annotation_ref(hint);
    let ref_matched = hint_ref.as_deref() == Some(candidate.ref_tag.as_str());
    let geometry_score = marker_rect_iou(candidate.marker_rect, Some(hint.marker_rect));
    if !ref_matched
        && (hint_ref.is_some()
            || !can_use_geometry_only_subtype_hint(hint)
            || geometry_score < MIN_MARKUP_SUBTYPE_HINT_IOU)
    {
        return None;
    }
    let index_score = match hint.page_markup_index {
        Some(page_markup_index) if page_markup_index == candidate.page_markup_index => {
            PAGE_MARKUP_INDEX_MATCH_BONUS
        }
        Some(page_markup_index) => {
            let delta = page_markup_index.abs_diff(candidate.page_markup_index).min(3);
            -(f64::from(delta) * PAGE_MARKUP_INDEX_MISMATCH_PENALTY)
        }
        None => 0.0,
    };
    let color_score =
        color_similarity(parse_css_rgb_color(hint.color.as_deref()), candidate.color).unwrap_or(0.0);
    Some(
        (if ref_matched {
            EXPLICIT_REF_MATCH_SCORE
        } else {
            0.0
        }) + (geometry_score * GEOMETRY_MATCH_WEIGHT)
            + (color_score * COLOR_MATCH_WEIGHT)
            + index_score,
    )
}

fn find_exact_ref_highlight_preservation_hint(
    page_hints: &[MarkupHintState],
    candidate: &MarkupAnnotationCandidate,
) -> Option<usize> {
    page_hints.iter().position(|hint_state| {
        !hint_state.consumed
            && hint_state.hint.subtype == "Highlight"
            && normalize_hint_annotation_ref(&hint_state.hint).as_deref()
                == Some(candidate.ref_tag.as_str())
    })
}

fn find_best_exact_ref_hint_for_candidate(
    page_hints: &[MarkupHintState],
    candidate: &MarkupAnnotationCandidate,
) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (index, hint_state) in page_hints.iter().enumerate() {
        if normalize_hint_annotation_ref(&hint_state.hint).as_deref()
            != Some(candidate.ref_tag.as_str())
        {
            continue;
        }
        let Some(score) = score_subtype_hint_for_candidate(hint_state, candidate) else {
            continue;
        };
        if best.map_or(true, |(_, best_score)| score > best_score) {
            best = Some((index, score));
        }
    }
    best.map(|(index, _)| index)
}

fn consume_exact_ref_hints(page_hints: &mut [MarkupHintState], candidate: &MarkupAnnotationCandidate) {
    for hint_state in page_hints {
        if normalize_hint_annotation_ref(&hint_state.hint).as_deref()
            == Some(candidate.ref_tag.as_str())
        {
            hint_state.consumed = true;
        }
    }
}

fn assign_subtype_hints_to_candidates(
    page_hints: &[MarkupHintState],
    candidates: &[MarkupAnnotationCandidate],
) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        for (hint_index, hint_state) in page_hints.iter().enumerate() {
            if let Some(score) = score_subtype_hint_for_candidate(hint_state, candidate) {
                matches.push((candidate_index, hint_index, score));
            }
        }
    }
    matches.sort_by(|left, right| right.2.total_cmp(&left.2));
    let mut assigned_candidates = HashSet::new();
    let mut assigned_hints = HashSet::new();
    let mut assignments = Vec::new();
    for (candidate_index, hint_index, _score) in matches {
        if assigned_candidates.contains(&candidate_index) || assigned_hints.contains(&hint_index) {
            continue;
        }
        assigned_candidates.insert(candidate_index);
        assigned_hints.insert(hint_index);
        assignments.push((candidate_index, hint_index));
    }
    assignments
}

fn rect_to_fallback_quad_points(rect: PdfRect) -> Vec<f64> {
    vec![
        rect.x1, rect.y2, rect.x2, rect.y2, rect.x1, rect.y1, rect.x2, rect.y1,
    ]
}

#[derive(Clone)]
struct TextMarkupQuad {
    bottom: f64,
    center_y: f64,
    index: usize,
    left: f64,
    right: f64,
    top: f64,
}

struct TextMarkupQuadLineGroup {
    average_height: f64,
    bottom: f64,
    center_y: f64,
    quads: Vec<TextMarkupQuad>,
    top: f64,
}

fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let mut total = 0.0;
    let mut count = 0.0;
    for value in values {
        total += value;
        count += 1.0;
    }
    if count == 0.0 {
        0.0
    } else {
        total / count
    }
}

fn to_text_markup_quads(values: &[f64]) -> Option<Vec<TextMarkupQuad>> {
    let mut quads = Vec::new();
    for (index, chunk) in values.chunks_exact(8).enumerate() {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        if xs.iter().chain(ys.iter()).any(|value| !value.is_finite()) {
            return None;
        }
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if right <= left || top <= bottom {
            return None;
        }
        quads.push(TextMarkupQuad {
            bottom,
            center_y: (top + bottom) / 2.0,
            index,
            left,
            right,
            top,
        });
    }
    Some(quads)
}

fn add_quad_to_line_group(group: &mut TextMarkupQuadLineGroup, quad: TextMarkupQuad) {
    group.quads.push(quad);
    group.bottom = group
        .quads
        .iter()
        .map(|item| item.bottom)
        .fold(f64::INFINITY, f64::min);
    group.top = group
        .quads
        .iter()
        .map(|item| item.top)
        .fold(f64::NEG_INFINITY, f64::max);
    group.center_y = mean(group.quads.iter().map(|item| item.center_y));
    group.average_height = mean(group.quads.iter().map(|item| item.top - item.bottom));
}

fn normalize_markup_quad_points(values: &[f64]) -> Option<Vec<f64>> {
    let mut quads = to_text_markup_quads(values)?;
    if quads.is_empty() {
        return None;
    }
    quads.sort_by(|left, right| {
        right
            .center_y
            .total_cmp(&left.center_y)
            .then_with(|| left.left.total_cmp(&right.left))
    });
    let mut groups: Vec<TextMarkupQuadLineGroup> = Vec::new();
    for quad in quads {
        let belongs_to_previous = groups.last().is_some_and(|group| {
            let tolerance = group.average_height.max(quad.top - quad.bottom)
                * SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
            (quad.center_y - group.center_y).abs() <= tolerance
        });
        if belongs_to_previous {
            let group = groups.last_mut().expect("line group exists");
            add_quad_to_line_group(group, quad);
        } else {
            groups.push(TextMarkupQuadLineGroup {
                average_height: quad.top - quad.bottom,
                bottom: quad.bottom,
                center_y: quad.center_y,
                quads: vec![quad.clone()],
                top: quad.top,
            });
        }
    }
    if groups.len() <= 1 {
        return Some(values.to_vec());
    }
    let mut normalized = values.to_vec();
    for group_index in 0..groups.len() {
        let mut line_top = groups[group_index].top;
        let mut line_bottom = groups[group_index].bottom;
        if let Some(previous_group) = group_index.checked_sub(1).and_then(|index| groups.get(index)) {
            line_top = line_top.min((previous_group.center_y + groups[group_index].center_y) / 2.0);
        }
        if let Some(next_group) = groups.get(group_index + 1) {
            line_bottom = line_bottom.max((groups[group_index].center_y + next_group.center_y) / 2.0);
        }
        if line_top - line_bottom < MIN_TEXT_MARKUP_QUAD_HEIGHT {
            line_top = groups[group_index].top;
            line_bottom = groups[group_index].bottom;
        }
        for quad in &groups[group_index].quads {
            let offset = quad.index * 8;
            normalized[offset] = quad.left;
            normalized[offset + 1] = line_top;
            normalized[offset + 2] = quad.right;
            normalized[offset + 3] = line_top;
            normalized[offset + 4] = quad.left;
            normalized[offset + 5] = line_bottom;
            normalized[offset + 6] = quad.right;
            normalized[offset + 7] = line_bottom;
        }
    }
    Some(normalized)
}

fn ensure_markup_quad_points(candidate: &MarkupAnnotationCandidate) -> Option<(Vec<f64>, bool)> {
    if let Some(values) = &candidate.quad_points {
        let normalized = normalize_markup_quad_points(values)?;
        let changed = normalized
            .iter()
            .zip(values.iter())
            .any(|(left, right)| (left - right).abs() > f64::EPSILON);
        return Some((normalized, changed));
    }
    let rect = candidate.rect?;
    Some((rect_to_fallback_quad_points(rect), true))
}

fn number_to_content(value: f64) -> String {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001 {
        return format!("{rounded:.0}");
    }
    let formatted = format!("{value:.4}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn build_squiggly_appearance_stream(
    values: &[f64],
    rect: PdfRect,
    color: RgbColor,
) -> Option<Stream> {
    // Quartz/Preview does not synthesize Squiggly appearances from QuadPoints,
    // so native rewrites must append a small Form XObject for visibility.
    let mut content = String::new();
    content.push_str("q\n");
    content.push_str(&format!(
        "{} {} {} RG\n",
        number_to_content(f64::from(color.r) / 255.0),
        number_to_content(f64::from(color.g) / 255.0),
        number_to_content(f64::from(color.b) / 255.0)
    ));
    content.push_str(&format!(
        "{} w\n1 J\n",
        number_to_content(SQUIGGLY_APPEARANCE_STROKE_WIDTH)
    ));
    let mut has_path = false;
    for chunk in values.chunks_exact(8) {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let height = top - bottom;
        if right - left <= 0.0 || height <= 0.0 {
            continue;
        }
        let amplitude = SQUIGGLY_APPEARANCE_MAX_AMPLITUDE
            .min(SQUIGGLY_APPEARANCE_MIN_AMPLITUDE.max(height * SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO));
        let center = bottom + amplitude;
        let half_step = 1.5_f64.max(amplitude * 1.5);
        content.push_str(&format!(
            "{} {} m\n",
            number_to_content(left),
            number_to_content(center - amplitude)
        ));
        let mut x = left;
        let mut up = true;
        while x < right {
            x = right.min(x + half_step);
            content.push_str(&format!(
                "{} {} l\n",
                number_to_content(x),
                number_to_content(if up { center + amplitude } else { center - amplitude })
            ));
            up = !up;
        }
        has_path = true;
    }
    if !has_path {
        return None;
    }
    content.push_str("S\nQ\n");
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set("BBox", rect_object(rect));
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
    Some(Stream::new(dict, content.into_bytes()))
}

fn quad_points_object(values: &[f64]) -> Object {
    Object::Array(values.iter().map(|value| number_object(*value)).collect())
}

fn apply_markup_rewrite_to_object(
    document: &mut Document,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<bool> {
    let target_color = resolve_hint_target_color(target_subtype, color);
    let mut modified = false;
    let mut ensured_quad_points: Option<(Vec<f64>, bool)> = None;
    let mut squiggly_ap_ref: Option<ObjectId> = None;

    if target_subtype != "Highlight" {
        ensured_quad_points = ensure_markup_quad_points(candidate);
        let subtype_already_applied = candidate.subtype == target_subtype;
        if !subtype_already_applied {
            modified = true;
        }
        if ensured_quad_points
            .as_ref()
            .is_some_and(|(_, changed)| *changed)
        {
            modified = true;
        }
        if target_subtype == "Squiggly" {
            if let (Some((values, _)), Some(rect), Some(color)) =
                (&ensured_quad_points, candidate.rect, target_color.or(candidate.color))
            {
                if let Some(stream) = build_squiggly_appearance_stream(values, rect, color) {
                    squiggly_ap_ref = Some(document.add_object(stream));
                    modified = true;
                }
            }
        }
    }
    if target_color.is_some() {
        modified = true;
    }
    if !modified {
        return Ok(false);
    }

    let dict = document.get_dictionary_mut(candidate.object_id)?;
    if let Some(color) = target_color {
        write_markup_color(dict, color);
        if target_subtype == "Highlight" {
            dict.set("CA", Object::Integer(1));
        }
        dict.remove(b"AP");
    }
    if target_subtype != "Highlight" {
        if let Some((values, _)) = ensured_quad_points {
            dict.set("QuadPoints", quad_points_object(&values));
        }
        if candidate.subtype != target_subtype {
            let pdf_name = markup_subtype_pdf_name(target_subtype)
                .ok_or("Invalid text-markup subtype")?;
            dict.set("Subtype", Object::Name(pdf_name.as_bytes().to_vec()));
            dict.remove(b"AP");
        }
        if let Some(ap_ref) = squiggly_ap_ref {
            let mut ap = Dictionary::new();
            ap.set("N", Object::Reference(ap_ref));
            dict.set("AP", Object::Dictionary(ap));
        }
    }
    Ok(true)
}

fn create_markup_candidate(
    document: &Document,
    page_view: PdfRect,
    page_rotation: i64,
    object_id: ObjectId,
    page_markup_index: u32,
) -> Option<MarkupAnnotationCandidate> {
    let dict = document.get_dictionary(object_id).ok()?;
    let subtype = canonical_markup_subtype(dict)?;
    let rect = read_pdf_rect_from_dict(document, dict);
    Some(MarkupAnnotationCandidate {
        color: read_markup_color(document, dict),
        marker_rect: rect.and_then(|rect| marker_rect_from_pdf_rect(rect, page_view, page_rotation)),
        object_id,
        page_markup_index,
        quad_points: read_markup_quad_points(document, dict),
        rect,
        ref_tag: format_pdfjs_annotation_ref(object_id),
        subtype,
    })
}

fn build_markup_inputs(
    markup: &MarkupMutation,
) -> (HashMap<String, String>, HashMap<u32, Vec<MarkupHintState>>) {
    let overrides = markup
        .overrides
        .iter()
        .map(|(annotation_id, subtype)| (annotation_id.clone(), subtype.clone()))
        .collect();
    let mut hints_by_page: HashMap<u32, Vec<MarkupHintState>> = HashMap::new();
    for hint_state in dedupe_markup_subtype_hints(&markup.hints) {
        hints_by_page
            .entry(hint_state.hint.page_index)
            .or_default()
            .push(hint_state);
    }
    (overrides, hints_by_page)
}

fn rewrite_page_markup_subtypes(
    document: &mut Document,
    candidates: &[MarkupAnnotationCandidate],
    overrides: &HashMap<String, String>,
    page_hints: &mut Vec<MarkupHintState>,
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();

    for candidate in candidates {
        if let Some(hint_index) = find_exact_ref_highlight_preservation_hint(page_hints, candidate) {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate);
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) = find_best_exact_ref_hint_for_candidate(page_hints, candidate) {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate);
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                override_subtype,
                None,
            )? || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_object(
            document,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
        )? || rewritten;
    }
    Ok(rewritten)
}

fn apply_markup_rewrite_to_incremental_object(
    incremental: &mut IncrementalDocument,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<bool> {
    incremental.opt_clone_object_to_new_document(candidate.object_id)?;
    apply_markup_rewrite_to_object(
        &mut incremental.new_document,
        candidate,
        target_subtype,
        color,
    )
}

fn rewrite_page_markup_subtypes_incremental(
    incremental: &mut IncrementalDocument,
    candidates: &[MarkupAnnotationCandidate],
    overrides: &HashMap<String, String>,
    page_hints: &mut Vec<MarkupHintState>,
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();

    for candidate in candidates {
        if let Some(hint_index) = find_exact_ref_highlight_preservation_hint(page_hints, candidate) {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) = find_best_exact_ref_hint_for_candidate(page_hints, candidate) {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                override_subtype,
                None,
            )? || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_incremental_object(
            incremental,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
        )? || rewritten;
    }
    Ok(rewritten)
}

fn apply_markup_mutations(document: &mut Document, markup: &MarkupMutation) -> Result<()> {
    let (overrides, mut hints_by_page) = build_markup_inputs(markup);
    let page_map = document.get_pages();
    let mut modified = false;

    for (page_index, page_id) in page_map.values().copied().enumerate() {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let annots = get_page_annots(document, page_id)?;
        let mut candidates = Vec::new();
        let mut page_markup_index = 0_u32;
        for object_id in annots.iter().filter_map(|object| object.as_reference().ok()) {
            if let Some(candidate) =
                create_markup_candidate(document, page_view, page_rotation, object_id, page_markup_index)
            {
                candidates.push(candidate);
                page_markup_index += 1;
            }
        }
        let page_hints = hints_by_page.entry(page_index as u32).or_default();
        modified = rewrite_page_markup_subtypes(document, &candidates, &overrides, page_hints)?
            || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}

fn apply_markup_mutations_incremental(
    incremental: &mut IncrementalDocument,
    markup: &MarkupMutation,
) -> Result<()> {
    let (overrides, mut hints_by_page) = build_markup_inputs(markup);
    let page_map = incremental.get_prev_documents().get_pages();
    let mut modified = false;

    for (page_index, page_id) in page_map.values().copied().enumerate() {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let annots = get_page_annots(incremental.get_prev_documents(), page_id)?;
        let mut candidates = Vec::new();
        let mut page_markup_index = 0_u32;
        for object_id in annots.iter().filter_map(|object| object.as_reference().ok()) {
            if let Some(candidate) = create_markup_candidate(
                incremental.get_prev_documents(),
                page_view,
                page_rotation,
                object_id,
                page_markup_index,
            ) {
                candidates.push(candidate);
                page_markup_index += 1;
            }
        }
        let page_hints = hints_by_page.entry(page_index as u32).or_default();
        modified = rewrite_page_markup_subtypes_incremental(
            incremental,
            &candidates,
            &overrides,
            page_hints,
        )? || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}

fn shape_annotation_subtype_for_create(shape: &ShapeAnnotation) -> Option<&'static str> {
    match shape.shape_type.as_str() {
        "rectangle" => Some("Square"),
        "circle" => Some("Circle"),
        "line" | "arrow" => Some("Line"),
        "polyline" if shape.pdf_subtype.as_deref() == Some("Ink") => Some("Ink"),
        "polyline" => Some("PolyLine"),
        "polygon" => Some("Polygon"),
        _ => None,
    }
}

fn is_supported_shape_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "square" | "circle" | "line" | "polyline" | "polygon" | "ink"
    )
}

fn timestamp_millis_to_pdf_date_utc(timestamp_millis: u64) -> String {
    let seconds = (timestamp_millis / 1_000).min(i64::MAX as u64) as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("D:{year:04}{month:02}{day:02}{hour:02}{minute:02}{second:02}Z")
}

fn civil_from_unix_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

fn shape_pdf_date(timestamp: Option<u64>, fallback: &str) -> String {
    timestamp
        .filter(|value| *value > 0)
        .map(timestamp_millis_to_pdf_date_utc)
        .unwrap_or_else(|| fallback.to_string())
}

fn set_shape_dates(dict: &mut Dictionary, shape: &ShapeAnnotation, modified_at: &str) {
    let created = shape_pdf_date(shape.created_at.or(shape.modified_at), modified_at);
    let modified = shape_pdf_date(shape.modified_at, &created);
    dict.set("CreationDate", Object::string_literal(created.into_bytes()));
    dict.set("M", Object::string_literal(modified.into_bytes()));
}

fn set_shape_style(dict: &mut Dictionary, shape: &ShapeAnnotation) {
    set_rgb_color(dict, "C", Some(&shape.color));
    dict.set("CA", number_object(shape.opacity));
    dict.set(
        "Border",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            number_object(shape.stroke_width),
        ]),
    );
}

fn shape_line_ending_name(style: Option<&str>) -> Object {
    match style {
        Some("openArrow") => Object::Name(b"OpenArrow".to_vec()),
        Some("closedArrow") => Object::Name(b"ClosedArrow".to_vec()),
        _ => Object::Name(b"None".to_vec()),
    }
}

fn set_shape_line_endings(dict: &mut Dictionary, shape: &ShapeAnnotation) {
    let start = shape.line_start_style.as_deref().unwrap_or("none");
    let end = shape.line_end_style.as_deref().unwrap_or("none");
    if start == "none" && end == "none" {
        dict.remove(b"LE");
        return;
    }
    dict.set(
        "LE",
        Object::Array(vec![
            shape_line_ending_name(Some(start)),
            shape_line_ending_name(Some(end)),
        ]),
    );
}

fn shape_rect_from_bounds(
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    marker_rect_to_pdf_rect(
        MarkerRect {
            left,
            top,
            width,
            height,
        },
        page_view,
        page_rotation,
    )
}

fn shape_pdf_point(
    point: &ShapePoint,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    pdf_point_from_marker_point(point.x, point.y, page_view, page_rotation)
}

fn shape_points_to_pdf_points(
    points: &[ShapePoint],
    page_view: PdfRect,
    page_rotation: i64,
) -> Vec<(f64, f64)> {
    points
        .iter()
        .map(|point| shape_pdf_point(point, page_view, page_rotation))
        .collect()
}

fn pdf_points_bounds(points: &[(f64, f64)], stroke_width: f64) -> Result<PdfRect> {
    if points.is_empty() {
        return Err("Shape has no PDF points".into());
    }
    let min_x = points.iter().map(|point| point.0).fold(f64::INFINITY, f64::min);
    let min_y = points.iter().map(|point| point.1).fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut rect = PdfRect {
        x1: min_x - stroke_width,
        y1: min_y - stroke_width,
        x2: max_x + stroke_width,
        y2: max_y + stroke_width,
    };
    if rect.width() <= 0.0 {
        rect.x1 -= 0.0001;
        rect.x2 += 0.0001;
    }
    if rect.height() <= 0.0 {
        rect.y1 -= 0.0001;
        rect.y2 += 0.0001;
    }
    Ok(rect)
}

fn flat_pdf_points_object(points: &[(f64, f64)]) -> Object {
    Object::Array(
        points
            .iter()
            .flat_map(|point| [number_object(point.0), number_object(point.1)])
            .collect(),
    )
}

fn set_rect_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let rect = shape_rect_from_bounds(
        shape.x,
        shape.y,
        shape.width,
        shape.height,
        page_view,
        page_rotation,
    )?;
    dict.set("Rect", rect_object(rect));
    set_shape_style(dict, shape);
    set_rgb_color(dict, "IC", shape.fill_color.as_deref());
    Ok(())
}

fn set_line_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let end = ShapePoint {
        x: shape.x2.ok_or("Line shape is missing x2")?,
        y: shape.y2.ok_or("Line shape is missing y2")?,
    };
    let points = vec![
        pdf_point_from_marker_point(shape.x, shape.y, page_view, page_rotation),
        shape_pdf_point(&end, page_view, page_rotation),
    ];
    let rect = pdf_points_bounds(&points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("L", flat_pdf_points_object(&points));
    set_shape_style(dict, shape);
    set_shape_line_endings(dict, shape);
    Ok(())
}

fn set_vertex_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    is_polygon: bool,
) -> Result<()> {
    let points = shape_points_to_pdf_points(&shape.points, page_view, page_rotation);
    let rect = pdf_points_bounds(&points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("Vertices", flat_pdf_points_object(&points));
    set_shape_style(dict, shape);
    if is_polygon {
        dict.remove(b"LE");
        set_rgb_color(dict, "IC", shape.fill_color.as_deref());
    } else {
        set_shape_line_endings(dict, shape);
        dict.remove(b"IC");
    }
    Ok(())
}

fn shape_ink_strokes<'a>(shape: &'a ShapeAnnotation) -> Vec<&'a [ShapePoint]> {
    if shape.strokes.is_empty() {
        vec![shape.points.as_slice()]
    } else {
        shape.strokes.iter().map(Vec::as_slice).collect()
    }
}

fn set_ink_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let mut all_points = Vec::new();
    let mut ink_list = Vec::new();
    for stroke in shape_ink_strokes(shape) {
        let pdf_points = shape_points_to_pdf_points(stroke, page_view, page_rotation);
        all_points.extend(pdf_points.iter().copied());
        ink_list.push(flat_pdf_points_object(&pdf_points));
    }
    let rect = pdf_points_bounds(&all_points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("InkList", Object::Array(ink_list));
    set_shape_style(dict, shape);
    dict.remove(b"LE");
    dict.remove(b"IC");
    Ok(())
}

fn update_shape_annotation_dict(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
) -> Result<bool> {
    let subtype = annotation_subtype(dict);
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    match subtype.as_str() {
        "square" | "circle" => set_rect_shape_fields(dict, shape, page_view, page_rotation)?,
        "line" => set_line_shape_fields(dict, shape, page_view, page_rotation)?,
        "polyline" => set_vertex_shape_fields(dict, shape, page_view, page_rotation, false)?,
        "polygon" => set_vertex_shape_fields(dict, shape, page_view, page_rotation, true)?,
        "ink" => set_ink_shape_fields(dict, shape, page_view, page_rotation)?,
        _ => return Ok(false),
    }
    set_shape_dates(dict, shape, modified_at);
    write_managed_shape_stable_key(dict, shape.stable_key.as_deref());
    Ok(true)
}

fn create_shape_annotation_dict(
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
) -> Result<Dictionary> {
    let subtype = shape_annotation_subtype_for_create(shape).ok_or("Invalid shape subtype")?;
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(subtype.as_bytes().to_vec()));
    match subtype {
        "Square" | "Circle" => set_rect_shape_fields(&mut dict, shape, page_view, page_rotation)?,
        "Line" => set_line_shape_fields(&mut dict, shape, page_view, page_rotation)?,
        "PolyLine" => set_vertex_shape_fields(&mut dict, shape, page_view, page_rotation, false)?,
        "Polygon" => set_vertex_shape_fields(&mut dict, shape, page_view, page_rotation, true)?,
        "Ink" => set_ink_shape_fields(&mut dict, shape, page_view, page_rotation)?,
        _ => return Err("Invalid shape subtype".into()),
    }
    set_shape_dates(&mut dict, shape, modified_at);
    write_managed_shape_stable_key(&mut dict, shape.stable_key.as_deref());
    Ok(dict)
}

struct ShapeConsumptionState<'a> {
    shapes: &'a [ShapeAnnotation],
    consumed: Vec<bool>,
    by_annotation_id: HashMap<String, usize>,
    by_stable_key: HashMap<String, usize>,
}

impl<'a> ShapeConsumptionState<'a> {
    fn new(shapes: &'a [ShapeAnnotation]) -> Self {
        let mut state = Self {
            shapes,
            consumed: vec![false; shapes.len()],
            by_annotation_id: HashMap::new(),
            by_stable_key: HashMap::new(),
        };
        for (index, shape) in shapes.iter().enumerate() {
            if let Some(annotation_id) = shape
                .annotation_id
                .as_deref()
                .and_then(normalize_pdfjs_annotation_id)
            {
                state.by_annotation_id.insert(annotation_id, index);
            }
            if let Some(stable_key) = normalize_managed_shape_stable_key(shape.stable_key.as_deref()) {
                state.by_stable_key.insert(stable_key, index);
            }
        }
        state
    }

    fn find_by_annotation_id(&self, annotation_id: &str) -> Option<usize> {
        self.by_annotation_id
            .get(annotation_id)
            .copied()
            .filter(|index| !self.consumed[*index])
    }

    fn find_by_stable_key(&self, stable_key: &str) -> Option<usize> {
        self.by_stable_key
            .get(stable_key)
            .copied()
            .filter(|index| !self.consumed[*index])
    }

    fn consume(&mut self, index: usize) {
        if index < self.consumed.len() {
            self.consumed[index] = true;
        }
    }

    fn remaining(&self) -> impl Iterator<Item = &ShapeAnnotation> {
        self.shapes
            .iter()
            .enumerate()
            .filter_map(|(index, shape)| (!self.consumed[index]).then_some(shape))
    }
}

struct DeletedShapeRefs {
    annotation_ids: HashSet<String>,
    stable_keys: HashSet<String>,
}

fn collect_deleted_shape_refs(shapes: &ShapesMutation) -> DeletedShapeRefs {
    DeletedShapeRefs {
        annotation_ids: shapes
            .deleted_annotation_ids
            .iter()
            .filter_map(|value| normalize_pdfjs_annotation_id(value))
            .collect(),
        stable_keys: shapes
            .deleted_stable_keys
            .iter()
            .filter_map(|value| normalize_managed_shape_stable_key(Some(value)))
            .collect(),
    }
}

fn collect_shape_annotation_refs_to_delete(
    document: &Document,
    refs_to_delete: &mut HashSet<ObjectId>,
    object_id: ObjectId,
) -> Result<()> {
    for delete_ref in collect_annotation_refs_to_delete(document, object_id)? {
        refs_to_delete.insert(delete_ref);
    }
    Ok(())
}

fn apply_shape_annotation_decision(
    document: &mut Document,
    state: &mut ShapeConsumptionState,
    deleted_refs: &DeletedShapeRefs,
    refs_to_delete: &mut HashSet<ObjectId>,
    rewrite_shape_state: bool,
    page_view: PdfRect,
    page_rotation: i64,
    object_id: ObjectId,
    modified_at: &str,
) -> Result<bool> {
    let (annotation_stable_key, annotation_id, subtype) = {
        let dict = match document.get_dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => return Ok(false),
        };
        (
            read_managed_shape_stable_key(dict),
            format_pdfjs_annotation_ref(object_id),
            annotation_subtype(dict),
        )
    };
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    if deleted_refs.annotation_ids.contains(&annotation_id)
        || annotation_stable_key
            .as_deref()
            .is_some_and(|stable_key| deleted_refs.stable_keys.contains(stable_key))
    {
        collect_shape_annotation_refs_to_delete(document, refs_to_delete, object_id)?;
        return Ok(true);
    }
    if let Some(stable_key) = annotation_stable_key.as_deref() {
        if let Some(index) = state.find_by_stable_key(stable_key) {
            let shape = state.shapes[index].clone();
            let dict = document.get_dictionary_mut(object_id)?;
            let modified = update_shape_annotation_dict(
                dict,
                &shape,
                page_view,
                page_rotation,
                modified_at,
            )?;
            state.consume(index);
            return Ok(modified);
        }
        if rewrite_shape_state {
            collect_shape_annotation_refs_to_delete(document, refs_to_delete, object_id)?;
            return Ok(true);
        }
        return Ok(false);
    }
    if let Some(index) = state.find_by_annotation_id(&annotation_id) {
        let shape = state.shapes[index].clone();
        let dict = document.get_dictionary_mut(object_id)?;
        let modified = update_shape_annotation_dict(dict, &shape, page_view, page_rotation, modified_at)?;
        state.consume(index);
        return Ok(modified);
    }
    Ok(false)
}

fn apply_shape_annotation_decision_incremental(
    incremental: &mut IncrementalDocument,
    state: &mut ShapeConsumptionState,
    deleted_refs: &DeletedShapeRefs,
    refs_to_delete: &mut HashSet<ObjectId>,
    rewrite_shape_state: bool,
    page_view: PdfRect,
    page_rotation: i64,
    object_id: ObjectId,
    modified_at: &str,
) -> Result<bool> {
    let (annotation_stable_key, annotation_id, subtype) = {
        let dict = match incremental.get_prev_documents().get_dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => return Ok(false),
        };
        (
            read_managed_shape_stable_key(dict),
            format_pdfjs_annotation_ref(object_id),
            annotation_subtype(dict),
        )
    };
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    if deleted_refs.annotation_ids.contains(&annotation_id)
        || annotation_stable_key
            .as_deref()
            .is_some_and(|stable_key| deleted_refs.stable_keys.contains(stable_key))
    {
        collect_shape_annotation_refs_to_delete(
            incremental.get_prev_documents(),
            refs_to_delete,
            object_id,
        )?;
        return Ok(true);
    }
    let shape_index = annotation_stable_key
        .as_deref()
        .and_then(|stable_key| state.find_by_stable_key(stable_key))
        .or_else(|| state.find_by_annotation_id(&annotation_id));
    if let Some(index) = shape_index {
        let shape = state.shapes[index].clone();
        incremental.opt_clone_object_to_new_document(object_id)?;
        let dict = incremental.new_document.get_dictionary_mut(object_id)?;
        let modified = update_shape_annotation_dict(
            dict,
            &shape,
            page_view,
            page_rotation,
            modified_at,
        )?;
        state.consume(index);
        return Ok(modified);
    }
    if annotation_stable_key.is_some() && rewrite_shape_state {
        collect_shape_annotation_refs_to_delete(
            incremental.get_prev_documents(),
            refs_to_delete,
            object_id,
        )?;
        return Ok(true);
    }
    Ok(false)
}

fn remove_shape_refs_from_pages(
    document: &mut Document,
    refs_to_delete: &HashSet<ObjectId>,
) -> Result<bool> {
    if refs_to_delete.is_empty() {
        return Ok(false);
    }
    let page_map = document.get_pages();
    let mut removed_any = false;
    for page_id in page_map.values().copied() {
        let annots = get_page_annots(document, page_id)?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, refs_to_delete);
        if !removed {
            continue;
        }
        let page = document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }
    Ok(removed_any)
}

fn remove_shape_refs_from_pages_incremental(
    incremental: &mut IncrementalDocument,
    refs_to_delete: &HashSet<ObjectId>,
) -> Result<bool> {
    if refs_to_delete.is_empty() {
        return Ok(false);
    }
    let page_map = incremental.get_prev_documents().get_pages();
    let mut removed_any = false;
    for page_id in page_map.values().copied() {
        let annots = get_page_annots(&incremental.new_document, page_id)
            .or_else(|_| get_page_annots(incremental.get_prev_documents(), page_id))?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, refs_to_delete);
        if !removed {
            continue;
        }
        incremental.opt_clone_object_to_new_document(page_id)?;
        let page = incremental.new_document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }
    Ok(removed_any)
}

fn append_remaining_shape_annotations(
    document: &mut Document,
    shapes: Vec<ShapeAnnotation>,
    modified_at: &str,
) -> Result<bool> {
    let page_map = document.get_pages();
    let mut modified = false;
    for shape in shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let dict = create_shape_annotation_dict(&shape, page_view, page_rotation, modified_at)?;
        let object_id = document.add_object(Object::Dictionary(dict));
        append_annots_to_page(document, page_id, &[object_id])?;
        modified = true;
    }
    Ok(modified)
}

fn append_remaining_shape_annotations_incremental(
    incremental: &mut IncrementalDocument,
    shapes: Vec<ShapeAnnotation>,
    modified_at: &str,
) -> Result<bool> {
    let page_map = incremental.get_prev_documents().get_pages();
    let mut modified = false;
    for shape in shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        let page_id = resolve_page_id(&page_map, page_number)?;
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let dict = create_shape_annotation_dict(&shape, page_view, page_rotation, modified_at)?;
        let object_id = incremental.new_document.add_object(Object::Dictionary(dict));
        append_annots_to_page_incremental(incremental, page_id, &[object_id])?;
        modified = true;
    }
    Ok(modified)
}

fn apply_shape_annotations(
    document: &mut Document,
    shapes: &ShapesMutation,
    modified_at: &str,
) -> Result<()> {
    assert_mutation_page_count(document, shapes.total_pages, "Shape mutation")?;
    let page_map = document.get_pages();
    let mut state = ShapeConsumptionState::new(&shapes.shapes);
    let deleted_refs = collect_deleted_shape_refs(shapes);
    let mut refs_to_delete = HashSet::new();
    let mut modified = false;
    for page_id in page_map.values().copied() {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let annots = get_page_annots(document, page_id)?;
        for object_id in annots.iter().filter_map(|object| object.as_reference().ok()) {
            modified = apply_shape_annotation_decision(
                document,
                &mut state,
                &deleted_refs,
                &mut refs_to_delete,
                shapes.rewrite_shape_state,
                page_view,
                page_rotation,
                object_id,
                modified_at,
            )? || modified;
        }
    }
    modified = remove_shape_refs_from_pages(document, &refs_to_delete)? || modified;
    let remaining = state.remaining().cloned().collect::<Vec<_>>();
    modified = append_remaining_shape_annotations(document, remaining, modified_at)? || modified;
    if !modified
        && (shapes.rewrite_shape_state
            || !shapes.shapes.is_empty()
            || !shapes.deleted_annotation_ids.is_empty()
            || !shapes.deleted_stable_keys.is_empty())
    {
        return Err("Shape mutation did not modify the document".into());
    }
    Ok(())
}

fn apply_shape_annotations_incremental(
    incremental: &mut IncrementalDocument,
    shapes: &ShapesMutation,
    modified_at: &str,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        shapes.total_pages,
        "Shape mutation",
    )?;
    let page_map = incremental.get_prev_documents().get_pages();
    let mut state = ShapeConsumptionState::new(&shapes.shapes);
    let deleted_refs = collect_deleted_shape_refs(shapes);
    let mut refs_to_delete = HashSet::new();
    let mut modified = false;
    for page_id in page_map.values().copied() {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let annots = get_page_annots(incremental.get_prev_documents(), page_id)?;
        for object_id in annots.iter().filter_map(|object| object.as_reference().ok()) {
            modified = apply_shape_annotation_decision_incremental(
                incremental,
                &mut state,
                &deleted_refs,
                &mut refs_to_delete,
                shapes.rewrite_shape_state,
                page_view,
                page_rotation,
                object_id,
                modified_at,
            )? || modified;
        }
    }
    modified = remove_shape_refs_from_pages_incremental(incremental, &refs_to_delete)? || modified;
    let remaining = state.remaining().cloned().collect::<Vec<_>>();
    modified = append_remaining_shape_annotations_incremental(incremental, remaining, modified_at)? || modified;
    if !modified
        && (shapes.rewrite_shape_state
            || !shapes.shapes.is_empty()
            || !shapes.deleted_annotation_ids.is_empty()
            || !shapes.deleted_stable_keys.is_empty())
    {
        return Err("Shape mutation did not modify the document".into());
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
    let expected_len = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages).len() * 2;
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
    let normalized =
        normalize_bookmark_entries(&bookmarks.items, bookmarks.total_pages, &bookmarks.untitled_label);
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
                    return Err("Deleted stable-key shape is still referenced from page Annots".into());
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

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object};
    use std::{
        fs::{read, remove_file, write},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn create_test_document() -> (Document, ObjectId) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }

    fn crop_box(document: &Document, page_id: ObjectId) -> Vec<f64> {
        document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap() as f64)
            .collect()
    }

    fn string_bytes(document: &Document, object_id: ObjectId, key: &[u8]) -> Vec<u8> {
        document
            .get_dictionary(object_id)
            .unwrap()
            .get(key)
            .unwrap()
            .as_str()
            .unwrap()
            .to_vec()
    }

    fn catalog(document: &Document) -> &Dictionary {
        document.get_dictionary(catalog_id(document).unwrap()).unwrap()
    }

    fn temp_pdf_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("evb-pdf-page-ops-{label}-{unique}.pdf"))
    }

    fn create_test_note_pdf() -> (Document, ObjectId, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "FreeText",
            "Contents" => Object::string_literal("old target"),
            "Popup" => popup_id,
        });
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(target_id)]);

        (document, target_id, popup_id)
    }

    fn assert_approximately(left: f64, right: f64) {
        assert!(
            (left - right).abs() < 0.01,
            "expected {left} to be approximately {right}"
        );
    }

    fn rectangle_shape(stable_key: &str, color: &str) -> ShapeAnnotation {
        ShapeAnnotation {
            shape_type: "rectangle".to_string(),
            page_index: 0,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.2,
            x2: None,
            y2: None,
            color: color.to_string(),
            fill_color: Some("#abcdef".to_string()),
            opacity: 0.5,
            stroke_width: 3.0,
            points: Vec::new(),
            strokes: Vec::new(),
            annotation_id: None,
            stable_key: Some(stable_key.to_string()),
            pdf_subtype: None,
            line_start_style: None,
            line_end_style: None,
            created_at: Some(1_780_000_000_000),
            modified_at: Some(1_780_000_060_000),
        }
    }

    fn create_test_markup_pdf(subtype: &str) -> (Document, ObjectId, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let annot_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => subtype,
            "Rect" => vec![20.into(), 20.into(), 100.into(), 50.into()],
            "C" => vec![1.into(), 1.into(), 0.into()],
        });
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(annot_id)]);
        (document, page_id, annot_id)
    }

    #[test]
    fn crops_pages_using_inherited_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();

        assert_eq!(crop_box(&document, page_id), vec![2.0, 3.0, 199.0, 96.0]);
    }

    #[test]
    fn remove_crop_restores_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();
        remove_crop_from_pages(&mut document, &[1]).unwrap();

        assert_eq!(crop_box(&document, page_id), vec![0.0, 0.0, 200.0, 100.0]);
    }

    #[test]
    fn skips_crop_when_margins_consume_page() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 100.0,
                bottom: 0.0,
                left: 0.0,
                right: 0.0,
            },
        )
        .unwrap();

        assert!(document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }

    #[test]
    fn updates_note_text_on_target_and_popup() {
        let mut document = Document::with_version("1.7");
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "FreeText",
            "Contents" => Object::string_literal("old target"),
            "Popup" => popup_id,
        });

        update_annotation_text_by_ref(
            &mut document,
            target_id,
            "hello \u{1F642}",
            "D:20260609123456+03'00'",
        )
        .unwrap();

        assert_eq!(
            string_bytes(&document, target_id, b"Contents"),
            encode_pdf_text_string("hello \u{1F642}")
        );
        assert_eq!(
            string_bytes(&document, popup_id, b"Contents"),
            encode_pdf_text_string("hello \u{1F642}")
        );
        assert_eq!(
            string_bytes(&document, target_id, b"M"),
            b"D:20260609123456+03'00'".to_vec()
        );
    }

    #[test]
    fn updates_popup_parent_when_target_is_popup() {
        let mut document = Document::with_version("1.7");
        let parent_id = document.add_object(dictionary! {
            "Subtype" => "Text",
            "Contents" => Object::string_literal("old parent"),
        });
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
            "Parent" => parent_id,
        });

        update_annotation_text_by_ref(&mut document, popup_id, "edited", "D:20260609123456Z")
            .unwrap();

        assert_eq!(
            string_bytes(&document, popup_id, b"Contents"),
            encode_pdf_text_string("edited")
        );
        assert_eq!(
            string_bytes(&document, parent_id, b"Contents"),
            encode_pdf_text_string("edited")
        );
    }

    #[test]
    fn reports_missing_note_text_update_targets() {
        let mut document = Document::with_version("1.7");
        let updates = vec![NoteTextUpdate {
            object_number: 404,
            generation_number: 0,
            text: "missing".to_string(),
        }];

        assert!(update_note_text(&mut document, &updates, "D:20260609123456Z").is_err());
    }

    #[test]
    fn appends_note_text_update_as_incremental_revision() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let input_path = temp_pdf_path("append-input");
        let output_path = temp_pdf_path("append-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_text_update(
            &input_path,
            &output_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        assert_eq!(
            string_bytes(&loaded, target_id, b"Contents"),
            encode_pdf_text_string("incremental hello")
        );
        assert_eq!(
            string_bytes(&loaded, popup_id, b"Contents"),
            encode_pdf_text_string("incremental hello")
        );

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn append_note_text_update_requires_output_copy() {
        let (mut document, target_id, _) = create_test_note_pdf();
        let input_path = temp_pdf_path("append-copy-input");
        let output_path = temp_pdf_path("append-copy-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        let wrong_same_size_bytes = vec![b'x'; original_bytes.len()];
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &wrong_same_size_bytes).unwrap();

        let error = append_note_text_update(
            &input_path,
            &output_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
            "D:20260609123456+03'00'",
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("byte-for-byte copy"));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_note_text_update_when_input_and_output_are_same_file() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("append-in-place");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_text_update(
            &pdf_path,
            &pdf_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "same path update".to_string(),
            }],
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&pdf_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());

        let loaded = Document::load(&pdf_path).unwrap();
        assert_eq!(
            string_bytes(&loaded, target_id, b"Contents"),
            encode_pdf_text_string("same path update")
        );
        assert_eq!(
            string_bytes(&loaded, popup_id, b"Contents"),
            encode_pdf_text_string("same path update")
        );

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_annotation_delete_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "Text",
            "Contents" => Object::string_literal("note"),
            "Popup" => popup_id,
        });
        let unrelated_id = document.add_object(dictionary! {
            "Subtype" => "Highlight",
            "Contents" => Object::string_literal("keep"),
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![
                Object::Reference(target_id),
                Object::Reference(popup_id),
                Object::Reference(unrelated_id),
            ],
        );
        let input_path = temp_pdf_path("append-delete-input");
        let output_path = temp_pdf_path("append-delete-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_changes(
            &input_path,
            &output_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(target_id.0),
                    generation_number: Some(target_id.1),
                    stable_key: None,
                    created_at: None,
                }],
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect();
        assert!(!refs.contains(&target_id));
        assert!(!refs.contains(&popup_id));
        assert!(refs.contains(&unrelated_id));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_free_text_note_delete_by_stable_key_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-free-text-delete-stable-key");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "delete me".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: Some(1781009077000),
                }],
                deletes: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: None,
                    generation_number: None,
                    stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                    created_at: Some(1781009077000),
                }],
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect();
        assert!(refs.iter().all(|object_id| {
            !annotation_matches_stable_delete_name(
                &loaded,
                *object_id,
                &AnnotationDelete {
                    page_index: 0,
                    object_number: None,
                    generation_number: None,
                    stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                    created_at: Some(1781009077000),
                },
            )
            .unwrap()
        }));

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_free_text_note_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-free-text-input");
        let output_path = temp_pdf_path("append-free-text-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_changes(
            &input_path,
            &output_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "native editor note".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: Some("Tester".to_string()),
                    color: Some("rgba(255, 204, 0, 0.8)".to_string()),
                    created_at: Some(1781009077000),
                }],
                deletes: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let free_text_ref = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "freetext")
                    .unwrap_or(false)
            })
            .unwrap();
        let popup_ref = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "popup")
                    .unwrap_or(false)
            })
            .unwrap();
        let free_text = loaded.get_dictionary(free_text_ref).unwrap();
        let popup = loaded.get_dictionary(popup_ref).unwrap();
        let rect = parse_rect(free_text.get(b"Rect").unwrap()).unwrap();

        assert_eq!(
            string_bytes(&loaded, free_text_ref, b"Contents"),
            encode_pdf_text_string("native editor note")
        );
        assert_eq!(
            string_bytes(&loaded, popup_ref, b"Contents"),
            encode_pdf_text_string("native editor note")
        );
        assert_eq!(
            pdf_string_to_text(free_text.get(b"NM").unwrap()).unwrap(),
            "evb-note:uid:0:pdfjs_internal_editor_0:created:1781009077000"
        );
        assert_eq!(annotation_related_ref(free_text, b"Popup"), Some(popup_ref));
        assert_eq!(
            annotation_related_ref(popup, b"Parent"),
            Some(free_text_ref)
        );
        assert!(free_text.get(b"AP").is_ok());
        assert_approximately(rect.width(), 0.32);
        assert_approximately(rect.height(), 0.16);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn repeated_free_text_note_append_updates_existing_named_note() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-free-text-repeat");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "first text".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: None,
                }],
                deletes: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();
        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "second text".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: None,
                }],
                deletes: Vec::new(),
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let free_text_refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .filter(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "freetext")
                    .unwrap_or(false)
            })
            .collect();

        assert_eq!(free_text_refs.len(), 1);
        assert_eq!(
            string_bytes(&loaded, free_text_refs[0], b"Contents"),
            encode_pdf_text_string("second text")
        );

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_markup_subtype_rewrite_as_incremental_revision() {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
        let input_path = temp_pdf_path("append-markup-input");
        let output_path = temp_pdf_path("append-markup-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: None,
                markup: Some(MarkupMutation {
                    overrides: Vec::new(),
                    hints: vec![MarkupSubtypeHint {
                        subtype: "Squiggly".to_string(),
                        page_index: 0,
                        marker_rect: MarkerRect {
                            left: 0.1,
                            top: 0.5,
                            width: 0.4,
                            height: 0.3,
                        },
                        annotation_id: Some(format_pdfjs_annotation_ref(markup_id)),
                        color: Some("#00ff00".to_string()),
                        id: None,
                        page_markup_index: Some(0),
                        source: Some("editor-live".to_string()),
                    }],
                }),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let markup = loaded.get_dictionary(markup_id).unwrap();
        assert_eq!(canonical_markup_subtype(markup).as_deref(), Some("Squiggly"));
        assert!(markup.get(b"QuadPoints").is_ok());
        assert!(markup.get(b"AP").is_ok());
        let color = markup.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 0.0);
        assert_approximately(color[1].as_float().unwrap() as f64, 1.0);
        assert_approximately(color[2].as_float().unwrap() as f64, 0.0);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_highlight_color_rewrite_as_display_rgb() {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
        let pdf_path = temp_pdf_path("append-highlight-color");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: None,
                markup: Some(MarkupMutation {
                    overrides: Vec::new(),
                    hints: vec![MarkupSubtypeHint {
                        subtype: "Highlight".to_string(),
                        page_index: 0,
                        marker_rect: MarkerRect {
                            left: 0.1,
                            top: 0.5,
                            width: 0.4,
                            height: 0.3,
                        },
                        annotation_id: Some(format_pdfjs_annotation_ref(markup_id)),
                        color: Some("#ff0000".to_string()),
                        id: None,
                        page_markup_index: Some(0),
                        source: Some("pdf".to_string()),
                    }],
                }),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let markup = loaded.get_dictionary(markup_id).unwrap();
        let color = markup.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 1.0);
        assert_approximately(color[1].as_float().unwrap() as f64, 166.0 / 255.0);
        assert_approximately(color[2].as_float().unwrap() as f64, 166.0 / 255.0);
        assert_eq!(markup.get(b"CA").unwrap().as_i64().unwrap(), 1);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_managed_shape_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-shape-input");
        let output_path = temp_pdf_path("append-shape-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![rectangle_shape("evb-shape:rect-1", "#336699")],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: Vec::new(),
                }),
                markup: None,
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        assert_eq!(annots.len(), 1);
        let shape_ref = annots[0].as_reference().unwrap();
        let shape = loaded.get_dictionary(shape_ref).unwrap();
        assert_eq!(annotation_subtype(shape), "square");
        assert_eq!(
            read_managed_shape_stable_key(shape).as_deref(),
            Some("evb-shape:rect-1")
        );
        assert_eq!(
            pdf_string_to_text(shape.get(b"EVBShapeKey").unwrap()).unwrap(),
            "evb-shape:rect-1"
        );
        assert!(shape.get(b"Rect").is_ok());
        assert!(shape.get(b"C").is_ok());
        assert!(shape.get(b"IC").is_ok());
        assert_eq!(shape.get(b"CA").unwrap().as_float().unwrap(), 0.5);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn updates_and_deletes_managed_shapes_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-shape-update-delete");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![
                        rectangle_shape("evb-shape:keep", "#336699"),
                        rectangle_shape("evb-shape:delete", "#ff0000"),
                    ],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: Vec::new(),
                }),
                markup: None,
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let mut updated = rectangle_shape("evb-shape:keep", "#112233");
        updated.x = 0.2;
        updated.y = 0.25;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![updated],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: vec!["evb-shape:delete".to_string()],
                }),
                markup: None,
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let shape_refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .filter(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| is_supported_shape_subtype(&annotation_subtype(dict)))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(shape_refs.len(), 1);
        let shape = loaded.get_dictionary(shape_refs[0]).unwrap();
        assert_eq!(
            read_managed_shape_stable_key(shape).as_deref(),
            Some("evb-shape:keep")
        );
        let color = shape.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 0x11 as f64 / 255.0);
        assert!(annots.iter().all(|object| {
            object
                .as_reference()
                .ok()
                .and_then(|object_id| loaded.get_dictionary(object_id).ok())
                .and_then(read_managed_shape_stable_key)
                .as_deref()
                != Some("evb-shape:delete")
        }));

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_page_labels_and_bookmarks_as_incremental_revision() {
        let (mut document, _page_id) = create_test_document();
        let input_path = temp_pdf_path("append-metadata-input");
        let output_path = temp_pdf_path("append-metadata-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: Some(PageLabelsMutation {
                    total_pages: 1,
                    ranges: vec![PageLabelRange {
                        start_page: 1,
                        style: Some("r".to_string()),
                        prefix: "intro-".to_string(),
                        start_number: 3,
                    }],
                }),
                bookmarks: Some(BookmarksMutation {
                    total_pages: 1,
                    untitled_label: "Untitled".to_string(),
                    items: vec![BookmarkEntry {
                        title: "Chapter 1".to_string(),
                        page_index: Some(0),
                        named_dest: None,
                        bold: true,
                        italic: false,
                        color: Some("#336699".to_string()),
                        items: Vec::new(),
                    }],
                }),
                shapes: None,
                markup: None,
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let page_labels = resolve_dictionary_object(
            &loaded,
            catalog(&loaded).get(b"PageLabels").unwrap(),
            "PageLabels",
        )
        .unwrap();
        let nums = page_labels.get(b"Nums").unwrap().as_array().unwrap();
        assert_eq!(nums.len(), 2);
        let range = nums[1].as_dict().unwrap();
        assert_eq!(range.get(b"S").unwrap().as_name().unwrap(), b"r");
        assert_eq!(
            pdf_string_to_text(range.get(b"P").unwrap()).unwrap(),
            "intro-"
        );
        assert_eq!(range.get(b"St").unwrap().as_i64().unwrap(), 3);

        let outlines_ref = catalog(&loaded)
            .get(b"Outlines")
            .unwrap()
            .as_reference()
            .unwrap();
        let outlines = loaded.get_dictionary(outlines_ref).unwrap();
        assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 1);
        let first_ref = outlines.get(b"First").unwrap().as_reference().unwrap();
        let first = loaded.get_dictionary(first_ref).unwrap();
        assert_eq!(
            pdf_string_to_text(first.get(b"Title").unwrap()).unwrap(),
            "Chapter 1"
        );
        assert!(first.get(b"Dest").is_ok());
        assert_eq!(first.get(b"F").unwrap().as_i64().unwrap(), 2);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_metadata_removal_as_incremental_revision() {
        let (mut document, _page_id) = create_test_document();
        set_page_labels(
            &mut document,
            &PageLabelsMutation {
                total_pages: 1,
                ranges: vec![PageLabelRange {
                    start_page: 1,
                    style: Some("A".to_string()),
                    prefix: "old-".to_string(),
                    start_number: 2,
                }],
            },
        )
        .unwrap();
        set_bookmarks(
            &mut document,
            &BookmarksMutation {
                total_pages: 1,
                untitled_label: "Untitled".to_string(),
                items: vec![BookmarkEntry {
                    title: "Old".to_string(),
                    page_index: Some(0),
                    named_dest: None,
                    bold: false,
                    italic: false,
                    color: None,
                    items: Vec::new(),
                }],
            },
        )
        .unwrap();

        let pdf_path = temp_pdf_path("append-metadata-removal");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: Some(PageLabelsMutation {
                    total_pages: 1,
                    ranges: vec![PageLabelRange {
                        start_page: 1,
                        style: Some("D".to_string()),
                        prefix: String::new(),
                        start_number: 1,
                    }],
                }),
                bookmarks: Some(BookmarksMutation {
                    total_pages: 1,
                    untitled_label: "Untitled".to_string(),
                    items: Vec::new(),
                }),
                shapes: None,
                markup: None,
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let catalog = catalog(&loaded);
        assert!(catalog.get(b"PageLabels").is_err());
        assert!(catalog.get(b"Outlines").is_err());

        let _ = remove_file(pdf_path);
    }
}
