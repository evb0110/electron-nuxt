use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use std::{
    env,
    fs::{remove_file, write},
    path::Path,
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

fn run_split_pages(input: &Path, output: &Path, instructions: &Path) {
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
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

    run_split_pages(&input, &output, &instructions);

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

    run_split_pages(&input, &output, &instructions);

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

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let split_catalog_id = split.trailer.get(b"Root").unwrap().as_reference().unwrap();
    let split_catalog = split.get_dictionary(split_catalog_id).unwrap();
    assert!(split_catalog.get(b"OCProperties").is_err());

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

#[test]
fn split_pages_prunes_objects_reachable_only_from_unselected_source_pages() {
    let input = path("split-prune-input", "pdf");
    let output = path("split-prune-output", "pdf");
    let instructions = path("split-prune-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let kept_content = b"BT (Kept page) Tj ET".to_vec();
    let unselected_content = b"BT (Unselected page) Tj ET".to_vec();
    let kept_content_id = document.add_object(Stream::new(dictionary! {}, kept_content.clone()));
    let unselected_content_id =
        document.add_object(Stream::new(dictionary! {}, unselected_content.clone()));
    let kept_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Contents" => kept_content_id,
    });
    let unselected_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Contents" => unselected_content_id,
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(kept_page_id), Object::Reference(unselected_page_id)],
            "Count" => 2,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120}}]}]}"#).unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    assert_eq!(split.get_pages().len(), 1);
    let contents = split
        .objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .map(|stream| stream.content.clone())
        .collect::<Vec<_>>();
    assert!(contents.contains(&kept_content));
    assert!(
        !contents.contains(&unselected_content),
        "the unselected source page's content stream survived pruning"
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

#[test]
fn split_pages_prunes_optional_content_objects_orphaned_by_the_dropped_catalog_entry() {
    let input = path("split-orphan-ocg-input", "pdf");
    let output = path("split-orphan-ocg-output", "pdf");
    let instructions = path("split-orphan-ocg-instructions", "json");
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
        "Type" => "Annot",
        "Name" => Object::string_literal("Orphaned layer"),
    });
    let properties_id = document.add_object(dictionary! {
        "OCGs" => vec![Object::Reference(group_id)],
    });
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "OCProperties" => properties_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120}}]}]}"#).unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let split_catalog_id = split.trailer.get(b"Root").unwrap().as_reference().unwrap();
    let split_catalog = split.get_dictionary(split_catalog_id).unwrap();
    assert!(split_catalog.get(b"OCProperties").is_err());
    let dictionaries = split
        .objects
        .values()
        .filter_map(|object| object.as_dict().ok())
        .collect::<Vec<_>>();
    assert!(
        !dictionaries
            .iter()
            .any(|dictionary| dictionary.get(b"OCGs").is_ok()),
        "the optional-content properties dictionary survived pruning"
    );
    assert!(
        !dictionaries.iter().any(|dictionary| dictionary
            .get(b"Name")
            .and_then(Object::as_str)
            .is_ok_and(|name| name == b"Orphaned layer")),
        "the optional-content group survived pruning"
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

/// Matching page size on the lossless path means a physically smaller page has
/// to become the document's rectangle. The content transform carries the
/// page's own objects there: the original content stream, font and annotation
/// survive untouched, and only the placement changes.
#[test]
fn split_pages_scales_content_and_annotations_onto_the_canvas() {
    let input = path("split-scale-input", "pdf");
    let output = path("split-scale-output", "pdf");
    let instructions = path("split-scale-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let content_bytes = b"BT /F1 9 Tf 10 20 Td (Half size) Tj ET".to_vec();
    let content_id = document.add_object(Stream::new(dictionary! {}, content_bytes.clone()));
    // An annotation with an appearance stream: the stream is drawn into the
    // rectangle, so following the rectangle is the whole of moving it, and its
    // bytes must not be touched.
    let appearance_bytes = b"0 0 1 rg 0 0 20 20 re f".to_vec();
    let appearance_id = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 20.into(), 20.into()],
        },
        appearance_bytes.clone(),
    ));
    let annotation_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "AP" => dictionary! { "N" => Object::Reference(appearance_id) },
    });
    // The annotations the app writes with no appearance stream at all: a reader
    // draws them from these coordinate arrays, so an array left behind puts the
    // drawing somewhere its own rectangle no longer is.
    let ink_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Ink",
        "Rect" => vec![5.into(), 5.into(), 45.into(), 25.into()],
        "InkList" => vec![
            Object::Array(vec![5.into(), 5.into(), 15.into(), 25.into()]),
            Object::Array(vec![25.into(), 10.into(), 45.into(), 20.into()]),
        ],
    });
    let line_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Line",
        "Rect" => vec![1.into(), 2.into(), 31.into(), 42.into()],
        "L" => vec![1.into(), 2.into(), 31.into(), 42.into()],
        "CL" => vec![1.into(), 2.into(), 11.into(), 12.into(), 21.into(), 22.into()],
    });
    let polygon_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Polygon",
        "Rect" => vec![0.into(), 0.into(), 30.into(), 30.into()],
        "Vertices" => vec![0.into(), 0.into(), 30.into(), 0.into(), 15.into(), 30.into()],
    });
    // A malformed array — an odd number of coordinates — is left exactly as it
    // is rather than half-transformed into a shape no reader accepts.
    let malformed_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Polygon",
        "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        "Vertices" => vec![1.into(), 2.into(), 3.into()],
    });
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 60.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        "Annots" => vec![
            Object::Reference(annotation_id),
            Object::Reference(ink_id),
            Object::Reference(line_id),
            Object::Reference(polygon_id),
            Object::Reference(malformed_id),
        ],
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
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":2,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let pages = split.get_pages();
    assert_eq!(pages.len(), 1);
    let page = split.get_dictionary(*pages.get(&1).unwrap()).unwrap();
    for key in [b"MediaBox".as_slice(), b"CropBox".as_slice()] {
        assert_eq!(
            page.get(key)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![0, 0, 200, 120]
        );
    }

    // The page's content is the source stream, unchanged, between a transform
    // and its restore: nothing was rewritten or resampled.
    let streams = page
        .get(b"Contents")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            split
                .get_object(value.as_reference().unwrap())
                .unwrap()
                .as_stream()
                .unwrap()
                .content
                .clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(streams.len(), 3);
    assert_eq!(String::from_utf8_lossy(&streams[0]), "q 2 0 0 2 0 0 cm\n");
    assert_eq!(streams[1], content_bytes);
    assert_eq!(String::from_utf8_lossy(&streams[2]), "\nQ\n");

    // Every annotation moved with the content it marks — the rectangle an
    // appearance stream is mapped into, and the coordinate arrays a reader
    // draws an appearance-less annotation from.
    let annotations = page
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            split
                .get_object(value.as_reference().unwrap())
                .unwrap()
                .as_dict()
                .unwrap()
        })
        .collect::<Vec<_>>();
    let numbers = |dictionary: &Dictionary, key: &[u8]| {
        dictionary
            .get(key)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(numbers(annotations[0], b"Rect"), vec![20, 40, 60, 80]);
    // The appearance stream itself is the source object, untouched: it is drawn
    // into the rectangle, which is what changed.
    let appearance = split
        .get_object(
            annotations[0]
                .get(b"AP")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"N")
                .unwrap()
                .as_reference()
                .unwrap(),
        )
        .unwrap()
        .as_stream()
        .unwrap();
    assert_eq!(appearance.content, appearance_bytes);
    assert_eq!(
        appearance
            .dict
            .get(b"BBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 0, 20, 20]
    );

    assert_eq!(numbers(annotations[1], b"Rect"), vec![10, 10, 90, 50]);
    let ink = annotations[1]
        .get(b"InkList")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|stroke| {
            stroke
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert_eq!(ink, vec![vec![10, 10, 30, 50], vec![50, 20, 90, 40]]);

    assert_eq!(numbers(annotations[2], b"L"), vec![2, 4, 62, 84]);
    assert_eq!(numbers(annotations[2], b"CL"), vec![2, 4, 22, 24, 42, 44]);
    assert_eq!(
        numbers(annotations[3], b"Vertices"),
        vec![0, 0, 60, 0, 30, 60]
    );
    // The malformed array is the one thing that did not move: its own rectangle
    // did, but a shape this tool cannot read is left intact rather than
    // rewritten into one no reader accepts.
    assert_eq!(numbers(annotations[4], b"Vertices"), vec![1, 2, 3]);
    assert_eq!(numbers(annotations[4], b"Rect"), vec![0, 0, 20, 20]);

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

/// qpdf — which is what writes the working copies this pipeline splits — stores
/// a page's content list and its annotation list as indirect objects, both of
/// which PDF allows anywhere the direct form is allowed. A transform that reads
/// only the direct form puts an array where a reader expects a content stream,
/// which renders as a blank page, and leaves every annotation coordinate at the
/// scale the content no longer has.
#[test]
fn split_pages_scales_content_and_annotations_reached_through_indirect_objects() {
    let input = path("split-indirect-input", "pdf");
    let output = path("split-indirect-output", "pdf");
    let instructions = path("split-indirect-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    // Two content streams, listed through one indirect array — the shape qpdf
    // writes whenever a page's content arrived in more than one piece.
    let first_content = b"BT /F1 9 Tf 10 20 Td (First stream) Tj ET\n".to_vec();
    let second_content = b"BT /F1 9 Tf 10 40 Td (Second stream) Tj ET\n".to_vec();
    let first_content_id = document.add_object(Stream::new(dictionary! {}, first_content.clone()));
    let second_content_id =
        document.add_object(Stream::new(dictionary! {}, second_content.clone()));
    let contents_id = document.add_object(Object::Array(vec![
        Object::Reference(first_content_id),
        Object::Reference(second_content_id),
    ]));
    let highlight_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Highlight",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "QuadPoints" => vec![
            10.into(), 40.into(), 30.into(), 40.into(),
            10.into(), 20.into(), 30.into(), 20.into(),
        ],
    });
    let ink_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Ink",
        "Rect" => vec![5.into(), 5.into(), 45.into(), 25.into()],
        "InkList" => vec![
            Object::Array(vec![5.into(), 5.into(), 15.into(), 25.into()]),
            Object::Array(vec![25.into(), 10.into(), 45.into(), 20.into()]),
        ],
    });
    let line_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Line",
        "Rect" => vec![1.into(), 2.into(), 31.into(), 42.into()],
        "L" => vec![1.into(), 2.into(), 31.into(), 42.into()],
        "CL" => vec![1.into(), 2.into(), 11.into(), 12.into(), 21.into(), 22.into()],
    });
    let polygon_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Polygon",
        "Rect" => vec![0.into(), 0.into(), 30.into(), 30.into()],
        "Vertices" => vec![0.into(), 0.into(), 30.into(), 0.into(), 15.into(), 30.into()],
    });
    // Malformed even behind the indirection: left intact rather than rewritten
    // into a shape no reader accepts.
    let malformed_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Polygon",
        "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        "Vertices" => vec![1.into(), 2.into(), 3.into()],
    });
    let annots_id = document.add_object(Object::Array(vec![
        Object::Reference(highlight_id),
        Object::Reference(ink_id),
        Object::Reference(line_id),
        Object::Reference(polygon_id),
        Object::Reference(malformed_id),
    ]));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 60.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        "Annots" => Object::Reference(annots_id),
        "Contents" => Object::Reference(contents_id),
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
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":2,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let pages = split.get_pages();
    assert_eq!(pages.len(), 1);
    let page = split.get_dictionary(*pages.get(&1).unwrap()).unwrap();

    // Every entry of the page's content is a stream a reader can execute — the
    // transform, both original streams in order, and the restore. An array left
    // among them is what makes pdftoppm report weird page contents and draw an
    // empty page.
    let streams = page
        .get(b"Contents")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            split
                .get_object(value.as_reference().unwrap())
                .unwrap()
                .as_stream()
                .unwrap()
                .content
                .clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        streams,
        vec![
            b"q 2 0 0 2 0 0 cm\n".to_vec(),
            first_content,
            second_content,
            b"\nQ\n".to_vec(),
        ]
    );

    let annotations = page
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            split
                .get_object(value.as_reference().unwrap())
                .unwrap()
                .as_dict()
                .unwrap()
        })
        .collect::<Vec<_>>();
    let numbers = |dictionary: &Dictionary, key: &[u8]| {
        dictionary
            .get(key)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(numbers(annotations[0], b"Rect"), vec![20, 40, 60, 80]);
    assert_eq!(
        numbers(annotations[0], b"QuadPoints"),
        vec![20, 80, 60, 80, 20, 40, 60, 40]
    );
    assert_eq!(numbers(annotations[1], b"Rect"), vec![10, 10, 90, 50]);
    assert_eq!(
        annotations[1]
            .get(b"InkList")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|stroke| stroke
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        vec![vec![10, 10, 30, 50], vec![50, 20, 90, 40]]
    );
    assert_eq!(numbers(annotations[2], b"L"), vec![2, 4, 62, 84]);
    assert_eq!(numbers(annotations[2], b"CL"), vec![2, 4, 22, 24, 42, 44]);
    assert_eq!(
        numbers(annotations[3], b"Vertices"),
        vec![0, 0, 60, 0, 30, 60]
    );
    assert_eq!(numbers(annotations[4], b"Vertices"), vec![1, 2, 3]);
    assert_eq!(numbers(annotations[4], b"Rect"), vec![0, 0, 20, 20]);

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

/// The annotation list on its own, behind an indirect object while the content
/// is direct: the coordinates still have to follow the content, so this holds
/// even when nothing about the content list is unusual.
#[test]
fn split_pages_scales_annotations_listed_through_an_indirect_object() {
    let input = path("split-indirect-annots-input", "pdf");
    let output = path("split-indirect-annots-output", "pdf");
    let instructions = path("split-indirect-annots-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(
        dictionary! {},
        b"BT (Content) Tj ET\n".to_vec(),
    ));
    let square_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
    });
    let annots_id = document.add_object(Object::Array(vec![Object::Reference(square_id)]));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 60.into()],
        "Annots" => Object::Reference(annots_id),
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
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":2,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let page = split
        .get_dictionary(*split.get_pages().get(&1).unwrap())
        .unwrap();
    let annotation = split
        .dereference(page.get(b"Annots").unwrap())
        .unwrap()
        .1
        .as_array()
        .unwrap()
        .first()
        .and_then(|value| split.dereference(value).ok())
        .unwrap()
        .1
        .as_dict()
        .unwrap();
    assert_eq!(
        annotation
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![20, 40, 60, 80]
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

/// The same page, split without a content transform at all: the indirect
/// content list still has to arrive as a list of streams rather than as one
/// reference to an array that a reader cannot execute.
#[test]
fn split_pages_keeps_an_indirect_content_array_executable_without_a_transform() {
    let input = path("split-indirect-plain-input", "pdf");
    let output = path("split-indirect-plain-output", "pdf");
    let instructions = path("split-indirect-plain-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let first_content = b"BT (First) Tj ET\n".to_vec();
    let second_content = b"BT (Second) Tj ET\n".to_vec();
    let first_content_id = document.add_object(Stream::new(dictionary! {}, first_content.clone()));
    let second_content_id =
        document.add_object(Stream::new(dictionary! {}, second_content.clone()));
    let contents_id = document.add_object(Object::Array(vec![
        Object::Reference(first_content_id),
        Object::Reference(second_content_id),
    ]));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Contents" => Object::Reference(contents_id),
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
    write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120}}]}]}"#).unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let pages = split.get_pages();
    let page = split.get_dictionary(*pages.get(&1).unwrap()).unwrap();
    // Untransformed pages keep the page's own Contents value, so the entry the
    // reader follows still has to resolve to the two source streams.
    let contents = split
        .dereference(page.get(b"Contents").unwrap())
        .unwrap()
        .1
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            split
                .dereference(value)
                .unwrap()
                .1
                .as_stream()
                .unwrap()
                .content
                .clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(contents, vec![first_content, second_content]);

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}

/// A coordinate array is an object like any other, so a writer may store it
/// indirectly — the whole array, one stroke of an ink drawing, or a single
/// number. Reading only the direct form leaves those coordinates at the scale
/// the content no longer has, which is the note drifting off what it marks.
///
/// And an annotation this tool cannot read at all is carried over untouched:
/// dropping it would delete a note the source page still shows.
#[test]
fn split_pages_scales_annotation_coordinates_stored_as_indirect_objects() {
    let input = path("split-indirect-coords-input", "pdf");
    let output = path("split-indirect-coords-output", "pdf");
    let instructions = path("split-indirect-coords-instructions", "json");
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(
        dictionary! {},
        b"BT (Content) Tj ET\n".to_vec(),
    ));
    let rect_id = document.add_object(Object::Array(vec![
        10.into(),
        20.into(),
        30.into(),
        40.into(),
    ]));
    let quad_points_id = document.add_object(Object::Array(vec![
        10.into(),
        40.into(),
        30.into(),
        40.into(),
        10.into(),
        20.into(),
        30.into(),
        20.into(),
    ]));
    let highlight_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Highlight",
        "Rect" => Object::Reference(rect_id),
        "QuadPoints" => Object::Reference(quad_points_id),
    });
    // The list, one of its strokes, and one coordinate of the other: all three
    // levels of indirection PDF allows inside one drawing.
    let first_stroke_id = document.add_object(Object::Array(vec![
        5.into(),
        5.into(),
        15.into(),
        25.into(),
    ]));
    let stroke_y_id = document.add_object(Object::Integer(20));
    let ink_list_id = document.add_object(Object::Array(vec![
        Object::Reference(first_stroke_id),
        Object::Array(vec![
            25.into(),
            10.into(),
            45.into(),
            Object::Reference(stroke_y_id),
        ]),
    ]));
    let ink_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Ink",
        "Rect" => vec![5.into(), 5.into(), 45.into(), 25.into()],
        "InkList" => Object::Reference(ink_list_id),
    });
    // An annotation whose object the source is missing. It cannot be
    // transformed, and it is written out exactly as it arrived.
    let missing_id = (9_999, 0);
    let annots_id = document.add_object(Object::Array(vec![
        Object::Reference(highlight_id),
        Object::Reference(ink_id),
        Object::Reference(missing_id),
    ]));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 60.into()],
        "Annots" => Object::Reference(annots_id),
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
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":2,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();

    run_split_pages(&input, &output, &instructions);

    let split = Document::load(&output).unwrap();
    let page = split
        .get_dictionary(*split.get_pages().get(&1).unwrap())
        .unwrap();
    let entries = split
        .dereference(page.get(b"Annots").unwrap())
        .unwrap()
        .1
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(entries.len(), 3);
    let annotation = |index: usize| {
        split
            .dereference(&entries[index])
            .unwrap()
            .1
            .as_dict()
            .unwrap()
    };
    let numbers = |dictionary: &Dictionary, key: &[u8]| {
        split
            .dereference(dictionary.get(key).unwrap())
            .unwrap()
            .1
            .as_array()
            .unwrap()
            .iter()
            .map(|value| split.dereference(value).unwrap().1.as_i64().unwrap())
            .collect::<Vec<_>>()
    };

    assert_eq!(numbers(annotation(0), b"Rect"), vec![20, 40, 60, 80]);
    assert_eq!(
        numbers(annotation(0), b"QuadPoints"),
        vec![20, 80, 60, 80, 20, 40, 60, 40]
    );
    assert_eq!(
        split
            .dereference(annotation(1).get(b"InkList").unwrap())
            .unwrap()
            .1
            .as_array()
            .unwrap()
            .iter()
            .map(|stroke| split
                .dereference(stroke)
                .unwrap()
                .1
                .as_array()
                .unwrap()
                .iter()
                .map(|value| split.dereference(value).unwrap().1.as_i64().unwrap())
                .collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        vec![vec![10, 10, 30, 50], vec![50, 20, 90, 40]]
    );
    // The unreadable one is still on the page, still the reference it was.
    assert!(entries[2].as_reference().is_ok());
    assert!(split.dereference(&entries[2]).is_err());

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(instructions);
}
