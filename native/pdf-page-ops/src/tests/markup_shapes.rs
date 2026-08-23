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
    fn appends_ink_with_a_preview_compatible_normal_appearance() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-ink-appearance");
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
                    shapes: vec![ink_shape("evb-shape:ink-1", "#2563eb")],
                    deleted_annotation_ids: Vec::new(),
                    deleted_stable_keys: Vec::new(),
                }),
                markup: None,
                placed_images: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let ink_ref = annots[0].as_reference().unwrap();
        let ink = loaded.get_dictionary(ink_ref).unwrap();
        assert_eq!(annotation_subtype(ink), "ink");
        assert_eq!(ink.get(b"F").unwrap().as_i64().unwrap() & 4, 4);
        let appearance_ref = ink
            .get(b"AP")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"N")
            .unwrap()
            .as_reference()
            .unwrap();
        let appearance = loaded.get_object(appearance_ref).unwrap().as_stream().unwrap();
        assert_eq!(
            appearance.dict.get(b"Subtype").unwrap().as_name().unwrap(),
            b"Form"
        );
        assert!(appearance.dict.get(b"BBox").is_ok());
        assert!(appearance.dict.get(b"Resources").is_ok());
        let content = String::from_utf8(appearance.content.clone()).unwrap();
        assert!(content.contains("/GS0 gs"));
        assert!(content.contains("1 J"));
        assert!(content.contains("1 j"));
        assert!(content.contains(" m\n"));
        assert!(content.contains(" l\n"));
        assert!(content.ends_with("S\nQ\n"));

        let _ = remove_file(pdf_path);
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

    fn embedded_shape_pdf(annotations: &[(&str, Dictionary)]) -> (Document, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let mut annots = Vec::new();
        for (stable_key, dict) in annotations {
            let object_id = document.add_object(Object::Dictionary(dict.clone()));
            write_managed_shape_stable_key(
                document.get_dictionary_mut(object_id).unwrap(),
                Some(stable_key),
            );
            annots.push(Object::Reference(object_id));
        }
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", annots);
        (document, page_id)
    }

    fn seed_shape_pdf(document: &mut Document, label: &str) -> PathBuf {
        let path = temp_pdf_path(label);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        write(&path, &bytes).unwrap();
        path
    }

    fn shape_rect_values(document: &Document, stable_key: &str) -> Vec<f64> {
        let page_id = *document.get_pages().values().next().unwrap();
        for object in get_page_annots(document, page_id).unwrap() {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            let Ok(dict) = document.get_dictionary(object_id) else {
                continue;
            };
            if read_managed_shape_stable_key(dict).as_deref() != Some(stable_key) {
                continue;
            }
            return dict
                .get(b"Rect")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_float().unwrap() as f64)
                .collect();
        }
        panic!("shape {stable_key} is missing from the saved document");
    }

    fn shape_dict<'a>(document: &'a Document, stable_key: &str) -> &'a Dictionary {
        let page_id = *document.get_pages().values().next().unwrap();
        for object in get_page_annots(document, page_id).unwrap() {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            let Ok(dict) = document.get_dictionary(object_id) else {
                continue;
            };
            if read_managed_shape_stable_key(dict).as_deref() == Some(stable_key) {
                return dict;
            }
        }
        panic!("shape {stable_key} is missing from the saved document");
    }

    fn off_page_square_dict() -> Dictionary {
        dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            // Crosses the left and top page edges of the 200x100 test page.
            "Rect" => vec![(-20).into(), 40.into(), 60.into(), 120.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
        }
    }

    fn on_page_square_dict() -> Dictionary {
        dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
        }
    }

    /// Marker geometry the importer derives from `off_page_square_dict`: the
    /// rect is clamped into the unit page box, which shifts its left/top edges.
    fn imported_off_page_square(stable_key: &str) -> ShapeAnnotation {
        let mut shape = rectangle_shape(stable_key, "#336699");
        shape.fill_color = None;
        shape.x = 0.0;
        shape.y = 0.0;
        shape.width = 0.4;
        shape.height = 0.8;
        shape
    }

    fn imported_on_page_square(stable_key: &str) -> ShapeAnnotation {
        let mut shape = rectangle_shape(stable_key, "#336699");
        shape.fill_color = None;
        shape.x = 0.1;
        shape.y = 0.4;
        shape.width = 0.4;
        shape.height = 0.4;
        shape
    }

    fn shapes_mutation(shapes: Vec<ShapeAnnotation>) -> NativeMutationsFile {
        NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: Vec::new(),
            deletes: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes,
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            }),
            markup: None,
            placed_images: Vec::new(),
        }
    }

    #[test]
    fn keeps_the_source_rect_of_an_untouched_off_page_square() {
        let (mut document, _page_id) = embedded_shape_pdf(&[
            ("evb-shape:off-page", off_page_square_dict()),
            ("evb-shape:on-page", on_page_square_dict()),
        ]);
        let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-preserve");

        let mut edited = imported_on_page_square("evb-shape:on-page");
        edited.x = 0.2;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![
                imported_off_page_square("evb-shape:off-page"),
                edited,
            ]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        assert_eq!(
            shape_rect_values(&loaded, "evb-shape:off-page"),
            vec![-20.0, 40.0, 60.0, 120.0]
        );
        let edited_rect = shape_rect_values(&loaded, "evb-shape:on-page");
        assert_approximately(edited_rect[0], 40.0);
        assert_approximately(edited_rect[2], 120.0);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn rewrites_the_rect_of_an_edited_off_page_square() {
        let (mut document, _page_id) =
            embedded_shape_pdf(&[("evb-shape:off-page", off_page_square_dict())]);
        let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-edited");

        let mut moved = imported_off_page_square("evb-shape:off-page");
        moved.x = 0.15;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![moved]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let rect = shape_rect_values(&loaded, "evb-shape:off-page");
        assert_approximately(rect[0], 30.0);
        assert_approximately(rect[2], 110.0);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn drops_a_stale_line_interior_color_and_keeps_a_polygon_fill() {
        let line_dict = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Line",
            "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
            "L" => vec![20.into(), 20.into(), 100.into(), 60.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
            // A Line has no interior; the value is stale metadata.
            "IC" => vec![1.into(), 0.into(), 0.into()],
        };
        let polygon_dict = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Polygon",
            "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
            "Vertices" => vec![20.into(), 20.into(), 100.into(), 60.into(), 60.into(), 80.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
            "IC" => vec![0.into(), 0.into(), 1.into()],
        };
        let (mut document, _page_id) = embedded_shape_pdf(&[
            ("evb-shape:line", line_dict),
            ("evb-shape:polygon", polygon_dict),
        ]);
        let pdf_path = seed_shape_pdf(&mut document, "shape-line-interior-color");

        let mut line = rectangle_shape("evb-shape:line", "#000000");
        line.shape_type = "line".to_string();
        line.fill_color = None;
        line.x = 0.1;
        line.y = 0.4;
        line.x2 = Some(0.5);
        line.y2 = Some(0.8);
        let mut polygon = rectangle_shape("evb-shape:polygon", "#000000");
        polygon.shape_type = "polygon".to_string();
        polygon.fill_color = Some("#0000ff".to_string());
        polygon.points = vec![
            ShapePoint { x: 0.1, y: 0.8 },
            ShapePoint { x: 0.5, y: 0.4 },
            ShapePoint { x: 0.3, y: 0.2 },
        ];

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![line, polygon]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        assert!(shape_dict(&loaded, "evb-shape:line").get(b"IC").is_err());
        let polygon_interior = shape_dict(&loaded, "evb-shape:polygon")
            .get(b"IC")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap() as f64)
            .collect::<Vec<_>>();
        assert_approximately(polygon_interior[0], 0.0);
        assert_approximately(polygon_interior[1], 0.0);
        assert_approximately(polygon_interior[2], 1.0);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn keeps_the_source_rect_on_the_full_rewrite_shape_route() {
        let (mut document, _page_id) = embedded_shape_pdf(&[
            ("evb-shape:off-page", off_page_square_dict()),
            ("evb-shape:on-page", on_page_square_dict()),
        ]);

        let mut edited = imported_on_page_square("evb-shape:on-page");
        edited.y = 0.5;
        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![imported_off_page_square("evb-shape:off-page"), edited],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        assert_eq!(
            shape_rect_values(&document, "evb-shape:off-page"),
            vec![-20.0, 40.0, 60.0, 120.0]
        );
        let edited_rect = shape_rect_values(&document, "evb-shape:on-page");
        assert_approximately(edited_rect[1], 10.0);
        assert_approximately(edited_rect[3], 50.0);
    }

    fn off_page_circle_dict() -> Dictionary {
        dictionary! {
            "Type" => "Annot",
            "Subtype" => "Circle",
            // Crosses the left and top page edges of the 200x100 test page.
            "Rect" => vec![(-20).into(), 40.into(), 60.into(), 120.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
        }
    }

    /// Square and Circle share one branch of the shape writer, so an assertion
    /// that only covers Square proves nothing about the ellipse subtype.
    #[test]
    fn keeps_the_source_rect_of_an_untouched_off_page_circle() {
        let (mut document, _page_id) =
            embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);
        let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-circle-preserve");

        let mut circle = imported_off_page_square("evb-shape:off-page-circle");
        circle.shape_type = "circle".to_string();
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![circle]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        assert_eq!(
            shape_rect_values(&loaded, "evb-shape:off-page-circle"),
            vec![-20.0, 40.0, 60.0, 120.0]
        );

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn rewrites_the_rect_of_an_edited_off_page_circle() {
        let (mut document, _page_id) =
            embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);
        let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-circle-edited");

        let mut circle = imported_off_page_square("evb-shape:off-page-circle");
        circle.shape_type = "circle".to_string();
        circle.x = 0.15;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![circle]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let rect = shape_rect_values(&loaded, "evb-shape:off-page-circle");
        assert_approximately(rect[0], 30.0);
        assert_approximately(rect[2], 110.0);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn keeps_the_source_rect_of_an_untouched_off_page_circle_on_the_full_rewrite_route() {
        let (mut document, _page_id) =
            embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);

        let mut circle = imported_off_page_square("evb-shape:off-page-circle");
        circle.shape_type = "circle".to_string();
        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![circle],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        assert_eq!(
            shape_rect_values(&document, "evb-shape:off-page-circle"),
            vec![-20.0, 40.0, 60.0, 120.0]
        );
    }

    /// `/Rect` may be an indirect array. Reading it off the dictionary alone
    /// sees a reference, reports "no rect", and rewrites geometry nobody edited.
    fn embedded_shape_pdf_with_indirect_rect(
        stable_key: &str,
        subtype: &str,
        rect: Vec<Object>,
    ) -> (Document, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let rect_id = document.add_object(Object::Array(rect));
        let object_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Annot",
            "Subtype" => subtype,
            "Rect" => Object::Reference(rect_id),
            "C" => vec![0.into(), 0.into(), 0.into()],
        }));
        write_managed_shape_stable_key(
            document.get_dictionary_mut(object_id).unwrap(),
            Some(stable_key),
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(object_id)]);
        (document, object_id)
    }

    fn resolved_shape_rect_values(document: &Document, object_id: ObjectId) -> Vec<f64> {
        let dict = document.get_dictionary(object_id).unwrap();
        let rect = document.resolved(dict.get(b"Rect").unwrap()).unwrap();
        rect.as_array()
            .unwrap()
            .iter()
            .map(|value| {
                document
                    .resolved(value)
                    .unwrap()
                    .as_float()
                    .unwrap_or_else(|_| value.as_i64().unwrap() as f32) as f64
            })
            .collect()
    }

    #[test]
    fn keeps_an_indirect_source_rect_of_an_untouched_off_page_square() {
        let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
            "evb-shape:indirect",
            "Square",
            vec![(-20).into(), 40.into(), 60.into(), 120.into()],
        );
        let pdf_path = seed_shape_pdf(&mut document, "shape-indirect-rect-preserve");

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &shapes_mutation(vec![imported_off_page_square("evb-shape:indirect")]),
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        assert_eq!(
            resolved_shape_rect_values(&loaded, object_id),
            vec![-20.0, 40.0, 60.0, 120.0]
        );

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn keeps_an_indirect_source_rect_on_the_full_rewrite_shape_route() {
        let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
            "evb-shape:indirect",
            "Circle",
            vec![(-20).into(), 40.into(), 60.into(), 120.into()],
        );

        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![imported_off_page_square("evb-shape:indirect")],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        assert_eq!(
            resolved_shape_rect_values(&document, object_id),
            vec![-20.0, 40.0, 60.0, 120.0]
        );
    }

    #[test]
    fn rewrites_an_indirect_source_rect_when_the_shape_moved() {
        let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
            "evb-shape:indirect",
            "Square",
            vec![(-20).into(), 40.into(), 60.into(), 120.into()],
        );

        let mut moved = imported_off_page_square("evb-shape:indirect");
        moved.x = 0.15;
        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![moved],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let rect = resolved_shape_rect_values(&document, object_id);
        assert_approximately(rect[0], 30.0);
        assert_approximately(rect[2], 110.0);
    }
