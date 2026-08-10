    fn minimal_jpeg_bytes() -> Vec<u8> {
        vec![
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
            0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xFF, 0xD9,
        ]
    }

    fn placed_jpeg_mutation() -> PlacedImage {
        let bytes_path = temp_pdf_path("placed-image-jpeg");
        let bytes = minimal_jpeg_bytes();
        write(&bytes_path, &bytes).unwrap();
        PlacedImage {
            page_index: 0,
            x: 0.1,
            y: 0.25,
            width: 0.3,
            height: 0.2,
            rotation_degrees: Some(15.0),
            mime_type: "image/jpeg".to_string(),
            bytes_path,
            byte_length: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            validated_bytes: std::cell::RefCell::new(None),
        }
    }

    #[test]
    fn rejects_placed_image_sidecars_whose_manifest_no_longer_matches() {
        let mut image = placed_jpeg_mutation();
        image.sha256 = "0".repeat(64);
        let error = validate_placed_images(&[image]).unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::InvalidRequest);
    }

    #[test]
    fn placed_image_metadata_limits_reject_before_opening_payloads() {
        use std::cell::Cell;
        use std::fs::File;

        let mut image = placed_jpeg_mutation();
        let image_path = image.bytes_path.clone();
        File::options()
            .write(true)
            .open(&image.bytes_path)
            .unwrap()
            .set_len(5)
            .unwrap();
        image.byte_length = 4;
        let open_count = Cell::new(0usize);
        let error = validate_placed_image_payloads_with_limits_and_open(
            &[image],
            4,
            8,
            |path| {
                open_count.set(open_count.get() + 1);
                File::open(path)
            },
        )
        .unwrap_err();

        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
        assert_eq!(open_count.get(), 0);
        let _ = remove_file(image_path);
    }

    #[test]
    fn placed_image_aggregate_limit_is_checked_before_any_payload_read() {
        use std::cell::Cell;
        use std::fs::File;

        let mut images = [placed_jpeg_mutation(), placed_jpeg_mutation()];
        for image in &mut images {
            write(&image.bytes_path, b"ab").unwrap();
            image.byte_length = 2;
            image.sha256 = sha256_hex(b"ab");
        }
        let open_count = Cell::new(0usize);
        let error = validate_placed_image_payloads_with_limits_and_open(
            &images,
            4,
            3,
            |path| {
                open_count.set(open_count.get() + 1);
                File::open(path)
            },
        )
        .unwrap_err();

        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error.message.contains("3-byte aggregate admission ceiling"));
        assert_eq!(open_count.get(), 0);
        for image in images {
            let _ = remove_file(image.bytes_path);
        }
    }

    #[test]
    fn placed_image_apply_reuses_validated_bytes_after_sidecar_removal() {
        let (mut document, page_id) = create_test_document();
        let image = placed_jpeg_mutation();
        let image_path = image.bytes_path.clone();
        let mutations = NativeMutationsFile {
            placed_images: vec![image],
            ..NativeMutationsFile::default()
        };
        validate_placed_images(&mutations.placed_images).unwrap();
        remove_file(&image_path).unwrap();

        apply_native_mutations(&mut document, &mutations, "D:20260609123456Z").unwrap();

        assert_eq!(get_page_annots(&document, page_id).unwrap().len(), 1);
    }

    #[test]
    fn appends_placed_jpeg_as_incremental_stamp_annotation() {
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-placed-image-input");
        let output_path = temp_pdf_path("append-placed-image-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();
        let placed_image = placed_jpeg_mutation();
        let modified_at = "D:20260609123456+03'00'";
        let mutations = NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: Vec::new(),
            deletes: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: None,
            markup: None,
            placed_images: vec![placed_image],
        };
        append_native_mutations(
            &input_path,
            &output_path,
            &mutations,
            modified_at,
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
        let stamp_id = annots[0].as_reference().unwrap();
        let stamp = loaded.get_dictionary(stamp_id).unwrap();
        assert_eq!(annotation_subtype(stamp), "stamp");
        assert_eq!(
            stamp.get(b"NM").ok().and_then(pdf_string_to_text).as_deref(),
            Some("placed-image-native:0:0:D:20260609123456+03'00'")
        );
        assert_eq!(
            stamp.get(b"M").ok().and_then(pdf_string_to_text).as_deref(),
            Some(modified_at)
        );

        let expected = placed_image_geometry(
            &placed_jpeg_mutation(),
            resolve_page_view(&loaded, page_id).unwrap(),
            resolve_page_rotation(&loaded, page_id).unwrap(),
        )
        .unwrap();
        validate_rect_approximately(
            parse_rect(stamp.get(b"Rect").unwrap()).unwrap(),
            expected.rect,
            "placed image test rect",
        )
        .unwrap();

        let ap = stamp.get(b"AP").unwrap().as_dict().unwrap();
        let normal_ref = ap.get(b"N").unwrap().as_reference().unwrap();
        assert!(matches!(
            loaded.get_object(normal_ref).unwrap(),
            Object::Stream(_)
        ));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }
