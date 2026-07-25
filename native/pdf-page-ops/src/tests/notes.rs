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

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "incremental hello".to_string(),
                }],
                ..NativeMutationsFile::default()
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
    fn validates_incremental_append_tail_without_full_document_load() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let input_path = temp_pdf_path("append-tail-valid-input");
        let output_path = temp_pdf_path("append-tail-valid-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();
        let previous_document = Document::load(&input_path).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "tail validation".to_string(),
                }],
                ..NativeMutationsFile::default()
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        validate_incremental_append_output(
            &output_path,
            original_bytes.len(),
            previous_document.xref_start,
            &[target_id, popup_id],
        )
        .unwrap();

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn rejects_incremental_append_tail_with_corrupt_object_header() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
        let input_path = temp_pdf_path("append-tail-corrupt-input");
        let output_path = temp_pdf_path("append-tail-corrupt-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();
        let previous_document = Document::load(&input_path).unwrap();

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "tail corruption".to_string(),
                }],
                ..NativeMutationsFile::default()
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        let mut output_bytes = read(&output_path).unwrap();
        let object_header = format!("{} {} obj", target_id.0, target_id.1);
        let appended_offset = output_bytes[original_bytes.len()..]
            .windows(object_header.len())
            .position(|window| window == object_header.as_bytes())
            .unwrap()
            + original_bytes.len();
        let corrupt_header = vec![b'x'; object_header.len()];
        output_bytes[appended_offset..appended_offset + object_header.len()]
            .copy_from_slice(&corrupt_header);
        write(&output_path, &output_bytes).unwrap();

        let error = validate_incremental_append_output(
            &output_path,
            original_bytes.len(),
            previous_document.xref_start,
            &[target_id, popup_id],
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("does not point to its object header"));

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

        let error = append_native_mutations(
                        &input_path,
                        &output_path,
                        &NativeMutationsFile {
                            updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "incremental hello".to_string(),
                }],
                            ..NativeMutationsFile::default()
                        },
                        "D:20260609123456+03'00'",
                    )
        .unwrap_err()
        .to_string();

        assert!(error.contains("byte-for-byte copy"));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn append_seed_check_detects_same_file_aliases() {
        let input_path = temp_pdf_path("append-same-file-detect");
        write(&input_path, b"%PDF-1.7\n").unwrap();
        let alias_path = input_path
            .parent()
            .unwrap()
            .join(".")
            .join(input_path.file_name().unwrap());
        let other_path = temp_pdf_path("append-other-file-detect");
        write(&other_path, b"%PDF-1.7\n").unwrap();

        assert!(append_paths_refer_to_same_file(&input_path, &input_path));
        assert!(append_paths_refer_to_same_file(&input_path, &alias_path));
        assert!(!append_paths_refer_to_same_file(&input_path, &other_path));

        let _ = remove_file(input_path);
        let _ = remove_file(other_path);
    }

    #[test]
    fn appends_note_text_update_when_input_and_output_are_same_file() {
        let (mut document, target_id, popup_id) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("append-in-place");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "same path update".to_string(),
                }],
                ..NativeMutationsFile::default()
            },
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

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(target_id.0),
                    generation_number: Some(target_id.1),
                    stable_key: None,
                    created_at: None,
                }],
                ..NativeMutationsFile::default()
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

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
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
                ..NativeMutationsFile::default()
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                free_text_notes: Vec::new(),
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: None,
                    generation_number: None,
                    stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                    created_at: Some(1781009077000),
                }],
                ..NativeMutationsFile::default()
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

        append_native_mutations(
            &input_path,
            &output_path,
            &NativeMutationsFile {
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
                ..NativeMutationsFile::default()
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

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
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
                ..NativeMutationsFile::default()
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
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
                ..NativeMutationsFile::default()
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

    #[test]
    fn appended_revision_reads_written_objects_over_the_untouched_base_revision() {
        let (mut document, target_id, _) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("appended-revision-overlay");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        let mut incremental = IncrementalDocument::load(&pdf_path).unwrap();
        update_note_text_incremental(
            &mut incremental,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "overlaid text".to_string(),
            }],
            "D:20260609123456Z",
        )
        .unwrap();

        let revision = AppendedRevision::new(&incremental);
        let catalog_id = revision.root_id().unwrap();
        assert!(!incremental.new_document.objects.contains_key(&catalog_id));
        assert_eq!(
            revision
                .dictionary(catalog_id)
                .unwrap()
                .get(b"Type")
                .unwrap()
                .as_name()
                .unwrap(),
            b"Catalog"
        );
        assert_eq!(
            revision
                .dictionary(target_id)
                .unwrap()
                .get(b"Contents")
                .unwrap()
                .as_str()
                .unwrap(),
            encode_pdf_text_string("overlaid text").as_slice()
        );
        assert_eq!(revision.page_ids().len(), 1);

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn appended_revision_postconditions_reject_text_that_was_not_written() {
        let (mut document, target_id, _) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("appended-revision-mismatch");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        let mut incremental = IncrementalDocument::load(&pdf_path).unwrap();
        update_note_text_incremental(
            &mut incremental,
            &[NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "written text".to_string(),
            }],
            "D:20260609123456Z",
        )
        .unwrap();

        let error = validate_appended_revision_postconditions(
            &AppendedRevision::new(&incremental),
            &NativeMutationsFile {
                updates: vec![NoteTextUpdate {
                    object_number: target_id.0,
                    generation_number: target_id.1,
                    text: "some other text".to_string(),
                }],
                ..NativeMutationsFile::default()
            },
            "D:20260609123456Z",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("Contents did not match requested text"));

        let _ = remove_file(pdf_path);
    }

    #[test]
    fn rejects_the_removed_incremental_validation_flag() {
        let error = parse_args(
            [
                "save-mutations",
                "--input",
                "input.pdf",
                "--output",
                "output.pdf",
                "--mutations-file",
                "mutations.json",
                "--modified-at",
                "D:20260609123456Z",
                "--append",
                "--incremental-validation",
                "tail-only",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("Unknown argument: --incremental-validation"));
    }

    #[test]
    fn append_compares_a_seeded_output_past_the_first_read_chunk() {
        let (mut document, target_id, _) = create_test_note_pdf();
        document.add_object(Object::Stream(Stream::new(
            dictionary! {},
            vec![b'p'; 96 * 1024],
        )));
        let input_path = temp_pdf_path("append-seed-chunked-input");
        let output_path = temp_pdf_path("append-seed-chunked-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        assert!(original_bytes.len() > 64 * 1024);
        write(&input_path, &original_bytes).unwrap();

        let mut divergent_bytes = original_bytes.clone();
        divergent_bytes[70 * 1024] ^= 0xff;
        write(&output_path, &divergent_bytes).unwrap();
        let mutations = NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "chunked seed".to_string(),
            }],
            ..NativeMutationsFile::default()
        };
        let error = append_native_mutations(
            &input_path,
            &output_path,
            &mutations,
            "D:20260609123456Z",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("byte-for-byte copy"));

        write(&output_path, &original_bytes).unwrap();
        append_native_mutations(
            &input_path,
            &output_path,
            &mutations,
            "D:20260609123456Z",
        )
        .unwrap();
        let appended_bytes = read(&output_path).unwrap();
        assert!(appended_bytes.starts_with(&original_bytes));
        assert!(appended_bytes.len() > original_bytes.len());

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn reports_an_unreadable_append_payload_as_an_invalid_request() {
        let (mut document, _, _) = create_test_note_pdf();
        let pdf_path = temp_pdf_path("append-invalid-payload");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();
        let mutations_path = pdf_path.with_extension("mutations.json");
        write(&mutations_path, b"{\"updates\":\"not-a-list\"}").unwrap();

        let error = mutate_pdf(Config {
            operation: Operation::SaveMutations {
                mutations_file: mutations_path.clone(),
                modified_at: "D:20260609123456Z".to_string(),
                append: true,
            },
            input_path: pdf_path.clone(),
            output_path: pdf_path.clone(),
        })
        .unwrap_err();
        assert_eq!(
            evb_native_support::NativeErrorEnvelope::from_error(error.as_ref()).code,
            NativeErrorCode::InvalidRequest
        );

        let _ = remove_file(pdf_path);
        let _ = remove_file(mutations_path);
    }
