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
            IncrementalValidationMode::Full,
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
            IncrementalValidationMode::Full,
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
            IncrementalValidationMode::Full,
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
    fn parse_pdf_color_rejects_non_ascii_hex_without_panic() {
        let parsed = std::panic::catch_unwind(|| parse_pdf_color(Some("#\u{e9}a")));

        assert!(parsed.is_ok());
        assert!(parsed.unwrap().is_none());
        assert!(parse_pdf_color(Some("#abc")).is_some());
        assert!(parse_pdf_color(Some("#aabbcc")).is_some());
    }

    #[test]
    fn validates_required_shape_color() {
        for color in ["#\u{e9}a", "transparent", "none", ""] {
            let mut shape = rectangle_shape("evb-shape:invalid-color", color);
            shape.fill_color = Some("transparent".to_string());

            let error = validate_shapes_mutation(&ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![shape],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            })
            .unwrap_err()
            .to_string();

            assert!(error.contains("Invalid shape color"));
        }
    }

    fn test_markup_hint(index: usize) -> MarkupSubtypeHint {
        MarkupSubtypeHint {
            subtype: "Highlight".to_string(),
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.0,
                top: 0.0,
                width: 1.0,
                height: 1.0,
            },
            annotation_id: None,
            color: Some("#ffff00".to_string()),
            id: Some(format!("hint-{index}")),
            page_markup_index: Some(index as u32),
            source: None,
        }
    }

    #[test]
    fn caps_text_markup_hints_before_matching() {
        let hints = (0..=MAX_MARKUP_SUBTYPE_HINTS)
            .map(test_markup_hint)
            .collect();

        let error = validate_markup_mutation(&MarkupMutation {
            overrides: Vec::new(),
            hints,
        })
        .expect_err("oversized hint list must fail");

        assert!(error.to_string().contains("Too many text-markup mutations"));
    }

    #[test]
    fn bounds_dense_markup_assignment_comparisons() {
        let hints: Vec<_> = (0..MAX_MARKUP_SUBTYPE_HINTS)
            .map(|index| {
                let hint = test_markup_hint(index);
                MarkupHintState {
                    annotation_ref: None,
                    color: parse_css_rgb_color(hint.color.as_deref()),
                    hint,
                    consumed: false,
                }
            })
            .collect();
        let candidates: Vec<_> = (0..129)
            .map(|index| MarkupAnnotationCandidate {
                color: Some(RgbColor {
                    r: 255,
                    g: 255,
                    b: 0,
                }),
                marker_rect: Some(MarkerRect {
                    left: 0.0,
                    top: 0.0,
                    width: 1.0,
                    height: 1.0,
                }),
                object_id: (index + 1, 0),
                page_markup_index: index,
                quad_points: None,
                rect: Some(PdfRect {
                    x1: 0.0,
                    y1: 0.0,
                    x2: 1.0,
                    y2: 1.0,
                }),
                ref_tag: format!("{index}R"),
                subtype: "Highlight".to_string(),
            })
            .collect();

        let error = assign_subtype_hints_to_candidates(&hints, &candidates)
            .expect_err("pathological overlap must stop at the work budget");

        assert!(error.to_string().contains("comparison budget exceeded"));
    }

    #[test]
    fn spatial_markup_assignment_preserves_best_geometry_matches() {
        let marker_rects = [
            MarkerRect {
                left: 0.05,
                top: 0.1,
                width: 0.2,
                height: 0.1,
            },
            MarkerRect {
                left: 0.7,
                top: 0.8,
                width: 0.2,
                height: 0.1,
            },
        ];
        let hints = marker_rects
            .iter()
            .copied()
            .enumerate()
            .map(|(index, marker_rect)| MarkupSubtypeHint {
                subtype: if index == 0 { "Underline" } else { "StrikeOut" }.to_string(),
                page_index: 0,
                marker_rect,
                annotation_id: None,
                color: Some("#336699".to_string()),
                id: Some(format!("spatial-{index}")),
                page_markup_index: Some(index as u32),
                source: None,
            })
            .collect::<Vec<_>>();
        let hint_states = dedupe_markup_subtype_hints(&hints).expect("dedupe hints");
        let candidates = marker_rects
            .iter()
            .copied()
            .enumerate()
            .map(|(index, marker_rect)| MarkupAnnotationCandidate {
                color: Some(RgbColor {
                    r: 0x33,
                    g: 0x66,
                    b: 0x99,
                }),
                marker_rect: Some(marker_rect),
                object_id: (index as u32 + 1, 0),
                page_markup_index: index as u32,
                quad_points: None,
                rect: None,
                ref_tag: format!("{}R", index + 1),
                subtype: "Highlight".to_string(),
            })
            .collect::<Vec<_>>();

        let assignments = assign_subtype_hints_to_candidates(&hint_states, &candidates)
            .expect("bounded spatial assignment");

        assert_eq!(assignments, vec![(0, 0), (1, 1)]);
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
            IncrementalValidationMode::Full,
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
            IncrementalValidationMode::Full,
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
