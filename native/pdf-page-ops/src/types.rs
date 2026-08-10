use super::*;

fn deserialize_collection<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    deserialize_bounded_vec::<D, T, MAX_COLLECTION_ITEMS>(deserializer)
}

fn deserialize_bookmark_items<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<BookmarkEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, BookmarkEntry, 5_000>(deserializer)
}

fn deserialize_shape_items<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    deserialize_bounded_vec::<D, T, 4_096>(deserializer)
}

fn deserialize_shape_points<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<ShapePoint>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, ShapePoint, 20_000>(deserializer)
}

fn deserialize_placed_images<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<PlacedImage>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, PlacedImage, 16>(deserializer)
}

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub(crate) fn domain_error(code: NativeErrorCode, message: impl Into<String>) -> Box<dyn Error> {
    Box::new(NativeError::new(code, message))
}

pub(crate) fn reclassify_domain_error(
    error: Box<dyn Error>,
    fallback_code: NativeErrorCode,
) -> Box<dyn Error> {
    if error.downcast_ref::<NativeError>().is_some() {
        error
    } else {
        domain_error(fallback_code, error.to_string())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct CropMargins {
    pub(crate) top: f64,
    pub(crate) bottom: f64,
    pub(crate) left: f64,
    pub(crate) right: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct PdfRect {
    pub(crate) x1: f64,
    pub(crate) y1: f64,
    pub(crate) x2: f64,
    pub(crate) y2: f64,
}

impl PdfRect {
    pub(crate) fn width(self) -> f64 {
        self.x2 - self.x1
    }

    pub(crate) fn height(self) -> f64 {
        self.y2 - self.y1
    }
}

const PDF_REFERENCE_LIMIT: usize = 128;

pub(crate) trait PdfObjectSource {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object>;

    fn page_ids(&self) -> BTreeMap<u32, ObjectId>;

    fn root_id(&self) -> Result<ObjectId>;

    fn resolved<'a>(&'a self, object: &'a Object) -> Result<&'a Object> {
        let mut object = object;
        for _ in 0..PDF_REFERENCE_LIMIT {
            let Ok(object_id) = object.as_reference() else {
                return Ok(object);
            };
            object = self
                .stored_object(object_id)
                .ok_or_else(|| missing_object_message(object_id))?;
        }
        Err("PDF reference chain exceeded the dereference limit".into())
    }

    fn object(&self, object_id: ObjectId) -> Result<&Object> {
        let object = self
            .stored_object(object_id)
            .ok_or_else(|| missing_object_message(object_id))?;
        self.resolved(object)
    }

    fn dictionary(&self, object_id: ObjectId) -> Result<&Dictionary> {
        Ok(self.object(object_id)?.as_dict()?)
    }
}

fn missing_object_message(object_id: ObjectId) -> String {
    format!("Object {}R{} was not found", object_id.0, object_id.1)
}

impl PdfObjectSource for Document {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        self.objects.get(&object_id)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        self.get_pages()
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.trailer.get(b"Root")?.as_reference()?)
    }
}

/// What a fresh reader sees after an incremental append: the objects the
/// appended revision rewrote, over the base revision that is still in memory.
pub(crate) struct AppendedRevision<'a> {
    base: &'a Document,
    appended: &'a Document,
}

impl<'a> AppendedRevision<'a> {
    pub(crate) fn new(incremental: &'a IncrementalDocument) -> Self {
        Self {
            base: incremental.get_prev_documents(),
            appended: &incremental.new_document,
        }
    }
}

impl PdfObjectSource for AppendedRevision<'_> {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        self.appended
            .objects
            .get(&object_id)
            .or_else(|| self.base.objects.get(&object_id))
    }

    /// Appends rewrite page dictionaries, the catalog and annotation objects but
    /// never restructure the page tree, so page identity comes from the base
    /// revision. A mutation that adds or removes pages would have to walk the
    /// appended tree instead.
    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        self.base.get_pages()
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.appended.trailer.get(b"Root")?.as_reference()?)
    }
}

pub(crate) enum Operation {
    SplitPages {
        instructions_file: PathBuf,
    },
    OverlayText {
        source_path: PathBuf,
        instructions_file: PathBuf,
    },
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
    PageSizes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPagesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<SplitPageInstruction>,
    #[serde(default)]
    pub(crate) provenance_stamp_hex: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) rotation_quarter_turns: i64,
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) outputs: Vec<SplitPageOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageOutput {
    pub(crate) crop_rect: SplitCropRect,
    #[serde(default)]
    pub(crate) content_transform: Option<SplitContentTransform>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<TextLayerInstruction>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) output_page_index: usize,
    /// PDF `cm` operands mapping source-page user space into output-page user space.
    pub(crate) matrix: [f64; 6],
    /// PDF text extraction commonly ignores clipping. Split pages therefore
    /// filter show operators by their positioned origin in target-page space.
    #[serde(default)]
    pub(crate) filter_to_output_page: bool,
}

/// Scales the source page's own content into the output page box, so a page
/// that is physically smaller than the document it belongs to is enlarged
/// rather than parked in a corner of an enlarged sheet. `cropRect` is read in
/// the transformed space when this is present, which is where the caller
/// already laid the output out.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitContentTransform {
    pub(crate) scale: f64,
    pub(crate) translate_x: f64,
    pub(crate) translate_y: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitCropRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

pub(crate) struct Config {
    pub(crate) operation: Operation,
    pub(crate) input_path: PathBuf,
    pub(crate) output_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoteTextUpdatesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteChangesFile {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) deletes: Vec<AnnotationDelete>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeMutationsFile {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) deletes: Vec<AnnotationDelete>,
    pub(crate) page_labels: Option<PageLabelsMutation>,
    pub(crate) bookmarks: Option<BookmarksMutation>,
    pub(crate) shapes: Option<ShapesMutation>,
    pub(crate) markup: Option<MarkupMutation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_placed_images")]
    pub(crate) placed_images: Vec<PlacedImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteTextUpdate {
    pub(crate) object_number: u32,
    pub(crate) generation_number: u16,
    pub(crate) text: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkerRect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FreeTextNote {
    pub(crate) page_index: u32,
    pub(crate) stable_key: String,
    pub(crate) text: String,
    pub(crate) marker_rect: MarkerRect,
    pub(crate) author: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) created_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageLabelsMutation {
    pub(crate) total_pages: u32,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) ranges: Vec<PageLabelRange>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageLabelRange {
    pub(crate) start_page: u32,
    pub(crate) style: Option<String>,
    pub(crate) prefix: String,
    pub(crate) start_number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BookmarksMutation {
    pub(crate) total_pages: u32,
    pub(crate) untitled_label: String,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_bookmark_items")]
    pub(crate) items: Vec<BookmarkEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BookmarkEntry {
    pub(crate) title: String,
    pub(crate) page_index: Option<u32>,
    pub(crate) page_y_ratio: Option<f64>,
    pub(crate) named_dest: Option<String>,
    #[serde(default)]
    pub(crate) bold: bool,
    #[serde(default)]
    pub(crate) italic: bool,
    pub(crate) color: Option<String>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_bookmark_items")]
    pub(crate) items: Vec<BookmarkEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapesMutation {
    pub(crate) total_pages: u32,
    #[serde(default)]
    pub(crate) rewrite_shape_state: bool,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) shapes: Vec<ShapeAnnotation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) deleted_annotation_ids: Vec<String>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) deleted_stable_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkupMutation {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) overrides: Vec<(String, String)>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) hints: Vec<MarkupSubtypeHint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlacedImage {
    pub(crate) page_index: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) rotation_degrees: Option<f64>,
    pub(crate) mime_type: String,
    pub(crate) bytes_path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    #[serde(skip)]
    pub(crate) validated_bytes: std::cell::RefCell<Option<Vec<u8>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkupSubtypeHint {
    pub(crate) subtype: String,
    pub(crate) page_index: u32,
    pub(crate) marker_rect: MarkerRect,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    #[serde(default)]
    pub(crate) color: Option<String>,
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) page_markup_index: Option<u32>,
    #[serde(default)]
    pub(crate) source: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapeAnnotation {
    #[serde(rename = "type")]
    pub(crate) shape_type: String,
    pub(crate) page_index: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    #[serde(default)]
    pub(crate) x2: Option<f64>,
    #[serde(default)]
    pub(crate) y2: Option<f64>,
    pub(crate) color: String,
    #[serde(default)]
    pub(crate) fill_color: Option<String>,
    pub(crate) opacity: f64,
    pub(crate) stroke_width: f64,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_points")]
    pub(crate) points: Vec<ShapePoint>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) strokes: Vec<Vec<ShapePoint>>,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    #[serde(default)]
    pub(crate) stable_key: Option<String>,
    #[serde(default)]
    pub(crate) pdf_subtype: Option<String>,
    #[serde(default)]
    pub(crate) line_start_style: Option<String>,
    #[serde(default)]
    pub(crate) line_end_style: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnnotationDelete {
    pub(crate) page_index: u32,
    pub(crate) object_number: Option<u32>,
    pub(crate) generation_number: Option<u16>,
    pub(crate) stable_key: Option<String>,
    pub(crate) created_at: Option<u64>,
}

#[cfg(test)]
mod protocol_schema_tests {
    use super::*;

    #[test]
    fn canonical_mutation_fixture_round_trips_and_rejects_unknown_fields() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-save-mutations.json");
        let parsed: NativeMutationsFile = serde_json::from_str(source).unwrap();
        assert_eq!(parsed.placed_images.len(), 1);

        let with_unknown = source.replacen("{", r#"{"unknownField":true,"#, 1);
        assert!(serde_json::from_str::<NativeMutationsFile>(&with_unknown).is_err());
    }
}
