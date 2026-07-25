use super::*;

pub(crate) fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

pub(crate) fn normalize_page_label_style(style: Option<&str>) -> Option<String> {
    match style {
        Some("D" | "R" | "r" | "A" | "a") => style.map(ToOwned::to_owned),
        Some(_) => Some("D".to_string()),
        None => None,
    }
}

pub(crate) fn normalize_page_label_ranges(
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

pub(crate) fn is_implicit_default_page_labels(ranges: &[PageLabelRange], total_pages: u32) -> bool {
    let normalized = normalize_page_label_ranges(ranges, total_pages);
    normalized.len() == 1
        && normalized[0].start_page == 1
        && normalized[0].style.as_deref() == Some("D")
        && normalized[0].prefix.is_empty()
        && normalized[0].start_number == 1
}

pub(crate) fn assert_mutation_page_count(
    document: &impl PdfObjectSource,
    total_pages: u32,
    label: &str,
) -> Result<()> {
    let actual_pages = u32::try_from(document.page_ids().len())?;
    if total_pages != actual_pages {
        return Err(format!(
            "{label} page count {total_pages} does not match document page count {actual_pages}"
        )
        .into());
    }
    Ok(())
}

pub(crate) fn set_page_labels_on_catalog(
    catalog: &mut Dictionary,
    page_labels: &PageLabelsMutation,
) {
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        catalog.remove(b"PageLabels");
        return;
    }

    let normalized = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    let mut nums = Vec::with_capacity(normalized.len() * 2);
    for range in normalized {
        nums.push(Object::Integer(i64::from(
            range.start_page.saturating_sub(1),
        )));
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

pub(crate) fn set_page_labels(
    document: &mut Document,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    assert_mutation_page_count(document, page_labels.total_pages, "Page-label mutation")?;
    let catalog_id = document.root_id()?;
    let catalog = document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

pub(crate) fn set_page_labels_incremental(
    incremental: &mut IncrementalDocument,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        page_labels.total_pages,
        "Page-label mutation",
    )?;
    let catalog_id = incremental.get_prev_documents().root_id()?;
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

pub(crate) fn normalize_bookmark_color(color: Option<&str>) -> Option<String> {
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

pub(crate) fn normalize_bookmark_entries(
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
                page_index: item
                    .page_index
                    .map(|page_index| page_index.min(max_page_index)),
                page_y_ratio: item
                    .page_y_ratio
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 1.0)),
                named_dest,
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

pub(crate) fn resolve_bookmark_destination_top(
    page_view: &PdfRect,
    page_y_ratio: Option<f64>,
) -> f64 {
    let Some(page_y_ratio) = page_y_ratio else {
        return page_view.y2;
    };
    page_view.y2 - page_y_ratio.clamp(0.0, 1.0) * page_view.height().max(0.0)
}

pub(crate) struct OutlineBuildResult {
    pub(crate) first: Option<ObjectId>,
    pub(crate) last: Option<ObjectId>,
    pub(crate) visible_count: i64,
}

pub(crate) struct BookmarkNode<'a> {
    pub(crate) object_id: ObjectId,
    pub(crate) item: &'a BookmarkEntry,
    pub(crate) visible_count: i64,
}

pub(crate) fn set_bookmark_destination(
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
        let destination_top = resolve_bookmark_destination_top(&page_view, item.page_y_ratio);
        dict.set(
            "Dest",
            Object::Array(vec![
                Object::Reference(page_id),
                Object::Name(b"XYZ".to_vec()),
                Object::Null,
                number_object(destination_top),
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

pub(crate) fn set_bookmark_style(dict: &mut Dictionary, item: &BookmarkEntry) {
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

pub(crate) fn build_bookmark_dict(
    base_document: &Document,
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    item: &BookmarkEntry,
) -> Result<Dictionary> {
    let mut dict = Dictionary::new();
    dict.set(
        "Title",
        Object::String(
            encode_pdf_text_string(&item.title),
            StringFormat::Hexadecimal,
        ),
    );
    set_bookmark_destination(base_document, page_map, &mut dict, item)?;
    set_bookmark_style(&mut dict, item);
    Ok(dict)
}

pub(crate) fn build_outline_level(
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
        let child_result =
            build_outline_level(document, page_map, &node.item.items, node.object_id)?;
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

pub(crate) fn build_outline_level_incremental(
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

pub(crate) fn set_bookmarks_on_catalog(
    document: &mut Document,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    assert_mutation_page_count(document, bookmarks.total_pages, "Bookmark mutation")?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    let catalog_id = document.root_id()?;
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

pub(crate) fn set_bookmarks(document: &mut Document, bookmarks: &BookmarksMutation) -> Result<()> {
    set_bookmarks_on_catalog(document, bookmarks)
}

pub(crate) fn set_bookmarks_incremental(
    incremental: &mut IncrementalDocument,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        bookmarks.total_pages,
        "Bookmark mutation",
    )?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    let catalog_id = incremental.get_prev_documents().root_id()?;
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
