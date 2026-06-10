    #[test]
    fn updates_note_text_on_target_and_popup() {
        let mut document = Document::with_version("1.7");
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "FreeText",
            "Contents" => Object::string_literal("old target"),
            "Popup" => popup_id,
        });

        update_annotation_text_by_ref(
            &mut document,
            target_id,
            "hello \u{1F642}",
            "D:20260609123456+03'00'",
        )
        .unwrap();

        assert_eq!(
            string_bytes(&document, target_id, b"Contents"),
            encode_pdf_text_string("hello \u{1F642}")
        );
        assert_eq!(
            string_bytes(&document, popup_id, b"Contents"),
            encode_pdf_text_string("hello \u{1F642}")
        );
        assert_eq!(
            string_bytes(&document, target_id, b"M"),
            b"D:20260609123456+03'00'".to_vec()
        );
    }

    #[test]
    fn updates_popup_parent_when_target_is_popup() {
        let mut document = Document::with_version("1.7");
        let parent_id = document.add_object(dictionary! {
            "Subtype" => "Text",
            "Contents" => Object::string_literal("old parent"),
        });
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
            "Parent" => parent_id,
        });

        update_annotation_text_by_ref(&mut document, popup_id, "edited", "D:20260609123456Z")
            .unwrap();

        assert_eq!(
            string_bytes(&document, popup_id, b"Contents"),
            encode_pdf_text_string("edited")
        );
        assert_eq!(
            string_bytes(&document, parent_id, b"Contents"),
            encode_pdf_text_string("edited")
        );
    }

    #[test]
    fn reports_missing_note_text_update_targets() {
        let mut document = Document::with_version("1.7");
        let updates = vec![NoteTextUpdate {
            object_number: 404,
            generation_number: 0,
            text: "missing".to_string(),
        }];

        assert!(update_note_text(&mut document, &updates, "D:20260609123456Z").is_err());
    }

    #[test]
    fn appends_note_text_update_as_incremental_revision() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let input_path = temp_pdf_path("append-input");
        let output_path = temp_pdf_path("append-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_text_update(
            &input_path,
            &output_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
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
        assert_eq!(
            string_bytes(&loaded, target_id, b"Contents"),
            encode_pdf_text_string("incremental hello")
        );
        assert_eq!(
            string_bytes(&loaded, popup_id, b"Contents"),
            encode_pdf_text_string("incremental hello")
        );

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn append_note_text_update_requires_output_copy() {
        let (mut document, target_id, _) = create_test_note_pdf();
        let input_path = temp_pdf_path("append-copy-input");
        let output_path = temp_pdf_path("append-copy-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        let wrong_same_size_bytes = vec![b'x'; original_bytes.len()];
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &wrong_same_size_bytes).unwrap();

        let error = append_note_text_update(
            &input_path,
            &output_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
            "D:20260609123456+03'00'",
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("byte-for-byte copy"));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_note_text_update_when_input_and_output_are_same_file() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("append-in-place");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_text_update(
            &pdf_path,
            &pdf_path,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "same path update".to_string(),
            }],
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&pdf_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());

        let loaded = Document::load(&pdf_path).unwrap();
        assert_eq!(
            string_bytes(&loaded, target_id, b"Contents"),
            encode_pdf_text_string("same path update")
        );
        assert_eq!(
            string_bytes(&loaded, popup_id, b"Contents"),
            encode_pdf_text_string("same path update")
        );

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_annotation_delete_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "Text",
            "Contents" => Object::string_literal("note"),
            "Popup" => popup_id,
        });
        let unrelated_id = document.add_object(dictionary! {
            "Subtype" => "Highlight",
            "Contents" => Object::string_literal("keep"),
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![
                Object::Reference(target_id),
                Object::Reference(popup_id),
                Object::Reference(unrelated_id),
            ],
        );
        let input_path = temp_pdf_path("append-delete-input");
        let output_path = temp_pdf_path("append-delete-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_changes(
            &input_path,
            &output_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(target_id.0),
                    generation_number: Some(target_id.1),
                    stable_key: None,
                    created_at: None,
                }],
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect();
        assert!(!refs.contains(&target_id));
        assert!(!refs.contains(&popup_id));
        assert!(refs.contains(&unrelated_id));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn appends_free_text_note_delete_by_stable_key_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-free-text-delete-stable-key");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "delete me".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: Some(1781009077000),
                }],
                deletes: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: None,
                    generation_number: None,
                    stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                    created_at: Some(1781009077000),
                }],
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect();
        assert!(refs.iter().all(|object_id| {
            !annotation_matches_stable_delete_name(
                &loaded,
                *object_id,
                &AnnotationDelete {
                    page_index: 0,
                    object_number: None,
                    generation_number: None,
                    stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                    created_at: Some(1781009077000),
                },
            )
            .unwrap()
        }));

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appends_free_text_note_as_incremental_revision() {
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-free-text-input");
        let output_path = temp_pdf_path("append-free-text-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();

        append_note_changes(
            &input_path,
            &output_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "native editor note".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: Some("Tester".to_string()),
                    color: Some("rgba(255, 204, 0, 0.8)".to_string()),
                    created_at: Some(1781009077000),
                }],
                deletes: Vec::new(),
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
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let free_text_ref = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "freetext")
                    .unwrap_or(false)
            })
            .unwrap();
        let popup_ref = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "popup")
                    .unwrap_or(false)
            })
            .unwrap();
        let free_text = loaded.get_dictionary(free_text_ref).unwrap();
        let popup = loaded.get_dictionary(popup_ref).unwrap();
        let rect = parse_rect(free_text.get(b"Rect").unwrap()).unwrap();

        assert_eq!(
            string_bytes(&loaded, free_text_ref, b"Contents"),
            encode_pdf_text_string("native editor note")
        );
        assert_eq!(
            string_bytes(&loaded, popup_ref, b"Contents"),
            encode_pdf_text_string("native editor note")
        );
        assert_eq!(
            pdf_string_to_text(free_text.get(b"NM").unwrap()).unwrap(),
            "evb-note:uid:0:pdfjs_internal_editor_0:created:1781009077000"
        );
        assert_eq!(annotation_related_ref(free_text, b"Popup"), Some(popup_ref));
        assert_eq!(
            annotation_related_ref(popup, b"Parent"),
            Some(free_text_ref)
        );
        assert!(free_text.get(b"AP").is_ok());
        assert_approximately(rect.width(), 0.32);
        assert_approximately(rect.height(), 0.16);

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn repeated_free_text_note_append_updates_existing_named_note() {
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("append-free-text-repeat");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "first text".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: None,
                }],
                deletes: Vec::new(),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();
        append_note_changes(
            &pdf_path,
            &pdf_path,
            &NoteChangesFile {
                updates: Vec::new(),
                free_text_notes: vec![FreeTextNote {
                    page_index: 0,
                    stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                    text: "second text".to_string(),
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                    author: None,
                    color: None,
                    created_at: None,
                }],
                deletes: Vec::new(),
            },
            "D:20260609123500+03'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        let free_text_refs: Vec<ObjectId> = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .filter(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .map(|dict| annotation_subtype(dict) == "freetext")
                    .unwrap_or(false)
            })
            .collect();

        assert_eq!(free_text_refs.len(), 1);
        assert_eq!(
            string_bytes(&loaded, free_text_refs[0], b"Contents"),
            encode_pdf_text_string("second text")
        );

        let _ = remove_file(pdf_path);
    }
