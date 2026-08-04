use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use lopdf::{dictionary, Document, Object, Stream};

const IMAGE_BYTES: &[u8] = &[0x12, 0x34, 0x56];
const STAMP_JSON: &str = r#"{"schemaVersion":1,"sourceSha256":"0000000000000000000000000000000000000000000000000000000000000000"}"#;

#[test]
fn unstamped_split_output_is_pinned_to_the_legacy_writer_bytes() {
    let paths = TestPaths::new("legacy");
    write_source_pdf(&paths.input);
    write_instructions(&paths.instructions, None);
    run_split_pages(&paths);

    let output = fs::read(&paths.output).unwrap();
    let expected = decode_hex(include_str!("fixtures/provenance-small-legacy.pdf.hex"));
    assert_eq!(output, expected);
}

#[test]
fn the_same_stamp_and_inputs_are_byte_identical_across_runs() {
    let first = TestPaths::new("same-first");
    let second = TestPaths::new("same-second");
    write_source_pdf(&first.input);
    write_source_pdf(&second.input);
    let stamp = stamp_hex();
    write_instructions(&first.instructions, Some(&stamp));
    write_instructions(&second.instructions, Some(&stamp));
    run_split_pages(&first);
    run_split_pages(&second);

    assert_eq!(
        fs::read(&first.output).unwrap(),
        fs::read(&second.output).unwrap()
    );
}

#[test]
fn stamping_preserves_every_image_stream_byte_and_publishes_only_the_stamp_info() {
    let unstamped = TestPaths::new("unstamped");
    let stamped = TestPaths::new("stamped");
    write_source_pdf(&unstamped.input);
    write_source_pdf(&stamped.input);
    write_instructions(&unstamped.instructions, None);
    let stamp = stamp_hex();
    write_instructions(&stamped.instructions, Some(&stamp));
    run_split_pages(&unstamped);
    run_split_pages(&stamped);

    let unstamped_document = Document::load(&unstamped.output).unwrap();
    let stamped_document = Document::load(&stamped.output).unwrap();
    assert_eq!(
        image_streams(&unstamped_document),
        image_streams(&stamped_document)
    );
    assert!(unstamped_document.trailer.get(b"Info").is_err());

    let info_id = stamped_document
        .trailer
        .get(b"Info")
        .unwrap()
        .as_reference()
        .unwrap();
    let info = stamped_document.get_dictionary(info_id).unwrap();
    assert_eq!(info.len(), 1);
    assert_eq!(
        info.get(b"EVBScanCleanup").unwrap().as_str().unwrap(),
        stamp.as_bytes()
    );
}

fn write_source_pdf(path: &Path) {
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let image_id = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1,
            "Height" => 1,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        IMAGE_BYTES.to_vec(),
    ));
    let content_id = document.add_object(Stream::new(
        dictionary! {},
        b"q 1 0 0 1 0 0 cm /Im1 Do Q\n".to_vec(),
    ));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im1" => image_id } },
        "Contents" => content_id,
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
}

fn write_instructions(path: &Path, stamp: Option<&str>) {
    let mut instructions = serde_json::json!({
        "pages": [{
            "sourcePageIndex": 0,
            "rotationQuarterTurns": 0,
            "outputs": [{"cropRect": {"x": 0, "y": 0, "width": 1, "height": 1}}]
        }]
    });
    if let Some(stamp) = stamp {
        instructions["provenanceStampHex"] = serde_json::Value::String(stamp.to_owned());
    }
    fs::write(path, serde_json::to_vec(&instructions).unwrap()).unwrap();
}

fn run_split_pages(paths: &TestPaths) {
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(&paths.input)
        .arg("--output")
        .arg(&paths.output)
        .arg("--instructions-file")
        .arg(&paths.instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn image_streams(document: &Document) -> Vec<Vec<u8>> {
    document
        .objects
        .values()
        .filter_map(|object| match object {
            Object::Stream(stream)
                if stream
                    .dict
                    .get(b"Subtype")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"Image") =>
            {
                Some(stream.content.clone())
            }
            _ => None,
        })
        .collect()
}

fn stamp_hex() -> String {
    STAMP_JSON
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .concat()
}

fn decode_hex(source: &str) -> Vec<u8> {
    let bytes = source
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).unwrap();
            let low = (pair[1] as char).to_digit(16).unwrap();
            ((high << 4) | low) as u8
        })
        .collect()
}

struct TestPaths {
    input: PathBuf,
    output: PathBuf,
    instructions: PathBuf,
}

impl TestPaths {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("evb-pdf-page-ops-provenance-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        Self {
            input: root.join("input.pdf"),
            output: root.join("output.pdf"),
            instructions: root.join("instructions.json"),
        }
    }
}

impl Drop for TestPaths {
    fn drop(&mut self) {
        if let Some(root) = self.input.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}
