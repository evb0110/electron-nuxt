use super::*;
use lopdf::dictionary;
use std::path::Path;

pub(crate) fn read_split_pages_file(path: &Path) -> Result<SplitPagesFile> {
    let instructions: SplitPagesFile = serde_json::from_slice(&fs::read(path)?)?;
    if instructions.pages.is_empty() {
        return Err("split-pages requires at least one source-page instruction".into());
    }
    Ok(instructions)
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
    document.save(output_path)?;
    Ok(())
}
