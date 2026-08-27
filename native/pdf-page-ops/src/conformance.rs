use super::*;
use serde::Serialize;

const PDF_REFERENCE_LIMIT: usize = 128;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfConformanceFacts {
    is_signed: bool,
    is_encrypted: bool,
    is_tagged: bool,
    has_acro_form: bool,
    has_xfa: bool,
}

fn dictionary_is_signature(dictionary: &Dictionary) -> bool {
    dictionary
        .get(b"Type")
        .ok()
        .and_then(|value| value.as_name().ok())
        .is_some_and(|value| value == b"Sig")
        || dictionary
            .get(b"FT")
            .ok()
            .and_then(|value| value.as_name().ok())
            .is_some_and(|value| value == b"Sig")
        || (dictionary.has(b"ByteRange") && dictionary.has(b"Contents"))
}

fn resolved_object<'a>(document: &'a Document, object: &'a Object) -> Result<&'a Object> {
    let mut current = object;
    for _ in 0..PDF_REFERENCE_LIMIT {
        let Ok(object_id) = current.as_reference() else {
            return Ok(current);
        };
        current = document
            .get_object(object_id)
            .map_err(|error| format!("Failed to resolve PDF object {object_id:?}: {error}"))?;
    }
    Err("PDF reference chain exceeded the conformance dereference limit".into())
}

fn optional_dictionary<'a>(
    document: &'a Document,
    value: Option<&'a Object>,
    field_name: &str,
) -> Result<Option<&'a Dictionary>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if matches!(value, Object::Null) {
        return Ok(None);
    }
    let object = resolved_object(document, value)?;
    if matches!(object, Object::Null) {
        return Ok(None);
    }
    object.as_dict().map(Some).map_err(|error| {
        format!("PDF conformance {field_name} is not a dictionary: {error}").into()
    })
}

pub(crate) fn write_pdf_conformance_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let qpdf_path = qpdf_path.ok_or_else(|| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            "PDF conformance requires the bundled qpdf structural reader",
        )
    })?;
    let incremental = load_qpdf_structural_incremental_pdf(input_path, qpdf_path)?;
    let document = incremental.get_prev_documents();
    let root = document
        .trailer
        .get(b"Root")
        .map_err(|error| format!("qpdf structural trailer is missing /Root: {error}"))?;
    let catalog = optional_dictionary(document, Some(root), "catalog")?
        .ok_or("qpdf structural catalog is missing")?;
    let acro_form = optional_dictionary(document, catalog.get(b"AcroForm").ok(), "AcroForm")?;
    let struct_tree_root = optional_dictionary(
        document,
        catalog.get(b"StructTreeRoot").ok(),
        "StructTreeRoot",
    )?;
    let facts = PdfConformanceFacts {
        is_signed: document.objects.values().any(|object| match object {
            Object::Dictionary(dictionary) => dictionary_is_signature(dictionary),
            Object::Stream(stream) => dictionary_is_signature(&stream.dict),
            _ => false,
        }),
        is_encrypted: document
            .trailer
            .get(b"Encrypt")
            .is_ok_and(|value| !matches!(value, Object::Null)),
        is_tagged: struct_tree_root.is_some(),
        has_acro_form: acro_form.is_some(),
        has_xfa: acro_form.is_some_and(|dictionary| dictionary.has(b"XFA")),
    };
    fs::write(output_path, serde_json::to_vec(&facts)?)?;
    Ok(())
}
