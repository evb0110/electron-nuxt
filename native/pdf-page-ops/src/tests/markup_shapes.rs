    #[test]
    fn appends_markup_subtype_rewrite_as_incremental_revision() {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
        let input_path = temp_pdf_path("append-markup-input");
        let output_path = temp_pdf_path("append-markup-output");
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
                page_labels: None,
                bookmarks: None,
                shapes: None,
                markup: Some(MarkupMutation {
                    overrides: Vec::new(),
                    hints: vec![MarkupSubtypeHint {
                        subtype: "Squiggly".to_string(),
                        page_index: 0,
                        marker_rect: MarkerRect {
                            left: 0.1,
                            top: 0.5,
                            width: 0.4,
                            height: 0.3,
                        },
                        annotation_id: Some(format_pdfjs_annotation_ref(markup_id)),
                        color: Some("#00ff00".to_string()),
                        id: None,
                        page_markup_index: Some(0),
                        source: Some("editor-live".to_string()),
                    }],
                }),
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let markup = loaded.get_dictionary(markup_id).unwrap();
        assert_eq!(
            canonical_markup_subtype(markup).as_deref(),
            Some("Squiggly")
        );
        assert!(markup.get(b"QuadPoints").is_ok());
        assert!(markup.get(b"AP").is_ok());
        let color = markup.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 0.0);
        assert_approximately(color[1].as_float().unwrap() as f64, 1.0);
        assert_approximately(color[2].as_float().unwrap() as f64, 0.0);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_highlight_color_rewrite_as_display_rgb() {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
        let pdf_path = temp_pdf_path("append-highlight-color");
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
                page_labels: None,
                bookmarks: None,
                shapes: None,
                markup: Some(MarkupMutation {
                    overrides: Vec::new(),
                    hints: vec![MarkupSubtypeHint {
                        subtype: "Highlight".to_string(),
                        page_index: 0,
                        marker_rect: MarkerRect {
                            left: 0.1,
                            top: 0.5,
                            width: 0.4,
                            height: 0.3,
                        },
                        annotation_id: Some(format_pdfjs_annotation_ref(markup_id)),
                        color: Some("#ff0000".to_string()),
                        id: None,
                        page_markup_index: Some(0),
                        source: Some("pdf".to_string()),
                    }],
                }),
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let markup = loaded.get_dictionary(markup_id).unwrap();
        let color = markup.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 1.0);
        assert_approximately(color[1].as_float().unwrap() as f64, 166.0 / 255.0);
        assert_approximately(color[2].as_float().unwrap() as f64, 166.0 / 255.0);
        assert_eq!(markup.get(b"CA").unwrap().as_i64().unwrap(), 1);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_managed_shape_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-shape-input");
        let output_path = temp_pdf_path("append-shape-output");
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
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![rectangle_shape("evb-shape:rect-1", "#336699")],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: Vec::new(),
                }),
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        assert_eq!(annots.len(), 1);
        let shape_ref = annots[0].as_reference().unwrap();
        let shape = loaded.get_dictionary(shape_ref).unwrap();
        assert_eq!(annotation_subtype(shape), "square");
        assert_eq!(
            read_managed_shape_stable_key(shape).as_deref(),
            Some("evb-shape:rect-1")
        );
        assert_eq!(
            pdf_string_to_text(shape.get(b"EVBShapeKey").unwrap()).unwrap(),
            "evb-shape:rect-1"
        );
        assert!(shape.get(b"Rect").is_ok());
        assert!(shape.get(b"C").is_ok());
        assert!(shape.get(b"IC").is_ok());
        assert_eq!(shape.get(b"CA").unwrap().as_float().unwrap(), 0.5);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn updates_and_deletes_managed_shapes_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-shape-update-delete");
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
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![
                        rectangle_shape("evb-shape:keep", "#336699"),
                        rectangle_shape("evb-shape:delete", "#ff0000"),
                    ],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: Vec::new(),
                }),
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let mut updated = rectangle_shape("evb-shape:keep", "#112233");
        updated.x = 0.2;
        updated.y = 0.25;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: Vec::new(),
                page_labels: None,
                bookmarks: None,
                shapes: Some(ShapesMutation {
                    total_pages: 1,
                    rewrite_shape_state: true,
                    shapes: vec![updated],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: vec!["evb-shape:delete".to_string()],
                }),
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let shape_refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .filter(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| is_supported_shape_subtype(&annotation_subtype(dict)))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(shape_refs.len(), 1);
        let shape = loaded.get_dictionary(shape_refs[0]).unwrap();
        assert_eq!(
            read_managed_shape_stable_key(shape).as_deref(),
            Some("evb-shape:keep")
        );
        let color = shape.get(b"C").unwrap().as_array().unwrap();
        assert_approximately(color[0].as_float().unwrap() as f64, 0x11 as f64 / 255.0);
        assert!(annots.iter().all(|object| {
            object
                .as_reference()
                .ok()
                .and_then(|object_id| loaded.get_dictionary(object_id).ok())
                .and_then(read_managed_shape_stable_key)
                .as_deref()
                != Some("evb-shape:delete")
        }));

        let _ = remove_file(pdf_path);
    }
