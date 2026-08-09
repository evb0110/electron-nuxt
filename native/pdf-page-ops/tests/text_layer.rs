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

fn save_single_page(path: &Path, content: Vec<u8>, resources: Dictionary) -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Resources" => resources,
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
    document.save(path).unwrap();
    document
}

fn save_two_pages(path: &Path, contents: [Vec<u8>; 2], resources: Dictionary) -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_ids = contents
        .into_iter()
        .map(|content| {
            let content_id = document.add_object(Stream::new(dictionary! {}, content));
            document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => resources.clone(),
                "Contents" => content_id,
            })
        })
        .collect::<Vec<_>>();
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 2,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
    document
}

fn run_overlay_text(
    input: &Path,
    source: &Path,
    output: &Path,
    instructions: &Path,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["overlay-text", "--input"])
        .arg(input)
        .arg("--source")
        .arg(source)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(instructions)
        .output()
        .unwrap()
}

fn pdftotext_page(pdf: &Path, page: usize, extra_args: &[&str]) -> std::process::Output {
    let mut command = Command::new("pdftotext");
    command.args(extra_args);
    command
        .args(["-f", &page.to_string(), "-l", &page.to_string()])
        .arg(pdf)
        .arg("-")
        .output()
        .expect("pdftotext must be installed for PDF text-layer integration tests")
}

fn bbox_word_x(xml: &str, word: &str) -> f64 {
    let word_end = xml
        .find(&format!(">{word}</word>"))
        .unwrap_or_else(|| panic!("word {word:?} is absent from bbox output"));
    let tag = &xml[xml[..word_end].rfind("<word ").unwrap()..word_end];
    let value = tag.split_once("xMin=\"").unwrap().1;
    value[..value.find('"').unwrap()].parse().unwrap()
}

fn measurable_helvetica_font() -> Dictionary {
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "FirstChar" => 0,
        "LastChar" => 255,
        "Widths" => (0..256).map(|_| Object::Integer(1_000)).collect::<Vec<_>>(),
    }
}

#[test]
fn overlay_text_copies_only_invisible_text_and_renames_colliding_fonts() {
    let source = path("text-source", "pdf");
    let input = path("text-input", "pdf");
    let output = path("text-output", "pdf");
    let instructions = path("text-instructions", "json");

    let source_font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    };
    let source_resources = dictionary! {
        "Font" => dictionary! { "F1" => source_font },
    };
    let mut source_page = save_single_page(
        &source,
        b"q 2 0 0 2 1 2 cm BT /F1 12 Tf 0 Tr 5 8 Td (Searchable OCR) Tj ET Q 0 0 100 100 re f"
            .to_vec(),
        source_resources,
    );
    // Replace the direct fixture resource with an indirect object so the test
    // exercises the font graph copier rather than only dictionary cloning.
    let local_font_id = source_page.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let source_page_id = *source_page.get_pages().get(&1).unwrap();
    source_page.get_dictionary_mut(source_page_id).unwrap().set(
        "Resources",
        dictionary! { "Font" => dictionary! { "F1" => local_font_id } },
    );
    source_page.save(&source).unwrap();

    let target_font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    };
    save_single_page(
        &input,
        b"0 0 20 20 re f".to_vec(),
        dictionary! { "Font" => dictionary! { "EVBOcr_F1" => target_font } },
    );
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1.5,0,0,1.5,4,7]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let overlaid = Document::load(&output).unwrap();
    let page_id = *overlaid.get_pages().get(&1).unwrap();
    let operations = overlaid
        .get_and_decode_page_content(page_id)
        .unwrap()
        .operations;
    assert_eq!(
        operations
            .iter()
            .filter(|operation| operation.operator == "re")
            .count(),
        1,
        "source drawing operators must not cross into the cleaned page"
    );
    assert!(operations
        .iter()
        .all(|operation| operation.operator != "Do"));
    assert!(operations
        .iter()
        .filter(|operation| operation.operator == "Tr")
        .all(|operation| operation.operands == vec![Object::Integer(3)]));
    let matrices = operations
        .iter()
        .filter(|operation| operation.operator == "cm")
        .map(|operation| {
            operation
                .operands
                .iter()
                .map(|operand| f64::from(operand.as_float().unwrap()))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert!(matrices.contains(&vec![1.5, 0.0, 0.0, 1.5, 4.0, 7.0]));
    assert!(matrices.contains(&vec![2.0, 0.0, 0.0, 2.0, 1.0, 2.0]));

    let page = overlaid.get_dictionary(page_id).unwrap();
    let resources = page.get(b"Resources").unwrap().as_dict().unwrap();
    let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
    assert!(fonts.get(b"EVBOcr_F1").is_ok());
    assert!(fonts.get(b"EVBOcr_F1_1").is_ok());
    assert!(overlaid
        .extract_text(&[1])
        .unwrap()
        .contains("Searchable OCR"));

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_rejects_singular_affines_before_mutating_the_pdf() {
    let source = path("singular-source", "pdf");
    let input = path("singular-input", "pdf");
    let output = path("singular-output", "pdf");
    let instructions = path("singular-instructions", "json");
    save_single_page(&source, Vec::new(), Dictionary::new());
    save_single_page(&input, Vec::new(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,2,0,4,7]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("matrix must be invertible"));
    assert!(!output.exists());

    for path in [source, input, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_shares_one_cloned_font_program_across_pages() {
    let source = path("shared-font-source", "pdf");
    let input = path("shared-font-input", "pdf");
    let output = path("shared-font-output", "pdf");
    let instructions = path("shared-font-instructions", "json");

    let mut source_document = Document::with_version("1.7");
    let pages_id = source_document.new_object_id();
    let font_program = b"shared-font-program".to_vec();
    let font_program_id = source_document.add_object(Stream::new(
        dictionary! { "Length1" => font_program.len() as i64 },
        font_program.clone(),
    ));
    let descriptor_id = source_document.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "Helvetica",
        "Flags" => 32,
        "FontBBox" => vec![0.into(), (-200).into(), 1_000.into(), 900.into()],
        "ItalicAngle" => 0,
        "Ascent" => 800,
        "Descent" => -200,
        "CapHeight" => 700,
        "StemV" => 80,
        "FontFile" => font_program_id,
    });
    let font_id = source_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
        "FontDescriptor" => descriptor_id,
    });
    let source_page_ids = ["First", "Second"]
        .into_iter()
        .map(|text| {
            let content_id = source_document.add_object(Stream::new(
                dictionary! {},
                format!("BT /F1 12 Tf 10 20 Td ({text}) Tj ET").into_bytes(),
            ));
            source_document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
                "Contents" => content_id,
            })
        })
        .collect::<Vec<_>>();
    source_document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => source_page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 2,
        }
        .into(),
    );
    let catalog_id =
        source_document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    source_document.trailer.set("Root", catalog_id);
    source_document.save(&source).unwrap();

    save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]},{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let overlaid = Document::load(&output).unwrap();
    let font_references = overlaid
        .get_pages()
        .into_values()
        .map(|page_id| {
            overlaid
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Resources")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Font")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"EVBOcr_F1")
                .unwrap()
                .as_reference()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(font_references.len(), 2);
    assert_eq!(font_references[0], font_references[1]);
    assert_eq!(
        overlaid
            .objects
            .values()
            .filter(|object| object
                .as_stream()
                .is_ok_and(|stream| stream.content == font_program))
            .count(),
        1,
        "the shared embedded font program must be cloned only once"
    );
    assert!(overlaid.extract_text(&[1]).unwrap().contains("First"));
    assert!(overlaid.extract_text(&[2]).unwrap().contains("Second"));

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_filters_each_split_page_to_its_visible_source_half() {
    let source = path("split-text-source", "pdf");
    let input = path("split-text-input", "pdf");
    let output = path("split-text-output", "pdf");
    let instructions = path("split-text-instructions", "json");

    save_single_page(
        &source,
        b"q 1 0 0 1 5 0 cm BT /F1 6 Tf 3 Tr 1 0 0 1 15 60 Tm (LEFT_ONLY) Tj 1 0 0 1 115 60 Tm (RIGHT_ONLY) Tj ET Q"
            .to_vec(),
        dictionary! {
            "Font" => dictionary! {
                "F1" => measurable_helvetica_font()
            }
        },
    );
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for page_id in target.get_pages().into_values() {
        target
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let left = pdftotext_page(&output, 1, &[]);
    let right = pdftotext_page(&output, 2, &[]);
    assert!(left.status.success());
    assert!(right.status.success());
    let left = String::from_utf8_lossy(&left.stdout);
    let right = String::from_utf8_lossy(&right.stdout);
    assert!(left.contains("LEFT_ONLY"), "left page text: {left}");
    assert!(!left.contains("RIGHT_ONLY"), "left page text: {left}");
    assert!(right.contains("RIGHT_ONLY"), "right page text: {right}");
    assert!(!right.contains("LEFT_ONLY"), "right page text: {right}");

    let left_bbox = pdftotext_page(&output, 1, &["-bbox"]);
    let right_bbox = pdftotext_page(&output, 2, &["-bbox"]);
    assert!(left_bbox.status.success());
    assert!(right_bbox.status.success());
    let left_bbox = String::from_utf8_lossy(&left_bbox.stdout);
    let right_bbox = String::from_utf8_lossy(&right_bbox.stdout);
    assert!(left_bbox.contains("LEFT_ONLY"), "left bbox: {left_bbox}");
    assert!(!left_bbox.contains("RIGHT_ONLY"), "left bbox: {left_bbox}");
    assert!(
        right_bbox.contains("RIGHT_ONLY"),
        "right bbox: {right_bbox}"
    );
    assert!(
        !right_bbox.contains("LEFT_ONLY"),
        "right bbox: {right_bbox}"
    );
    assert!((bbox_word_x(&left_bbox, "LEFT_ONLY") - 20.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "RIGHT_ONLY") - 20.0).abs() < 0.1);

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn split_text_filter_tracks_consecutive_shows_and_splits_strings_and_tj_arrays_at_the_seam() {
    let source = path("split-glyph-source", "pdf");
    let input = path("split-glyph-input", "pdf");
    let output = path("split-glyph-output", "pdf");
    let instructions = path("split-glyph-instructions", "json");

    save_single_page(
        &source,
        b"BT /F1 10 Tf 3 Tr 1 0 0 1 80 90 Tm (AB) Tj (CD) Tj 1 0 0 1 80 60 Tm [(N) -1000 (R)] TJ 1 0 0 1 80 30 Tm (WXYZ) Tj ET"
            .to_vec(),
        dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
    );
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for page_id in target.get_pages().into_values() {
        target
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let left = pdftotext_page(&output, 1, &[]);
    let right = pdftotext_page(&output, 2, &[]);
    let left = String::from_utf8_lossy(&left.stdout);
    let right = String::from_utf8_lossy(&right.stdout);
    assert!(left.contains("AB"), "left page text: {left}");
    assert!(!left.contains("CD"), "left page text: {left}");
    assert!(right.contains("CD"), "right page text: {right}");
    assert!(!right.contains("AB"), "right page text: {right}");
    assert!(left.contains('N'), "left page text: {left}");
    assert!(!left.contains('R'), "left page text: {left}");
    assert!(right.contains('R'), "right page text: {right}");
    assert!(!right.contains('N'), "right page text: {right}");
    assert!(left.contains("WX"), "left page text: {left}");
    assert!(right.contains("YZ"), "right page text: {right}");

    let left_bbox = pdftotext_page(&output, 1, &["-bbox"]);
    let right_bbox = pdftotext_page(&output, 2, &["-bbox"]);
    let left_bbox = String::from_utf8_lossy(&left_bbox.stdout);
    let right_bbox = String::from_utf8_lossy(&right_bbox.stdout);
    assert!((bbox_word_x(&left_bbox, "AB") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "CD") - 0.0).abs() < 0.1);
    assert!((bbox_word_x(&left_bbox, "N") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "R") - 0.0).abs() < 0.1);
    assert!((bbox_word_x(&left_bbox, "WX") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "YZ") - 0.0).abs() < 0.1);

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn split_text_filter_skips_an_unbalanced_graphics_state_without_aborting_cleanup() {
    let source = path("split-malformed-source", "pdf");
    let input = path("split-malformed-input", "pdf");
    let output = path("split-malformed-output", "pdf");
    let instructions = path("split-malformed-instructions", "json");
    save_single_page(
        &source,
        b"Q BT /F1 10 Tf 10 20 Td (MUST_NOT_LEAK) Tj ET".to_vec(),
        dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
    );
    save_single_page(&input, b"0 0 20 20 re f".to_vec(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let warning = String::from_utf8_lossy(&result.stderr);
    assert!(warning.contains("scan_cleanup_text_overlay_skipped"));
    assert!(warning.contains("unmatched Q"));
    let text = pdftotext_page(&output, 1, &[]);
    assert!(text.status.success());
    assert!(!String::from_utf8_lossy(&text.stdout).contains("MUST_NOT_LEAK"));

    let document = Document::load(&output).unwrap();
    let page_id = *document.get_pages().get(&1).unwrap();
    let operations = document
        .get_and_decode_page_content(page_id)
        .unwrap()
        .operations;
    assert_eq!(
        operations
            .iter()
            .filter(|operation| operation.operator == "q")
            .count(),
        operations
            .iter()
            .filter(|operation| operation.operator == "Q")
            .count()
    );

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}
