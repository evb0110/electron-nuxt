use super::*;
use evb_native_support::output::AtomicOutput;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    path::Path,
};

pub(crate) const ANNOTATION_PARSE_FORMAT: &str = "evb-pdf-annotation-parse";
pub(crate) const ANNOTATION_PARSE_SCHEMA_VERSION: u64 = 1;
pub(crate) const ANNOTATION_PARSE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGE_ANNOTATIONS: usize = 100_000;
const MAX_ANNOTATION_REPLIES: usize = 4_096;
const MARKER_RECT_THRESHOLD: f64 = 0.02;
const MARKER_RECT_EPSILON: f64 = f64::EPSILON * 16.0;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseTextBox {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) text: String,
    pub(crate) rect: MarkerRect,
    pub(crate) rotation: i64,
    pub(crate) font_size: f64,
    pub(crate) color: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseReply {
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) contents: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseNote {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) position: MarkerRect,
    pub(crate) contents: String,
    pub(crate) color: Option<String>,
    pub(crate) open: bool,
    pub(crate) replies: Vec<PdfAnnotationParseReply>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseForeign {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) subtype: String,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum PdfAnnotationParseEntry {
    TextBox(PdfAnnotationParseTextBox),
    Note(PdfAnnotationParseNote),
    Foreign(PdfAnnotationParseForeign),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AnnotationParseScan {
    pub(crate) page_count: u64,
    pub(crate) entry_count: u64,
}

/// Scan the document one page at a time. The callback receives only the
/// current entry, so callers can stream a large document without retaining its
/// entity set in the renderer or native process.
pub(crate) fn scan_parsed_annotations<F>(
    document: &impl PdfObjectSource,
    modified_at: &str,
    mut on_entry: F,
) -> Result<AnnotationParseScan>
where
    F: FnMut(PdfAnnotationParseEntry) -> Result<()>,
{
    let resolver = PageTreeResolver::new(document)?;
    let mut scan = AnnotationParseScan::default();
    let mut page_index = 0_u64;
    let mut existing_names = HashSet::new();
    scan.page_count = resolver.for_each_page_id_with_count(document, |page_id| {
        let current_page_index = page_index;
        scan_page_annotations(
            document,
            page_id,
            current_page_index,
            modified_at,
            &mut on_entry,
            &mut scan.entry_count,
            &mut existing_names,
        )?;
        page_index = page_index
            .checked_add(1)
            .ok_or("PDF annotation parse page index overflow")?;
        Ok(())
    })?;
    Ok(scan)
}

/// Write the parse result as the same bounded JSONL envelope used by the
/// existing annotation sidecars. `sink` is called for each header or chunk and
/// owns the destination-specific byte limit.
pub(crate) fn write_annotation_parse_stream<F>(
    document: &impl PdfObjectSource,
    modified_at: &str,
    chunk_limit: usize,
    mut sink: F,
) -> Result<AnnotationParseScan>
where
    F: FnMut(&[u8]) -> Result<()>,
{
    if !(64..=ANNOTATION_PARSE_CHUNK_BYTES).contains(&chunk_limit) {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Annotation parse chunk limit must fit its JSON envelope and stay within 4 MiB",
        ));
    }
    let page_count = u64::from(PageTreeResolver::new(document)?.page_count());
    let header = format!(
        "{{\"format\":\"{ANNOTATION_PARSE_FORMAT}\",\"schemaVersion\":{ANNOTATION_PARSE_SCHEMA_VERSION},\"pageCount\":{page_count},\"chunkBytes\":{chunk_limit}}}\n"
    );
    sink(header.as_bytes())?;

    let mut chunk = AnnotationParseChunk::new(0);
    let mut next_chunk_index = 0_u64;
    let scan = scan_parsed_annotations(document, modified_at, |entry| {
        let encoded_entry = serde_json::to_vec(&entry)?;
        if !chunk.try_push(&encoded_entry, chunk_limit) {
            if chunk.entry_count == 0 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse entry exceeds the 4 MiB chunk limit",
                ));
            }
            next_chunk_index = next_chunk_index
                .checked_add(1)
                .ok_or("Annotation parse chunk number overflow")?;
            let finished_chunk =
                std::mem::replace(&mut chunk, AnnotationParseChunk::new(next_chunk_index)).finish();
            sink(&finished_chunk)?;
            if !chunk.try_push(&encoded_entry, chunk_limit) {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse entry exceeds the 4 MiB chunk limit",
                ));
            }
        }
        Ok(())
    })?;
    if chunk.entry_count > 0 {
        sink(&chunk.finish())?;
    }
    Ok(scan)
}

pub(crate) fn write_annotation_parse_path(
    input_path: &Path,
    output_path: &Path,
    modified_at: &str,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    if annotation_index_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Annotation parse output must not alias the PDF input",
        ));
    }

    let incremental = load_annotation_index_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by the annotation parse operation",
        ));
    }

    let mut output = AtomicOutput::create(output_path)?;
    #[cfg(unix)]
    output
        .file()?
        .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    let mut total_bytes = 0_u64;
    write_annotation_parse_stream(
        &AppendedRevision::new(&incremental),
        modified_at,
        ANNOTATION_PARSE_CHUNK_BYTES,
        |bytes| {
            let next_total = total_bytes
                .checked_add(u64::try_from(bytes.len())?)
                .ok_or("Annotation parse sidecar byte count overflow")?;
            if next_total > u64::try_from(MAX_SIDECAR_BYTES)? {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse exceeds the sidecar byte limit",
                ));
            }
            output.file_mut()?.write_all(bytes)?;
            total_bytes = next_total;
            Ok(())
        },
    )?;
    output.publish()?;
    Ok(())
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn serialize_annotation_parse(
    document: &impl PdfObjectSource,
    modified_at: &str,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    write_annotation_parse_stream(
        document,
        modified_at,
        ANNOTATION_PARSE_CHUNK_BYTES,
        |bytes| {
            let next_len = output
                .len()
                .checked_add(bytes.len())
                .ok_or("Annotation parse output length overflow")?;
            if next_len > max_bytes {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse WASM output exceeds the admission ceiling",
                ));
            }
            output.try_reserve(bytes.len()).map_err(|_| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse WASM output exceeds the admission ceiling",
                )
            })?;
            output.extend_from_slice(bytes);
            Ok(())
        },
    )?;
    Ok(output)
}

#[cfg(test)]
pub(crate) fn collect_parsed_annotations(
    document: &impl PdfObjectSource,
    modified_at: &str,
) -> Result<Vec<PdfAnnotationParseEntry>> {
    let mut entries = Vec::new();
    scan_parsed_annotations(document, modified_at, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    Ok(entries)
}

#[derive(Clone, Copy)]
struct PageAnnotation<'a> {
    object_id: Option<ObjectId>,
    dict: &'a Dictionary,
}

fn scan_page_annotations<F>(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    page_index: u64,
    modified_at: &str,
    on_entry: &mut F,
    entry_count: &mut u64,
    existing_names: &mut HashSet<String>,
) -> Result<()>
where
    F: FnMut(PdfAnnotationParseEntry) -> Result<()>,
{
    let page_view = resolve_page_view(document, page_id)?;
    let page_rotation = resolve_page_rotation(document, page_id)?;
    let annots = get_page_annots(document, page_id)?;
    if annots.len() > MAX_PAGE_ANNOTATIONS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "PDF page annotation array exceeds the admission ceiling",
        ));
    }

    let mut page_annotations = Vec::with_capacity(annots.len());
    for object in &annots {
        if let Ok(object_id) = object.as_reference() {
            let dict = document.dictionary(object_id)?;
            page_annotations.push(PageAnnotation {
                object_id: Some(object_id),
                dict,
            });
        } else if let Ok(dict) = object.as_dict() {
            // Direct dictionaries have no durable object reference. They still
            // get a deterministic 0R0 identity and remain visible to callers.
            page_annotations.push(PageAnnotation {
                object_id: None,
                dict,
            });
        }
    }

    let mut object_indexes = HashMap::with_capacity(page_annotations.len());
    for (index, annotation) in page_annotations.iter().enumerate() {
        if let Some(object_id) = annotation.object_id {
            object_indexes.insert(object_id, index);
        }
    }

    let mut reply_children: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    for annotation in &page_annotations {
        let (Some(reply_id), Some(parent_id)) = (
            annotation.object_id,
            annotation_related_ref(annotation.dict, b"IRT"),
        ) else {
            continue;
        };
        if object_indexes.contains_key(&parent_id) {
            reply_children.entry(parent_id).or_default().push(reply_id);
        }
    }

    let mut note_ids = HashSet::new();
    for annotation in &page_annotations {
        let Some(object_id) = annotation.object_id else {
            continue;
        };
        if annotation_related_ref(annotation.dict, b"IRT").is_some() {
            continue;
        }
        let subtype = annotation_subtype_name(document, annotation.dict);
        let is_note = subtype.eq_ignore_ascii_case("Text")
            || (subtype.eq_ignore_ascii_case("FreeText")
                && is_free_text_note_marker(document, annotation.dict, page_view, page_rotation));
        if is_note {
            note_ids.insert(object_id);
        }
    }

    let reply_ids = collect_reply_ids(&reply_children, &note_ids);
    for annotation in &page_annotations {
        let subtype = annotation_subtype_name(document, annotation.dict);
        if subtype.eq_ignore_ascii_case("Popup")
            || annotation
                .object_id
                .is_some_and(|object_id| reply_ids.contains(&object_id))
        {
            continue;
        }

        let object_id = annotation.object_id.unwrap_or((0, 0));
        let name = resolve_or_mint_name(
            annotation.dict,
            existing_names,
            page_index,
            object_id,
            &subtype,
            modified_at,
        );
        existing_names.insert(name.clone());

        let entry = match subtype.to_ascii_lowercase().as_str() {
            "text" => parse_note_entry(
                document,
                annotation.dict,
                object_id,
                page_index,
                page_view,
                page_rotation,
                &name,
                &reply_children,
                &object_indexes,
                &page_annotations,
            )
            .map(PdfAnnotationParseEntry::Note),
            "freetext" => {
                if is_free_text_note_marker(document, annotation.dict, page_view, page_rotation) {
                    parse_note_entry(
                        document,
                        annotation.dict,
                        object_id,
                        page_index,
                        page_view,
                        page_rotation,
                        &name,
                        &reply_children,
                        &object_indexes,
                        &page_annotations,
                    )
                    .map(PdfAnnotationParseEntry::Note)
                } else {
                    parse_text_box_entry(
                        document,
                        annotation.dict,
                        object_id,
                        page_index,
                        page_view,
                        page_rotation,
                        &name,
                    )
                    .map(PdfAnnotationParseEntry::TextBox)
                }
            }
            _ => Err(format!("Unsupported annotation subtype /{subtype}")),
        };

        let entry = entry.unwrap_or_else(|reason| {
            PdfAnnotationParseEntry::Foreign(PdfAnnotationParseForeign {
                page_index,
                object_number: u64::from(object_id.0),
                generation_number: u64::from(object_id.1),
                name,
                subtype: if subtype.is_empty() {
                    "Unknown".to_string()
                } else {
                    subtype
                },
                reason: truncate_reason(&reason),
            })
        });
        on_entry(entry)?;
        *entry_count = entry_count
            .checked_add(1)
            .ok_or("PDF annotation parse entry count overflow")?;
    }
    Ok(())
}

fn parse_text_box_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
) -> std::result::Result<PdfAnnotationParseTextBox, String> {
    let rect = read_annotation_rect(document, dict)?;
    let rect = pdf_rect_to_marker_rect(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    if dict.get(b"Contents").is_err() && dict.get(b"RC").is_ok() {
        return Err("FreeText has rich text without plain text contents".to_string());
    }
    let text = read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default();
    let (font_size, color) = parse_default_appearance(document, dict)?;
    let rotation = read_optional_integer(document, dict, b"Rotate")?.unwrap_or(0);
    let rotation = normalize_page_rotation(rotation);
    Ok(PdfAnnotationParseTextBox {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        text,
        rect,
        rotation,
        font_size,
        color,
    })
}

#[allow(clippy::too_many_arguments)]
fn parse_note_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
    reply_children: &HashMap<ObjectId, Vec<ObjectId>>,
    object_indexes: &HashMap<ObjectId, usize>,
    page_annotations: &[PageAnnotation<'_>],
) -> std::result::Result<PdfAnnotationParseNote, String> {
    let rect = read_annotation_rect(document, dict)?;
    let position = pdf_rect_to_marker_rect(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    let contents = read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default();
    let color = read_annotation_color(document, dict);
    let open = read_optional_boolean(document, dict, b"Open")?.unwrap_or(false);
    let replies = parse_replies(
        document,
        object_id,
        reply_children,
        object_indexes,
        page_annotations,
    )?;
    Ok(PdfAnnotationParseNote {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        position,
        contents,
        color,
        open,
        replies,
    })
}

fn parse_replies(
    document: &impl PdfObjectSource,
    note_id: ObjectId,
    reply_children: &HashMap<ObjectId, Vec<ObjectId>>,
    object_indexes: &HashMap<ObjectId, usize>,
    page_annotations: &[PageAnnotation<'_>],
) -> std::result::Result<Vec<PdfAnnotationParseReply>, String> {
    let mut replies = Vec::new();
    let mut pending = reply_children
        .get(&note_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<VecDeque<_>>();
    let mut seen = HashSet::new();
    while let Some(reply_id) = pending.pop_front() {
        if !seen.insert(reply_id) {
            continue;
        }
        if replies.len() >= MAX_ANNOTATION_REPLIES {
            return Err("Annotation reply chain exceeds the admission ceiling".to_string());
        }
        let Some(index) = object_indexes.get(&reply_id).copied() else {
            continue;
        };
        let annotation = page_annotations
            .get(index)
            .ok_or_else(|| "Annotation reply reference is out of range".to_string())?;
        replies.push(PdfAnnotationParseReply {
            object_number: u64::from(reply_id.0),
            generation_number: u64::from(reply_id.1),
            contents: read_optional_annotation_text(document, annotation.dict, b"Contents")?
                .unwrap_or_default(),
            author: read_optional_annotation_author(document, annotation.dict)?,
            created_at: read_annotation_date(document, annotation.dict, b"CreationDate"),
            modified_at: read_annotation_date(document, annotation.dict, b"M"),
        });
        if let Some(children) = reply_children.get(&reply_id) {
            pending.extend(children.iter().copied());
        }
    }
    Ok(replies)
}

fn collect_reply_ids(
    reply_children: &HashMap<ObjectId, Vec<ObjectId>>,
    note_ids: &HashSet<ObjectId>,
) -> HashSet<ObjectId> {
    let mut reply_ids = HashSet::new();
    for note_id in note_ids {
        let mut pending = reply_children.get(note_id).cloned().unwrap_or_default();
        let mut note_reply_ids = HashSet::new();
        while let Some(reply_id) = pending.pop() {
            if !note_reply_ids.insert(reply_id) {
                continue;
            }
            reply_ids.insert(reply_id);
            if let Some(children) = reply_children.get(&reply_id) {
                pending.extend(children.iter().copied());
            }
        }
    }
    reply_ids
}

fn annotation_subtype_name(document: &impl PdfObjectSource, dict: &Dictionary) -> String {
    dict.get(b"Subtype")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_name().ok())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .unwrap_or_default()
}

fn read_annotation_rect(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<PdfRect, String> {
    let object = dict.get(b"Rect").map_err(|_| "Missing /Rect".to_string())?;
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    parse_rect(resolved).map_err(|error| error.to_string())
}

fn read_optional_annotation_text(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<String>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    if resolved.as_str().is_err() {
        return Err(format!(
            "/{} must be a PDF string",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(pdf_string_to_text(resolved).map(|value| {
        let trimmed = value.trim_matches('\0');
        if trimmed.is_empty() {
            String::new()
        } else {
            trimmed.to_string()
        }
    }))
}

fn read_optional_annotation_author(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<Option<String>, String> {
    Ok(read_optional_annotation_text(document, dict, b"T")?.filter(|value| !value.is_empty()))
}

fn read_optional_integer(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<i64>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    resolved.as_i64().map(Some).map_err(|error| {
        format!(
            "/{} must be an integer: {error}",
            String::from_utf8_lossy(key)
        )
    })
}

fn read_optional_boolean(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<bool>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    resolved.as_bool().map(Some).map_err(|error| {
        format!(
            "/{} must be a boolean: {error}",
            String::from_utf8_lossy(key)
        )
    })
}

fn read_annotation_date(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> Option<i64> {
    dict.get(key)
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(pdf_string_to_text)
        .and_then(|value| parse_pdf_date_timestamp(&value))
}

fn read_annotation_color(document: &impl PdfObjectSource, dict: &Dictionary) -> Option<String> {
    let object = dict.get(b"C").ok()?;
    let values = document.resolved(object).ok()?.as_array().ok()?;
    if values.is_empty() {
        return None;
    }
    let mut components = Vec::with_capacity(values.len());
    for value in values {
        let resolved = document.resolved(value).ok()?;
        let number = object_to_f64(resolved).ok()?;
        if !number.is_finite() {
            return None;
        }
        components.push(number);
    }
    Some(pdf_color_to_hex(Some(&components), "#000000"))
}

fn parse_default_appearance(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<(f64, String), String> {
    let object = dict
        .get(b"DA")
        .map_err(|_| "FreeText is missing /DA".to_string())?;
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    let bytes = resolved
        .as_str()
        .map_err(|_| "FreeText /DA must be a PDF string".to_string())?;
    let tokens = String::from_utf8_lossy(bytes)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut font_size = None;
    let mut color = None;
    for (index, token) in tokens.iter().enumerate() {
        match token.as_str() {
            "Tf" => {
                font_size = previous_numbers(&tokens, index, 1).first().copied();
            }
            "rg" => {
                let values = previous_numbers(&tokens, index, 3);
                if values.len() == 3 {
                    color = Some(pdf_color_to_hex(Some(&values), "#000000"));
                }
            }
            "g" => {
                let values = previous_numbers(&tokens, index, 1);
                if values.len() == 1 {
                    color = Some(pdf_color_to_hex(Some(&values), "#000000"));
                }
            }
            _ => {}
        }
    }
    let font_size = font_size
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 512.0)
        .ok_or_else(|| "FreeText /DA has no supported font size".to_string())?;
    let color = color.ok_or_else(|| "FreeText /DA has no supported color".to_string())?;
    Ok((font_size, color))
}

fn previous_numbers(tokens: &[String], operator_index: usize, count: usize) -> Vec<f64> {
    let mut values = Vec::with_capacity(count);
    for token in tokens[..operator_index].iter().rev() {
        let Ok(value) = token.parse::<f64>() else {
            if !values.is_empty() {
                break;
            }
            continue;
        };
        values.push(value);
        if values.len() == count {
            break;
        }
    }
    values.reverse();
    values
}

/// Return true only for the legacy FreeText note representation. The parser
/// and the later marker-rewrite writer share this predicate so the 0.02-point
/// compatibility rule cannot drift between read and edit paths.
pub(crate) fn is_free_text_note_marker(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_view: PdfRect,
    page_rotation: i64,
) -> bool {
    if !annotation_subtype_name(document, dict).eq_ignore_ascii_case("FreeText")
        || annotation_related_ref(dict, b"Popup").is_none()
    {
        return false;
    }
    let Ok(rect) = read_annotation_rect(document, dict) else {
        return false;
    };
    let Ok(marker_rect) = pdf_rect_to_marker_rect(rect, page_view, page_rotation) else {
        return false;
    };
    let marker_limit = MARKER_RECT_THRESHOLD + MARKER_RECT_EPSILON;
    if marker_rect.width > marker_limit || marker_rect.height > marker_limit {
        return false;
    }
    let Some(appearance) = dict
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())
        .and_then(|appearance| appearance.get(b"N").ok())
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_stream().ok())
    else {
        return false;
    };
    appearance.content.is_empty()
}

fn truncate_reason(reason: &str) -> String {
    const MAX_REASON_BYTES: usize = 256;
    if reason.len() <= MAX_REASON_BYTES {
        return reason.to_string();
    }
    reason
        .char_indices()
        .take_while(|(index, _)| *index < MAX_REASON_BYTES)
        .map(|(_, character)| character)
        .collect()
}

struct AnnotationParseChunk {
    bytes: Vec<u8>,
    entry_count: usize,
}

impl AnnotationParseChunk {
    fn new(index: u64) -> Self {
        Self {
            bytes: format!("{{\"chunkIndex\":{index},\"entries\":[").into_bytes(),
            entry_count: 0,
        }
    }

    fn try_push(&mut self, entry: &[u8], chunk_limit: usize) -> bool {
        let separator_bytes = usize::from(self.entry_count > 0);
        let Some(candidate_len) = self
            .bytes
            .len()
            .checked_add(separator_bytes)
            .and_then(|length| length.checked_add(entry.len()))
            .and_then(|length| length.checked_add(3))
        else {
            return false;
        };
        if candidate_len > chunk_limit {
            return false;
        }
        if separator_bytes != 0 {
            self.bytes.push(b',');
        }
        self.bytes.extend_from_slice(entry);
        self.entry_count += 1;
        true
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.extend_from_slice(b"]}\n");
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AnnotationParseProtocolFixture {
        format: String,
        schema_version: u64,
        page_count: u64,
        chunk_bytes: usize,
        chunk_index: u64,
        entries: Vec<PdfAnnotationParseEntry>,
    }

    fn text(value: &str) -> Object {
        Object::String(encode_pdf_text_string(value), StringFormat::Hexadecimal)
    }

    fn rect(left: f64, bottom: f64, right: f64, top: f64) -> Object {
        Object::Array(vec![
            number_object(left),
            number_object(bottom),
            number_object(right),
            number_object(top),
        ])
    }

    fn test_document() -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let mut annots = Vec::new();

        let note_id = document.new_object_id();
        let popup_id = document.new_object_id();
        document.set_object(
            note_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "NM" => text("note-name"),
                "Contents" => text("note contents"),
                "T" => text("Author"),
                "CreationDate" => Object::string_literal("D:20260830120000Z"),
                "M" => Object::string_literal("D:20260830120100Z"),
                "C" => vec![1.into(), 0.into(), 0.into()],
                "Open" => true,
                "Popup" => popup_id,
                "P" => page_id,
            },
        );
        document.set_object(
            popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => note_id,
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "P" => page_id,
            },
        );
        let reply_id = document.new_object_id();
        document.set_object(
            reply_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "IRT" => note_id,
                "Contents" => text("note reply"),
                "T" => text("Reply Author"),
                "M" => Object::string_literal("D:20260830120200Z"),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(note_id),
            Object::Reference(popup_id),
            Object::Reference(reply_id),
        ]);

        let second_note_id = document.new_object_id();
        let second_popup_id = document.new_object_id();
        document.set_object(
            second_note_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(40.0, 20.0, 60.0, 40.0),
                "NM" => text("note-name-two"),
                "Contents" => text("second note contents"),
                "T" => text("Second Author"),
                "Open" => false,
                "Popup" => second_popup_id,
                "P" => page_id,
            },
        );
        document.set_object(
            second_popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => second_note_id,
                "Rect" => rect(40.0, 20.0, 60.0, 40.0),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(second_note_id),
            Object::Reference(second_popup_id),
        ]);

        let marker_id = document.new_object_id();
        let marker_popup_id = document.new_object_id();
        let blank_ap_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => rect(0.0, 0.0, 0.0, 0.0),
            },
            Vec::new(),
        ));
        document.set_object(
            marker_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "FreeText",
                "Rect" => rect(0.0, 99.99, 0.01, 100.0),
                "NM" => text("marker-name"),
                "Contents" => text("legacy note"),
                "Popup" => marker_popup_id,
                "AP" => dictionary! {"N" => blank_ap_id},
                "P" => page_id,
            },
        );
        document.set_object(
            marker_popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => marker_id,
                "Rect" => rect(0.0, 99.99, 0.01, 100.0),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(marker_id),
            Object::Reference(marker_popup_id),
        ]);

        for (name, text_value, rect_value) in [
            ("text-box-one", "first box", rect(10.0, 10.0, 90.0, 30.0)),
            ("text-box-two", "second box", rect(100.0, 50.0, 190.0, 70.0)),
        ] {
            let text_box_id = document.new_object_id();
            document.set_object(
                text_box_id,
                dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "FreeText",
                    "Rect" => rect_value,
                    "NM" => text(name),
                    "Contents" => text(text_value),
                    "DA" => Object::string_literal("/Helv 12 Tf 0 0 1 rg"),
                    "P" => page_id,
                },
            );
            annots.push(Object::Reference(text_box_id));
        }

        let link_id = document.new_object_id();
        document.set_object(
            link_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => rect(1.0, 1.0, 2.0, 2.0),
                "P" => page_id,
            },
        );
        let widget_id = document.new_object_id();
        document.set_object(
            widget_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Widget",
                "Rect" => rect(3.0, 3.0, 4.0, 4.0),
                "P" => page_id,
            },
        );
        annots.extend([Object::Reference(link_id), Object::Reference(widget_id)]);

        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(annots),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    #[test]
    fn parses_text_boxes_notes_and_foreign_annotations() {
        let document = test_document();
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::Note(_)))
                .count(),
            3
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::TextBox(_)))
                .count(),
            2
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::Foreign(_)))
                .count(),
            2
        );
        let text_box = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::TextBox(value) if value.name == "text-box-one" => {
                    Some(value)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(text_box.text, "first box");
        assert_eq!(text_box.author, None);
        assert_eq!(text_box.created_at, None);
        assert_eq!(text_box.rect.left, 0.05);
        assert_eq!(text_box.rect.top, 0.7);
        assert_eq!(text_box.color, "#0000ff");
        let marker = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "marker-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(marker.contents, "legacy note");
        let first_note = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "note-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(first_note.author.as_deref(), Some("Author"));
        assert_eq!(first_note.created_at, Some(1_788_091_200_000));
        assert_eq!(first_note.modified_at, Some(1_788_091_260_000));
        assert_eq!(first_note.replies.len(), 1);
        assert_eq!(first_note.replies[0].contents, "note reply");
    }

    #[test]
    fn empty_annotation_color_array_is_reported_as_absent() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let note_id = get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("note-name")
            })
            .unwrap();
        document
            .get_dictionary_mut(note_id)
            .unwrap()
            .set("C", Object::Array(Vec::new()));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let note = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "note-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(note.color, None);
    }

    #[test]
    fn oversized_reply_chain_reports_the_note_as_foreign() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let mut annots = get_page_annots(&document, page_id).unwrap();
        let note_id = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("note-name")
            })
            .unwrap();

        for _ in 0..MAX_ANNOTATION_REPLIES {
            let reply_id = document.new_object_id();
            document.set_object(
                reply_id,
                dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Text",
                    "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                    "IRT" => note_id,
                    "Contents" => text("oversized reply"),
                    "P" => page_id,
                },
            );
            annots.push(Object::Reference(reply_id));
        }
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", Object::Array(annots));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 7);
        let note = entries
            .iter()
            .find(|entry| match entry {
                PdfAnnotationParseEntry::Foreign(value) => value.name == "note-name",
                _ => false,
            })
            .expect("the oversized note should be reported as foreign");
        let PdfAnnotationParseEntry::Foreign(note) = note else {
            unreachable!("the entry was selected by its foreign name");
        };
        assert!(note
            .reason
            .contains("reply chain exceeds the admission ceiling"));
    }

    #[test]
    fn duplicate_and_missing_names_get_distinct_deterministic_ids() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let mut annots = get_page_annots(&document, page_id).unwrap();
        let source_id = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("text-box-one")
            })
            .unwrap();
        let duplicate_id = document.new_object_id();
        let duplicate = document.get_dictionary(source_id).unwrap().clone();
        document.set_object(duplicate_id, Object::Dictionary(duplicate));
        annots.push(Object::Reference(duplicate_id));
        let missing_id = document.new_object_id();
        let mut missing = document.get_dictionary(source_id).unwrap().clone();
        missing.remove(b"NM");
        document.set_object(missing_id, Object::Dictionary(missing));
        annots.push(Object::Reference(missing_id));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("Annots", Object::Array(annots));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let names = entries
            .iter()
            .filter_map(|entry| match entry {
                PdfAnnotationParseEntry::TextBox(value) => Some(value.name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(names.contains(&"text-box-one".to_string()));
        assert_eq!(
            names.iter().filter(|name| *name == "text-box-one").count(),
            1
        );
        assert_eq!(names.len(), 4);
        assert_eq!(names.iter().filter(|name| name.len() == 36).count(), 2);
        let entries_again = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries, entries_again);
    }

    #[test]
    fn sidecar_has_bounded_jsonl_header_and_chunks() {
        let document = test_document();
        let bytes =
            serialize_annotation_parse(&document, "D:20260830130000Z", 4 * 1024 * 1024).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let mut lines = text.lines();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap()["format"],
            ANNOTATION_PARSE_FORMAT
        );
        let chunk = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();
        assert_eq!(chunk["chunkIndex"], 0);
        assert_eq!(chunk["entries"].as_array().unwrap().len(), 7);
        assert!(lines.next().is_none());
    }

    #[test]
    fn marker_requires_popup_and_blank_appearance() {
        let document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let marker_id = get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .map(|dict| {
                        is_free_text_note_marker(
                            &document,
                            dict,
                            resolve_page_view(&document, page_id).unwrap(),
                            resolve_page_rotation(&document, page_id).unwrap(),
                        )
                    })
                    .unwrap_or(false)
            })
            .unwrap();
        let page_view = resolve_page_view(&document, page_id).unwrap();
        assert!(is_free_text_note_marker(
            &document,
            document.get_dictionary(marker_id).unwrap(),
            page_view,
            resolve_page_rotation(&document, page_id).unwrap(),
        ));
    }

    #[test]
    fn normalized_rect_inverse_matches_all_page_rotations() {
        let page_view = PdfRect {
            x1: 10.0,
            y1: 20.0,
            x2: 210.0,
            y2: 120.0,
        };
        let expected = MarkerRect {
            left: 0.17,
            top: 0.23,
            width: 0.31,
            height: 0.19,
        };
        for rotation in [0, 90, 180, 270] {
            let pdf_rect = marker_rect_to_pdf_rect(expected, page_view, rotation).unwrap();
            let actual = pdf_rect_to_marker_rect(pdf_rect, page_view, rotation).unwrap();
            assert!((actual.left - expected.left).abs() < 1e-12);
            assert!((actual.top - expected.top).abs() < 1e-12);
            assert!((actual.width - expected.width).abs() < 1e-12);
            assert!((actual.height - expected.height).abs() < 1e-12);
        }
    }

    #[test]
    fn shared_protocol_fixture_round_trips_and_rejects_unknown_fields() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-parse-annotations.json");
        let fixture: AnnotationParseProtocolFixture = serde_json::from_str(source).unwrap();
        assert_eq!(fixture.format, ANNOTATION_PARSE_FORMAT);
        assert_eq!(fixture.schema_version, ANNOTATION_PARSE_SCHEMA_VERSION);
        assert_eq!(fixture.page_count, 1);
        assert_eq!(fixture.chunk_bytes, 512 * 1024);
        assert_eq!(fixture.chunk_index, 0);
        assert_eq!(fixture.entries.len(), 3);
        assert!(matches!(
            fixture.entries.first(),
            Some(PdfAnnotationParseEntry::TextBox(_))
        ));
        assert!(matches!(
            fixture.entries.get(1),
            Some(PdfAnnotationParseEntry::Note(_))
        ));
        assert!(matches!(
            fixture.entries.get(2),
            Some(PdfAnnotationParseEntry::Foreign(_))
        ));

        let with_unknown = source.replacen("{", r#"{"unknownField":true,"#, 1);
        assert!(serde_json::from_str::<AnnotationParseProtocolFixture>(&with_unknown).is_err());
    }
}
