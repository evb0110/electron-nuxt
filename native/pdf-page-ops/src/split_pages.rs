use super::*;
use lopdf::dictionary;
use std::path::Path;

pub(crate) fn read_split_pages_file(path: &Path) -> Result<SplitPagesFile> {
    let instructions: SplitPagesFile = serde_json::from_slice(&fs::read(path)?)?;
    if instructions.pages.is_empty() {
        return Err("split-pages requires at least one source-page instruction".into());
    }
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        validate_provenance_stamp_hex(stamp)?;
    }
    Ok(instructions)
}

fn validate_provenance_stamp_hex(stamp: &str) -> Result<()> {
    if stamp.is_empty()
        || !stamp.len().is_multiple_of(2)
        || stamp
            .bytes()
            .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("provenanceStampHex must be a non-empty lowercase hexadecimal string".into());
    }
    Ok(())
}

fn validate_crop_rect(rect: SplitCropRect) -> Result<PdfRect> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("split-pages cropRect must contain finite positive dimensions".into());
    }
    Ok(PdfRect {
        x1: rect.x,
        y1: rect.y,
        x2: rect.x + rect.width,
        y2: rect.y + rect.height,
    })
}

fn materialized_page_dictionary(document: &Document, page_id: ObjectId) -> Result<Dictionary> {
    let mut page = document.get_dictionary(page_id)?.clone();
    for (key, required) in [
        (b"MediaBox".as_slice(), true),
        (b"CropBox".as_slice(), false),
        (b"Resources".as_slice(), false),
        (b"Rotate".as_slice(), false),
    ] {
        if page.get(key).is_ok() {
            continue;
        }
        let mut current_id = Some(page_id);
        let mut inherited = None;
        let mut seen = HashSet::new();
        while let Some(object_id) = current_id {
            if !seen.insert(object_id) {
                return Err("Page tree cycle while materializing split page".into());
            }
            let dictionary = document.get_dictionary(object_id)?;
            if let Ok(value) = dictionary.get(key) {
                inherited = Some(value.clone());
                break;
            }
            current_id = dictionary
                .get(b"Parent")
                .and_then(Object::as_reference)
                .ok();
        }
        if let Some(value) = inherited {
            page.set(key.to_vec(), value);
        } else if required {
            return Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into());
        }
    }
    page.remove(b"Parent");
    page.set("Type", "Page");
    Ok(page)
}

fn set_page_box(page: &mut Dictionary, key: &str, rect: PdfRect) {
    page.set(
        key,
        Object::Array(vec![
            number_object(rect.x1),
            number_object(rect.y1),
            number_object(rect.x2),
            number_object(rect.y2),
        ]),
    );
}

fn validate_content_transform(transform: SplitContentTransform) -> Result<SplitContentTransform> {
    if !transform.scale.is_finite()
        || transform.scale <= 0.0
        || !transform.translate_x.is_finite()
        || !transform.translate_y.is_finite()
    {
        return Err(
            "split-pages contentTransform must be a finite positive scale with finite translation"
                .into(),
        );
    }
    Ok(transform)
}

/// A legal `/Contents` is a stream or an array of streams, and either of those
/// — and every entry of the array — may be reached through an indirect
/// reference. Four levels is past every shape PDF defines and stops a document
/// whose arrays point at each other from recursing without end; lopdf's own
/// dereference limit stops a chain of references before that.
const MAX_CONTENTS_NESTING: usize = 4;

/// What one `/Contents` value turned out to be, resolved and detached from the
/// document so the collector can borrow it mutably again.
enum ContentsEntry {
    /// A content stream, by the id it already has in the document.
    Stream(ObjectId),
    /// A list of content streams to resolve in turn.
    List(Vec<Object>),
}

/// The page's content streams as indirect objects, materializing a directly
/// embedded stream so the transform can wrap it without rewriting it.
///
/// A reference is not a stream id by assumption: qpdf writes the page's list of
/// streams as one indirect array, and treating that array as a stream would put
/// it between the transform and its restore, where every reader sees a page
/// whose contents are not a stream and draws nothing at all.
fn content_stream_ids(document: &mut Document, page: &Dictionary) -> Result<Vec<ObjectId>> {
    let contents = match page.get(b"Contents") {
        Ok(value) => value.clone(),
        Err(_) => return Ok(Vec::new()),
    };
    let mut ids = Vec::new();
    collect_content_streams(document, contents, &mut ids, 0)?;
    Ok(ids)
}

fn collect_content_streams(
    document: &mut Document,
    object: Object,
    ids: &mut Vec<ObjectId>,
    depth: usize,
) -> Result<()> {
    if depth > MAX_CONTENTS_NESTING {
        return Err("split-pages found a Contents entry nested past any legal shape".into());
    }
    let object_id = match object {
        Object::Stream(stream) => {
            ids.push(document.add_object(Object::Stream(stream)));
            return Ok(());
        }
        Object::Array(items) => {
            for item in items {
                collect_content_streams(document, item, ids, depth + 1)?;
            }
            return Ok(());
        }
        Object::Reference(object_id) => object_id,
        _ => return Err("split-pages found an unsupported Contents entry".into()),
    };
    let reference = Object::Reference(object_id);
    let entry = match document.dereference(&reference) {
        Ok((resolved_id, Object::Stream(_))) => {
            ContentsEntry::Stream(resolved_id.unwrap_or(object_id))
        }
        Ok((_, Object::Array(items))) => ContentsEntry::List(items.clone()),
        // A reference this document cannot resolve — a missing object, or a
        // chain of references past lopdf's limit — is carried across exactly as
        // it was, rather than failing a split over an object the source itself
        // is missing.
        Err(_) => ContentsEntry::Stream(object_id),
        Ok(_) => return Err("split-pages found an unsupported Contents entry".into()),
    };
    match entry {
        ContentsEntry::Stream(stream_id) => ids.push(stream_id),
        ContentsEntry::List(items) => {
            for item in items {
                collect_content_streams(document, item, ids, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// The annotation entries that are page coordinates: every one of them is a
/// flat list of (x, y) pairs in the same user space as the content.
///
/// `Rect` carries the box an appearance stream is mapped into, so an annotation
/// that has an `/AP` follows its rectangle without its stream being touched.
/// The rest are the geometry an annotation with no appearance stream is drawn
/// from — which is what the app writes — and leaving them behind would put an
/// ink stroke or a line somewhere its own rectangle no longer is.
/// Whether an array of this length is the shape PDF defines for its key.
type AnnotationArrayShape = fn(usize) -> bool;

const ANNOTATION_POINT_KEYS: [(&[u8], AnnotationArrayShape); 5] = [
    (b"Rect", |len| len == 4),
    (b"QuadPoints", |len| len % 8 == 0),
    // Line endpoints, and the leader line of a callout: four numbers, or six
    // when the callout bends once.
    (b"L", |len| len == 4),
    (b"CL", |len| len == 4 || len == 6),
    (b"Vertices", |len| len % 2 == 0),
];

/// One coordinate array, scaled and translated as (x, y) pairs. An array whose
/// shape is not the one PDF defines for its key — an odd length, a non-numeric
/// entry — is refused rather than half-transformed: the annotation is left
/// exactly as it was instead of being corrupted into a shape no reader accepts.
fn transformed_point_array(
    document: &Document,
    values: &[Object],
    transform: SplitContentTransform,
    shape_is_valid: impl Fn(usize) -> bool,
) -> Option<Vec<Object>> {
    if values.is_empty() || values.len() % 2 != 0 || !shape_is_valid(values.len()) {
        return None;
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            // A coordinate is allowed to be an indirect object of its own, and
            // reading only the direct form would refuse the whole annotation.
            let (_, value) = document.dereference(value).ok()?;
            let number = f64::from(value.as_float().ok()?);
            if !number.is_finite() {
                return None;
            }
            let offset = if index % 2 == 0 {
                transform.translate_x
            } else {
                transform.translate_y
            };
            Some(number_object(number * transform.scale + offset))
        })
        .collect()
}

/// `InkList` is a list of strokes, each its own flat list of points, so it is
/// transformed one stroke at a time. A stroke this tool cannot read leaves the
/// whole list alone: a half-moved drawing is worse than one that did not move.
fn transformed_ink_list(
    document: &Document,
    strokes: &[Object],
    transform: SplitContentTransform,
) -> Option<Vec<Object>> {
    if strokes.is_empty() {
        return None;
    }
    strokes
        .iter()
        .map(|stroke| {
            let (_, stroke) = document.dereference(stroke).ok()?;
            let points =
                transformed_point_array(document, stroke.as_array().ok()?, transform, |_| true)?;
            Some(Object::Array(points))
        })
        .collect()
}

/// One coordinate entry of an annotation, read through however many references
/// the writer put between the annotation and its numbers. qpdf and the app both
/// write indirect arrays, and reading only the direct form leaves those
/// coordinates where the untransformed content used to be.
fn annotation_array(
    document: &Document,
    annotation: &Dictionary,
    key: &[u8],
) -> Option<Vec<Object>> {
    let (_, resolved) = document.dereference(annotation.get(key).ok()?).ok()?;
    resolved.as_array().ok().cloned()
}

/// The page's annotation list, whether the page holds the array itself or
/// points at one. qpdf writes the indirect form, and reading only the direct
/// one leaves every coordinate array on such a page unscaled — the annotations
/// stay where the untransformed content used to be.
fn page_annotation_array(document: &Document, page: &Dictionary) -> Option<Vec<Object>> {
    let annotations = page.get(b"Annots").ok()?;
    // lopdf's dereference is bounded, so a reference that points at itself
    // answers an error rather than looping; a page whose list cannot be read is
    // left exactly as it is.
    let (_, resolved) = document.dereference(annotations).ok()?;
    resolved.as_array().ok().cloned()
}

/// Annotations live in the same user space as the content they mark, so a
/// content transform that leaves them alone silently moves every note off its
/// target. The annotation objects can be shared with the source page and with
/// the other half of a split, so each output gets its own copy.
fn transform_annotations(
    document: &mut Document,
    page: &mut Dictionary,
    transform: SplitContentTransform,
) -> Result<()> {
    let Some(source) = page_annotation_array(document, page) else {
        return Ok(());
    };
    let mut transformed = Vec::with_capacity(source.len());
    for annotation in source {
        // An entry this tool cannot read as an annotation dictionary — a
        // reference the source is missing, or an object that is not a
        // dictionary at all — is carried over exactly as it was. Dropping it
        // would delete a note the source page still shows, which is a worse
        // answer than one note left at the coordinates it already had.
        let resolved = document
            .dereference(&annotation)
            .ok()
            .and_then(|(_, object)| object.as_dict().ok())
            .cloned();
        let Some(dictionary) = resolved else {
            transformed.push(annotation);
            continue;
        };
        let mut copy = dictionary;
        for (key, shape_is_valid) in ANNOTATION_POINT_KEYS {
            let Some(values) = annotation_array(document, &copy, key) else {
                continue;
            };
            if let Some(points) =
                transformed_point_array(document, &values, transform, shape_is_valid)
            {
                copy.set(key.to_vec(), Object::Array(points));
            }
        }
        if let Some(strokes) = annotation_array(document, &copy, b"InkList") {
            if let Some(ink) = transformed_ink_list(document, &strokes, transform) {
                copy.set(b"InkList".to_vec(), Object::Array(ink));
            }
        }
        transformed.push(Object::Reference(document.add_object(copy)));
    }
    page.set("Annots", Object::Array(transformed));
    Ok(())
}

/// Wraps the page's own content in the transform, leaving every content stream,
/// font and image object untouched: the output carries the source bytes at a
/// different scale rather than a resampled copy of them.
fn apply_content_transform(
    document: &mut Document,
    page: &mut Dictionary,
    transform: SplitContentTransform,
) -> Result<()> {
    let mut streams = vec![document.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        format!(
            "q {} 0 0 {} {} {} cm\n",
            transform.scale, transform.scale, transform.translate_x, transform.translate_y
        )
        .into_bytes(),
    )))];
    streams.extend(content_stream_ids(document, page)?);
    streams.push(document.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        b"\nQ\n".to_vec(),
    ))));
    page.set(
        "Contents",
        Object::Array(streams.into_iter().map(Object::Reference).collect()),
    );
    transform_annotations(document, page, transform)
}

fn object_graph_is_complete(
    document: &Document,
    object: &Object,
    seen: &mut HashSet<ObjectId>,
) -> bool {
    match object {
        Object::Reference(object_id) => {
            if !seen.insert(*object_id) {
                return true;
            }
            document
                .objects
                .get(object_id)
                .is_some_and(|referenced| object_graph_is_complete(document, referenced, seen))
        }
        Object::Array(items) => items
            .iter()
            .all(|item| object_graph_is_complete(document, item, seen)),
        Object::Dictionary(dictionary) => dictionary
            .iter()
            .all(|(_, value)| object_graph_is_complete(document, value, seen)),
        Object::Stream(stream) => stream
            .dict
            .iter()
            .all(|(_, value)| object_graph_is_complete(document, value, seen)),
        _ => true,
    }
}

fn resolve_object<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document.dereference(object).ok().map(|(_, value)| value)
}

fn has_valid_oc_properties(document: &Document, catalog_id: ObjectId) -> bool {
    let Ok(catalog) = document.get_dictionary(catalog_id) else {
        return false;
    };
    let Ok(properties) = catalog.get(b"OCProperties") else {
        return true;
    };
    if !object_graph_is_complete(document, properties, &mut HashSet::new()) {
        return false;
    }
    let Some(properties) =
        resolve_object(document, properties).and_then(|value| value.as_dict().ok())
    else {
        return false;
    };
    let Some(groups) = properties
        .get(b"OCGs")
        .ok()
        .and_then(|value| resolve_object(document, value))
        .and_then(|value| value.as_array().ok())
    else {
        return false;
    };
    groups.iter().all(|group| {
        resolve_object(document, group)
            .and_then(|value| value.as_dict().ok())
            .is_some_and(|dictionary| {
                dictionary
                    .get(b"Type")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"OCG")
            })
    })
}

fn drop_invalid_oc_properties(document: &mut Document, catalog_id: ObjectId) -> Result<()> {
    if has_valid_oc_properties(document, catalog_id) {
        return Ok(());
    }
    document
        .get_dictionary_mut(catalog_id)?
        .remove(b"OCProperties");
    Ok(())
}

pub(crate) fn split_pages(
    mut document: Document,
    instructions: &SplitPagesFile,
    output_path: &Path,
) -> Result<()> {
    let source_pages = document.get_pages();
    let pages_id = document.new_object_id();
    let mut materialized_pages = Vec::new();

    for instruction in &instructions.pages {
        if !(0..=3).contains(&instruction.rotation_quarter_turns) {
            return Err("split-pages rotationQuarterTurns must be between 0 and 3".into());
        }
        if !(1..=2).contains(&instruction.outputs.len()) {
            return Err("split-pages requires one or two outputs per source page".into());
        }
        let page_number = u32::try_from(instruction.source_page_index + 1)
            .map_err(|_| "split-pages sourcePageIndex is too large")?;
        let source_page_id = resolve_page_id(&source_pages, page_number)?;
        let source_rotation = resolve_page_rotation(&document, source_page_id)?;
        for output_instruction in &instruction.outputs {
            let crop = validate_crop_rect(output_instruction.crop_rect)?;
            let mut page = materialized_page_dictionary(&document, source_page_id)?;
            if let Some(transform) = output_instruction.content_transform {
                apply_content_transform(
                    &mut document,
                    &mut page,
                    validate_content_transform(transform)?,
                )?;
            }
            set_page_box(&mut page, "MediaBox", crop);
            set_page_box(&mut page, "CropBox", crop);
            page.remove(b"BleedBox");
            page.remove(b"TrimBox");
            page.remove(b"ArtBox");
            page.set(
                "Rotate",
                normalize_page_rotation(source_rotation + instruction.rotation_quarter_turns * 90),
            );
            page.set("Parent", pages_id);
            materialized_pages.push(page);
        }
    }

    let output_page_ids = materialized_pages
        .into_iter()
        .map(|page| document.add_object(page))
        .collect::<Vec<_>>();
    let kids = output_page_ids
        .iter()
        .copied()
        .map(Object::Reference)
        .collect::<Vec<_>>();
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => output_page_ids.len() as u32,
        }
        .into(),
    );
    let catalog_id = document.trailer.get(b"Root")?.as_reference()?;
    document
        .get_dictionary_mut(catalog_id)?
        .set("Pages", pages_id);
    drop_invalid_oc_properties(&mut document, catalog_id)?;
    document.prune_objects();
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        let info_id = document.add_object(dictionary! {
            "EVBScanCleanup" => Object::string_literal(stamp.as_bytes().to_vec()),
        });
        document.trailer.set("Info", info_id);
    }
    document.save(output_path)?;
    Ok(())
}
