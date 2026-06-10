    #[test]
    fn appends_page_labels_and_bookmarks_as_incremental_revision() {
        let (mut document, _page_id) = create_test_document();
        let input_path = temp_pdf_path("append-metadata-input");
        let output_path = temp_pdf_path("append-metadata-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: Some(PageLabelsMutation {
                    total_pages: 1,
                    ranges: vec![PageLabelRange {
                        start_page: 1,
                        style: Some("r".to_string()),
                        prefix: "intro-".to_string(),
                        start_number: 3,
                    }],
                }),
                bookmarks: Some(BookmarksMutation {
                    total_pages: 1,
                    untitled_label: "Untitled".to_string(),
                    items: vec![BookmarkEntry {
                        title: "Chapter 1".to_string(),
                        page_index: Some(0),
                        named_dest: None,
                        bold: true,
                        italic: false,
                        color: Some("#336699".to_string()),
                        items: Vec::new(),
                    }],
                }),
                shapes: None,
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let page_labels = resolve_dictionary_object(
            &loaded,
            catalog(&loaded).get(b"PageLabels").unwrap(),
            "PageLabels",
        )
        .unwrap();
        let nums = page_labels.get(b"Nums").unwrap().as_array().unwrap();
        assert_eq!(nums.len(), 2);
        let range = nums[1].as_dict().unwrap();
        assert_eq!(range.get(b"S").unwrap().as_name().unwrap(), b"r");
        assert_eq!(
            pdf_string_to_text(range.get(b"P").unwrap()).unwrap(),
            "intro-"
        );
        assert_eq!(range.get(b"St").unwrap().as_i64().unwrap(), 3);

        let outlines_ref = catalog(&loaded)
            .get(b"Outlines")
            .unwrap()
            .as_reference()
            .unwrap();
        let outlines = loaded.get_dictionary(outlines_ref).unwrap();
        assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 1);
        let first_ref = outlines.get(b"First").unwrap().as_reference().unwrap();
        let first = loaded.get_dictionary(first_ref).unwrap();
        assert_eq!(
            pdf_string_to_text(first.get(b"Title").unwrap()).unwrap(),
            "Chapter 1"
        );
        assert!(first.get(b"Dest").is_ok());
        assert_eq!(first.get(b"F").unwrap().as_i64().unwrap(), 2);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_metadata_removal_as_incremental_revision() {
        let (mut document, _page_id) = create_test_document();
        set_page_labels(
            &mut document,
            &PageLabelsMutation {
                total_pages: 1,
                ranges: vec![PageLabelRange {
                    start_page: 1,
                    style: Some("A".to_string()),
                    prefix: "old-".to_string(),
                    start_number: 2,
                }],
            },
        )
        .unwrap();
        set_bookmarks(
            &mut document,
            &BookmarksMutation {
                total_pages: 1,
                untitled_label: "Untitled".to_string(),
                items: vec![BookmarkEntry {
                    title: "Old".to_string(),
                    page_index: Some(0),
                    named_dest: None,
                    bold: false,
                    italic: false,
                    color: None,
                    items: Vec::new(),
                }],
            },
        )
        .unwrap();

        let pdf_path = temp_pdf_path("append-metadata-removal");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: Some(PageLabelsMutation {
                    total_pages: 1,
                    ranges: vec![PageLabelRange {
                        start_page: 1,
                        style: Some("D".to_string()),
                        prefix: String::new(),
                        start_number: 1,
                    }],
                }),
                bookmarks: Some(BookmarksMutation {
                    total_pages: 1,
                    untitled_label: "Untitled".to_string(),
                    items: Vec::new(),
                }),
                shapes: None,
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let catalog = catalog(&loaded);
        assert!(catalog.get(b"PageLabels").is_err());
        assert!(catalog.get(b"Outlines").is_err());

        let _ = remove_file(pdf_path);
    }
