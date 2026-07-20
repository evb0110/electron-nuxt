use lopdf::{dictionary, Document, Object, Stream};
use std::{
    env,
    fs::{remove_file, write},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn path(label: &str, extension: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!("evb-pdf-page-ops-{label}-{nonce}.{extension}"))
}

#[test]
fn split_pages_preserves_vector_objects_and_applies_boxes_and_rotation() {
    let input = path("split-input", "pdf");
    let output = path("split-output", "pdf");
    let instructions = path("split-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let content_bytes = b"BT /F1 18 Tf 24 100 Td (Vector text) Tj ET".to_vec();
    let content_id = document.add_object(Stream::new(dictionary! {}, content_bytes.clone()));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
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
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":1,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120}},{"cropRect":{"x":100,"y":0,"width":100,"height":120}}]}]}"#).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--instructions-file")
        .arg(&instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let split = Document::load(&output).unwrap();
    let pages = split.get_pages();
    assert_eq!(pages.len(), 2);
    for (page_number, expected_box) in [(1, vec![0, 0, 100, 120]), (2, vec![100, 0, 200, 120])] {
        let page = split
            .get_dictionary(*pages.get(&page_number).unwrap())
            .unwrap();
        for key in [b"MediaBox".as_slice(), b"CropBox".as_slice()] {
            let values = page.get(key).unwrap().as_array().unwrap();
            assert_eq!(
                values
                    .iter()
                    .map(|value| value.as_i64().unwrap())
                    .collect::<Vec<_>>(),
                expected_box
            );
        }
        assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        let content = page.get(b"Contents").unwrap().as_reference().unwrap();
        assert_eq!(
            split
                .get_object(content)
                .unwrap()
                .as_stream()
                .unwrap()
                .content,
            content_bytes
        );
        let resources = page.get(b"Resources").unwrap().as_dict().unwrap();
        let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
        let preserved_font = fonts.get(b"F1").unwrap().as_reference().unwrap();
        assert_eq!(
            format!("{:?}", split.get_object(preserved_font).unwrap()),
            format!("{:?}", document.get_object(font_id).unwrap()),
        );
    }

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

#[test]
fn split_pages_preserves_valid_optional_content_properties() {
    let input = path("split-ocg-input", "pdf");
    let output = path("split-ocg-output", "pdf");
    let instructions = path("split-ocg-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
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
    let group_id = document.add_object(dictionary! {
        "Type" => "OCG",
        "Name" => Object::string_literal("Visible layer"),
    });
    let properties_id = document.add_object(dictionary! {
        "OCGs" => vec![Object::Reference(group_id)],
        "D" => dictionary! {
            "Name" => Object::string_literal("Default"),
            "Order" => vec![Object::Reference(group_id)],
            "ON" => vec![Object::Reference(group_id)],
        },
    });
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "OCProperties" => properties_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120}}]}]}"#).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--instructions-file")
        .arg(&instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let split = Document::load(&output).unwrap();
    let split_catalog_id = split.trailer.get(b"Root").unwrap().as_reference().unwrap();
    let split_catalog = split.get_dictionary(split_catalog_id).unwrap();
    let properties = match split_catalog.get(b"OCProperties").unwrap() {
        Object::Reference(id) => split.get_dictionary(*id).unwrap(),
        Object::Dictionary(dictionary) => dictionary,
        value => panic!("OCProperties must be a dictionary, got {value:?}"),
    };
    let groups = match properties.get(b"OCGs").unwrap() {
        Object::Array(groups) => groups,
        Object::Reference(id) => split.get_object(*id).unwrap().as_array().unwrap(),
        value => panic!("OCGs must be an array, got {value:?}"),
    };
    assert_eq!(groups.len(), 1);
    let group_id = groups[0].as_reference().unwrap();
    let group = split.get_dictionary(group_id).unwrap();
    assert_eq!(group.get(b"Type").unwrap().as_name().unwrap(), b"OCG");

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

#[test]
fn split_pages_drops_incomplete_optional_content_properties() {
    let input = path("split-incomplete-ocg-input", "pdf");
    let output = path("split-incomplete-ocg-output", "pdf");
    let instructions = path("split-incomplete-ocg-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
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
        "OCProperties" => dictionary! {
            "D" => dictionary! { "Order" => Vec::<Object>::new() },
        },
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120}}]}]}"#).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--instructions-file")
        .arg(&instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let split = Document::load(&output).unwrap();
    let split_catalog_id = split.trailer.get(b"Root").unwrap().as_reference().unwrap();
    let split_catalog = split.get_dictionary(split_catalog_id).unwrap();
    assert!(split_catalog.get(b"OCProperties").is_err());

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}
