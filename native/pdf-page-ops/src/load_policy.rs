use super::*;
use lopdf::{DecompressError, Error as LopdfError, LoadOptions};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
    Mutex,
};

const MAX_ENCODED_PDF_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_DECOMPRESSED_PDF_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_PDF_OBJECTS: usize = 1_000_000;
const MAX_PDF_PAGES: usize = 100_000;

#[derive(Clone, Copy)]
struct PdfLoadPolicy {
    max_encoded_bytes: usize,
    max_decompressed_stream_bytes: usize,
    max_objects: usize,
    max_pages: usize,
}

const PDF_LOAD_POLICY: PdfLoadPolicy = PdfLoadPolicy {
    max_encoded_bytes: MAX_ENCODED_PDF_BYTES,
    max_decompressed_stream_bytes: MAX_DECOMPRESSED_PDF_STREAM_BYTES,
    max_objects: MAX_PDF_OBJECTS,
    max_pages: MAX_PDF_PAGES,
};

static PDF_LOAD_GUARD: Mutex<()> = Mutex::new(());
static ACTIVE_STREAM_LIMIT: AtomicUsize = AtomicUsize::new(MAX_DECOMPRESSED_PDF_STREAM_BYTES);
static OBJECT_STREAM_LIMIT_HIT: AtomicBool = AtomicBool::new(false);

impl PdfLoadPolicy {
    fn lopdf_options(self) -> LoadOptions {
        let mut options =
            LoadOptions::with_max_decompressed_size(self.max_decompressed_stream_bytes);
        options.filter = Some(admit_loaded_object);
        options
    }
}

fn admit_loaded_object(object_id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    if let Ok(stream) = object.as_stream() {
        let limit_exceeded = stream.dict.has_type(b"ObjStm")
            && matches!(
                stream.decompressed_content_with_limit(
                    ACTIVE_STREAM_LIMIT.load(AtomicOrdering::SeqCst)
                ),
                Err(LopdfError::Decompress(
                    DecompressError::MemoryLimitExceeded { .. }
                ))
            );
        if limit_exceeded {
            OBJECT_STREAM_LIMIT_HIT.store(true, AtomicOrdering::SeqCst);
            return None;
        }
    }
    Some((object_id, object.clone()))
}

pub(crate) fn load_pdf_path(path: &Path) -> Result<Document> {
    let bytes = read_file_bounded(path, PDF_LOAD_POLICY.max_encoded_bytes, "PDF input")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    load_pdf_bytes_with_policy(&bytes, PDF_LOAD_POLICY)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn load_pdf_bytes(bytes: &[u8]) -> Result<Document> {
    load_pdf_bytes_with_policy(bytes, PDF_LOAD_POLICY)
}

pub(crate) fn load_incremental_pdf_path(path: &Path) -> Result<IncrementalDocument> {
    let bytes = read_file_bounded(path, PDF_LOAD_POLICY.max_encoded_bytes, "PDF input")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    let document = load_pdf_bytes_with_policy(&bytes, PDF_LOAD_POLICY)?;
    Ok(IncrementalDocument::create_from(bytes, document))
}

fn load_pdf_bytes_with_policy(bytes: &[u8], policy: PdfLoadPolicy) -> Result<Document> {
    if bytes.len() > policy.max_encoded_bytes {
        return Err(limit_error(format!(
            "Encoded PDF input exceeds the {}-byte admission ceiling",
            policy.max_encoded_bytes
        )));
    }
    let _load_guard = PDF_LOAD_GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ACTIVE_STREAM_LIMIT.store(policy.max_decompressed_stream_bytes, AtomicOrdering::SeqCst);
    OBJECT_STREAM_LIMIT_HIT.store(false, AtomicOrdering::SeqCst);
    let loaded = Document::load_mem_with_options(bytes, policy.lopdf_options());
    if OBJECT_STREAM_LIMIT_HIT.load(AtomicOrdering::SeqCst) {
        return Err(limit_error(format!(
            "PDF object stream exceeds the {}-byte decompression ceiling",
            policy.max_decompressed_stream_bytes
        )));
    }
    let document = loaded.map_err(|error| classify_lopdf_load_error(error, policy))?;
    validate_loaded_document(&document, policy)?;
    Ok(document)
}

fn validate_loaded_document(document: &Document, policy: PdfLoadPolicy) -> Result<()> {
    let object_count = document
        .objects
        .len()
        .max(document.reference_table.entries.len());
    if object_count > policy.max_objects {
        return Err(limit_error(format!(
            "PDF object count exceeds the {}-object admission ceiling",
            policy.max_objects
        )));
    }

    let page_count = document.page_iter().take(policy.max_pages + 1).count();
    if page_count > policy.max_pages {
        return Err(limit_error(format!(
            "PDF page count exceeds the {}-page admission ceiling",
            policy.max_pages
        )));
    }
    Ok(())
}

fn classify_lopdf_load_error(error: LopdfError, policy: PdfLoadPolicy) -> Box<dyn Error> {
    if matches!(
        error,
        LopdfError::Decompress(DecompressError::MemoryLimitExceeded { .. })
    ) {
        limit_error(format!(
            "PDF stream exceeds the {}-byte decompression ceiling",
            policy.max_decompressed_stream_bytes
        ))
    } else {
        Box::new(error)
    }
}

fn limit_error(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::TooLarge, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(
        max_encoded_bytes: usize,
        max_decompressed_stream_bytes: usize,
        max_objects: usize,
        max_pages: usize,
    ) -> PdfLoadPolicy {
        PdfLoadPolicy {
            max_encoded_bytes,
            max_decompressed_stream_bytes,
            max_objects,
            max_pages,
        }
    }

    fn document_bytes(page_count: usize, include_object_stream: bool) -> Vec<u8> {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..page_count {
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 72.into(), 72.into()],
            });
            kids.push(Object::Reference(page_id));
        }
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => page_count as i64,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        if include_object_stream {
            document.add_object(Object::String(vec![b'A'; 4_096], StringFormat::Literal));
        }
        let mut bytes = Vec::new();
        if include_object_stream {
            document.save_modern(&mut bytes).unwrap();
        } else {
            document.save_to(&mut bytes).unwrap();
        }
        bytes
    }

    fn assert_too_large(error: Box<dyn Error>) {
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn shared_policy_accepts_small_documents_and_caps_encoded_bytes() {
        let bytes = document_bytes(1, false);
        load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 16, 2)).unwrap();
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len() - 1, 1_024, 16, 2)).unwrap_err(),
        );
    }

    #[test]
    fn shared_policy_caps_objects_and_pages_after_loading() {
        let bytes = document_bytes(2, false);
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 2, 10)).unwrap_err(),
        );
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 32, 1)).unwrap_err(),
        );
    }

    #[test]
    fn shared_policy_detects_lopdf_skipped_oversized_object_streams() {
        let bytes = document_bytes(1, true);
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 64, 32, 2)).unwrap_err(),
        );
    }
}
