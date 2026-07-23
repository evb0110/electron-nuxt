use super::*;

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

pub(crate) enum Operation {
    SplitPages {
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
    pub(crate) pages: Vec<SplitPageInstruction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) rotation_quarter_turns: i64,
    pub(crate) outputs: Vec<SplitPageOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageOutput {
    pub(crate) crop_rect: SplitCropRect,
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
    pub(crate) updates: Vec<NoteTextUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteChangesFile {
    #[serde(default)]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    pub(crate) deletes: Vec<AnnotationDelete>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeMutationsFile {
    #[serde(default)]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    pub(crate) deletes: Vec<AnnotationDelete>,
    pub(crate) page_labels: Option<PageLabelsMutation>,
    pub(crate) bookmarks: Option<BookmarksMutation>,
    pub(crate) shapes: Option<ShapesMutation>,
    pub(crate) markup: Option<MarkupMutation>,
    #[serde(default)]
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
    pub(crate) items: Vec<BookmarkEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapesMutation {
    pub(crate) total_pages: u32,
    #[serde(default)]
    pub(crate) rewrite_shape_state: bool,
    #[serde(default)]
    pub(crate) shapes: Vec<ShapeAnnotation>,
    #[serde(default)]
    pub(crate) deleted_annotation_ids: Vec<String>,
    #[serde(default)]
    pub(crate) deleted_stable_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkupMutation {
    #[serde(default)]
    pub(crate) overrides: Vec<(String, String)>,
    #[serde(default)]
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
    pub(crate) points: Vec<ShapePoint>,
    #[serde(default)]
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
