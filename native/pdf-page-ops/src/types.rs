const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: u32 = 1;

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
    SaveMutations {
        mutations_file: PathBuf,
        modified_at: String,
        append: bool,
    },
    PageSizes,
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
struct NativeMutationsFile {
    #[serde(default)]
    updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    deletes: Vec<AnnotationDelete>,
    page_labels: Option<PageLabelsMutation>,
    bookmarks: Option<BookmarksMutation>,
    shapes: Option<ShapesMutation>,
    markup: Option<MarkupMutation>,
    #[serde(default)]
    placed_images: Vec<PlacedImage>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageLabelsMutation {
    total_pages: u32,
    #[serde(default)]
    ranges: Vec<PageLabelRange>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageLabelRange {
    start_page: u32,
    style: Option<String>,
    prefix: String,
    start_number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarksMutation {
    total_pages: u32,
    untitled_label: String,
    #[serde(default)]
    items: Vec<BookmarkEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkEntry {
    title: String,
    page_index: Option<u32>,
    page_y_ratio: Option<f64>,
    named_dest: Option<String>,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    italic: bool,
    color: Option<String>,
    #[serde(default)]
    items: Vec<BookmarkEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapesMutation {
    total_pages: u32,
    #[serde(default)]
    rewrite_shape_state: bool,
    #[serde(default)]
    shapes: Vec<ShapeAnnotation>,
    #[serde(default)]
    deleted_annotation_ids: Vec<String>,
    #[serde(default)]
    deleted_stable_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkupMutation {
    #[serde(default)]
    overrides: Vec<(String, String)>,
    #[serde(default)]
    hints: Vec<MarkupSubtypeHint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlacedImage {
    page_index: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation_degrees: Option<f64>,
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkupSubtypeHint {
    subtype: String,
    page_index: u32,
    marker_rect: MarkerRect,
    #[serde(default)]
    annotation_id: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    page_markup_index: Option<u32>,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapePoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeAnnotation {
    #[serde(rename = "type")]
    shape_type: String,
    page_index: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    x2: Option<f64>,
    #[serde(default)]
    y2: Option<f64>,
    color: String,
    #[serde(default)]
    fill_color: Option<String>,
    opacity: f64,
    stroke_width: f64,
    #[serde(default)]
    points: Vec<ShapePoint>,
    #[serde(default)]
    strokes: Vec<Vec<ShapePoint>>,
    #[serde(default)]
    annotation_id: Option<String>,
    #[serde(default)]
    stable_key: Option<String>,
    #[serde(default)]
    pdf_subtype: Option<String>,
    #[serde(default)]
    line_start_style: Option<String>,
    #[serde(default)]
    line_end_style: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    modified_at: Option<u64>,
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
