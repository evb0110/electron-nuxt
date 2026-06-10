#[derive(Clone, Copy)]
struct PageGeometry {
    media_box: PdfRect,
    crop_box: Option<PdfRect>,
    rotation: i64,
}

struct PageMutationBytes {
    data: Vec<u8>,
    page_count: u32,
}

#[derive(Clone, Copy)]
struct PageCloneSource {
    document_index: usize,
    page_id: ObjectId,
}

struct PageCloneContext<'a> {
    sources: Vec<&'a Document>,
    target: Document,
    pages_id: ObjectId,
    object_map: HashMap<(usize, ObjectId), ObjectId>,
}

fn load_browser_pdf(data: &[u8]) -> Result<Document> {
    let document = Document::load_mem(data)?;
    if document.is_encrypted() {
        return Err("Encrypted PDFs are not supported by browser page-op WASM".into());
    }
    Ok(document)
}

fn save_document_to_bytes(document: &mut Document) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    document.save_to(&mut output)?;
    Ok(output)
}

fn page_count(document: &Document) -> u32 {
    document.get_pages().len() as u32
}

fn validate_browser_page_numbers(
    pages: &[u32],
    label: &str,
    document_page_count: u32,
    require_unique: bool,
    require_permutation: bool,
) -> Result<HashSet<u32>> {
    if pages.is_empty() {
        return Err(format!("{label}: must be a non-empty array of page numbers").into());
    }

    let mut page_set = HashSet::new();
    for page in pages {
        if *page == 0 {
            return Err(format!("{label}: invalid page number {page}").into());
        }
        if *page > document_page_count {
            return Err(format!(
                "{label}: page number {page} is out of range 1-{document_page_count}"
            )
            .into());
        }
        if require_unique && !page_set.insert(*page) {
            return Err(format!("{label}: duplicate page number {page}").into());
        }
    }

    if require_permutation {
        for page_number in 1..=document_page_count {
            if !page_set.contains(&page_number) {
                return Err(format!("{label}: missing page {page_number} in reorder payload").into());
            }
        }
    }

    Ok(page_set)
}

fn validate_browser_rotation_angle(angle: i64) -> Result<i64> {
    match angle {
        90 | 180 | 270 => Ok(angle),
        _ => Err("Invalid rotation angle".into()),
    }
}

fn rotate_browser_pages(
    document: &mut Document,
    pages: &[u32],
    angle: i64,
) -> Result<()> {
    let angle = validate_browser_rotation_angle(angle)?;
    let page_map = document.get_pages();
    validate_browser_page_numbers(
        pages,
        "rotatePages",
        page_map.len() as u32,
        true,
        false,
    )?;

    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let current_rotation = resolve_page_rotation(document, page_id)?;
        document
            .get_dictionary_mut(page_id)?
            .set("Rotate", normalize_page_rotation(current_rotation + angle));
    }

    Ok(())
}

fn get_browser_page_geometry(
    document: &Document,
    page_number: u32,
) -> Result<PageGeometry> {
    let page_map = document.get_pages();
    let page_id = resolve_page_id(&page_map, page_number)?;
    let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
    let crop_box = resolve_inherited_box(document, page_id, b"CropBox")
        .ok()
        .and_then(|crop_box| intersect_rect(crop_box, media_box))
        .filter(|crop_box| !pdf_rects_equal(*crop_box, media_box));

    Ok(PageGeometry {
        media_box,
        crop_box,
        rotation: resolve_page_rotation(document, page_id)?,
    })
}

fn crop_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
    margins: CropMargins,
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    let document_page_count = page_count(&document);
    validate_browser_page_numbers(pages, "cropPages", document_page_count, true, false)?;
    crop_pages(&mut document, pages, margins)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

fn remove_crop_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    let document_page_count = page_count(&document);
    validate_browser_page_numbers(pages, "removeCrop", document_page_count, true, false)?;
    remove_crop_from_pages(&mut document, pages)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

fn rotate_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
    angle: i64,
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    rotate_browser_pages(&mut document, pages, angle)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

fn get_browser_page_geometry_from_bytes(data: &[u8], page_number: u32) -> Result<PageGeometry> {
    let document = load_browser_pdf(data)?;
    get_browser_page_geometry(&document, page_number)
}

fn delete_browser_pdf_pages(data: &[u8], pages: &[u32]) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    let remove_pages = validate_browser_page_numbers(
        pages,
        "deletePages",
        source_pages.len() as u32,
        true,
        false,
    )?;
    let kept_pages = source_pages
        .iter()
        .filter_map(|(page_number, page_id)| {
            (!remove_pages.contains(page_number)).then_some(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            })
        })
        .collect::<Vec<_>>();
    build_browser_page_subset_pdf(&[&document], &kept_pages)
}

fn extract_browser_pdf_pages(data: &[u8], pages: &[u32]) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    validate_browser_page_numbers(
        pages,
        "extractPages",
        source_pages.len() as u32,
        true,
        false,
    )?;
    let selected_pages = pages
        .iter()
        .map(|page_number| {
            Ok(PageCloneSource {
                document_index: 0,
                page_id: resolve_page_id(&source_pages, *page_number)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    build_browser_page_subset_pdf(&[&document], &selected_pages)
}

fn reorder_browser_pdf_pages(data: &[u8], new_order: &[u32]) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    validate_browser_page_numbers(
        new_order,
        "reorderPages",
        source_pages.len() as u32,
        true,
        true,
    )?;
    let ordered_pages = new_order
        .iter()
        .map(|page_number| {
            Ok(PageCloneSource {
                document_index: 0,
                page_id: resolve_page_id(&source_pages, *page_number)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    build_browser_page_subset_pdf(&[&document], &ordered_pages)
}

fn insert_browser_pdf_pages(
    data: &[u8],
    insertion_data: &[u8],
    after_page: u32,
) -> Result<PageMutationBytes> {
    let destination = load_browser_pdf(data)?;
    let insertion = load_browser_pdf(insertion_data)?;
    let destination_pages = destination.get_pages();
    let insertion_pages = insertion.get_pages();
    if after_page > destination_pages.len() as u32 {
        return Err("Invalid afterPage".into());
    }

    let mut page_sequence = Vec::with_capacity(destination_pages.len() + insertion_pages.len());
    for (page_number, page_id) in &destination_pages {
        if *page_number <= after_page {
            page_sequence.push(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            });
        }
    }
    page_sequence.extend(insertion_pages.values().map(|page_id| PageCloneSource {
        document_index: 1,
        page_id: *page_id,
    }));
    for (page_number, page_id) in &destination_pages {
        if *page_number > after_page {
            page_sequence.push(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            });
        }
    }

    build_browser_page_subset_pdf(&[&destination, &insertion], &page_sequence)
}

fn build_browser_page_subset_pdf(
    sources: &[&Document],
    page_sequence: &[PageCloneSource],
) -> Result<PageMutationBytes> {
    let version = sources
        .iter()
        .map(|document| document.version.as_str())
        .max()
        .unwrap_or("1.4")
        .to_string();
    let mut target = Document::with_version(version);
    let pages_id = target.new_object_id();
    let mut clone_context = PageCloneContext {
        sources: sources.to_vec(),
        target,
        pages_id,
        object_map: HashMap::new(),
    };
    let page_ids = page_sequence
        .iter()
        .map(|source| clone_context.clone_page(*source))
        .collect::<Result<Vec<_>>>()?;

    let kids = page_ids
        .iter()
        .copied()
        .map(Object::Reference)
        .collect::<Vec<_>>();
    clone_context.target.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => page_ids.len() as u32,
        }
        .into(),
    );
    let catalog_id = clone_context.target.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    clone_context.target.trailer.set("Root", catalog_id);
    clone_context.target.prune_objects();

    Ok(PageMutationBytes {
        page_count: page_ids.len() as u32,
        data: save_document_to_bytes(&mut clone_context.target)?,
    })
}

impl PageCloneContext<'_> {
    fn clone_page(&mut self, source: PageCloneSource) -> Result<ObjectId> {
        if let Some(new_id) = self.object_map.get(&(source.document_index, source.page_id)) {
            return Ok(*new_id);
        }

        let new_page_id = self.target.new_object_id();
        self.object_map
            .insert((source.document_index, source.page_id), new_page_id);

        let source_document = self.source(source.document_index)?;
        let mut page = source_document.get_dictionary(source.page_id)?.clone();
        materialize_page_inherited_object(source_document, source.page_id, &mut page, b"MediaBox", true)?;
        materialize_page_inherited_object(source_document, source.page_id, &mut page, b"CropBox", false)?;
        materialize_page_inherited_object(source_document, source.page_id, &mut page, b"Resources", false)?;
        materialize_page_inherited_object(source_document, source.page_id, &mut page, b"Rotate", false)?;
        page.remove(b"Parent");
        page.set("Type", "Page");

        let cloned_page = self.clone_object_references(
            source.document_index,
            Object::Dictionary(page),
        )?;
        let mut cloned_page = cloned_page
            .as_dict()
            .map(Clone::clone)
            .map_err(|_| "Cloned page object was not a dictionary")?;
        cloned_page.set("Parent", self.pages_id);
        self.target
            .objects
            .insert(new_page_id, Object::Dictionary(cloned_page));
        Ok(new_page_id)
    }

    fn clone_indirect_object(
        &mut self,
        source_index: usize,
        object_id: ObjectId,
    ) -> Result<ObjectId> {
        if let Some(new_id) = self.object_map.get(&(source_index, object_id)) {
            return Ok(*new_id);
        }

        let new_id = self.target.new_object_id();
        self.object_map.insert((source_index, object_id), new_id);
        let object = self.source(source_index)?.get_object(object_id)?.clone();
        let cloned_object = self.clone_object_references(source_index, object)?;
        self.target.objects.insert(new_id, cloned_object);
        Ok(new_id)
    }

    fn clone_object_references(
        &mut self,
        source_index: usize,
        object: Object,
    ) -> Result<Object> {
        match object {
            Object::Reference(object_id) => Ok(Object::Reference(
                self.clone_indirect_object(source_index, object_id)?,
            )),
            Object::Array(items) => Ok(Object::Array(
                items
                    .into_iter()
                    .map(|item| self.clone_object_references(source_index, item))
                    .collect::<Result<Vec<_>>>()?,
            )),
            Object::Dictionary(dictionary) => Ok(Object::Dictionary(
                self.clone_dictionary_references(source_index, dictionary)?,
            )),
            Object::Stream(mut stream) => {
                stream.dict = self.clone_dictionary_references(source_index, stream.dict)?;
                Ok(Object::Stream(stream))
            }
            object => Ok(object),
        }
    }

    fn clone_dictionary_references(
        &mut self,
        source_index: usize,
        dictionary: Dictionary,
    ) -> Result<Dictionary> {
        let mut cloned_dictionary = Dictionary::new();
        for (key, value) in dictionary.iter() {
            cloned_dictionary.set(
                key.clone(),
                self.clone_object_references(source_index, value.clone())?,
            );
        }
        Ok(cloned_dictionary)
    }

    fn source(&self, source_index: usize) -> Result<&Document> {
        self.sources
            .get(source_index)
            .copied()
            .ok_or_else(|| format!("Invalid PDF source index {source_index}").into())
    }
}

fn materialize_page_inherited_object(
    document: &Document,
    page_id: ObjectId,
    page: &mut Dictionary,
    key: &[u8],
    required: bool,
) -> Result<()> {
    if page.get(key).is_ok() {
        return Ok(());
    }

    if let Some(object) = resolve_inherited_object(document, page_id, key)? {
        page.set(key.to_vec(), object);
        return Ok(());
    }

    if required {
        return Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into());
    }

    Ok(())
}

fn resolve_inherited_object(
    document: &Document,
    page_id: ObjectId,
    key: &[u8],
) -> Result<Option<Object>> {
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
            return Ok(Some(object.clone()));
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Ok(None)
}

fn pdf_rects_equal(left: PdfRect, right: PdfRect) -> bool {
    left.x1 == right.x1 && left.y1 == right.y1 && left.x2 == right.x2 && left.y2 == right.y2
}
