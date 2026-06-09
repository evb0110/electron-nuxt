use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use serde::Deserialize;
use std::{
    collections::HashSet,
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
}
