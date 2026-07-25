    #[test]
    fn reorders_pages_by_cloning_selected_page_tree() {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let first_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 200.into()],
        });
        let second_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![
                    Object::Reference(first_page_id),
                    Object::Reference(second_page_id),
                ],
                "Count" => 2,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let result = reorder_browser_pdf_pages(&bytes, &[2, 1]).unwrap();
        let reordered = Document::load_mem(&result.data).unwrap();
        let pages = reordered.get_pages();

        assert_eq!(result.page_count, 2);
        assert_eq!(
            resolve_inherited_box(&reordered, *pages.get(&1).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            300.0,
        );
        assert_eq!(
            resolve_inherited_box(&reordered, *pages.get(&2).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            100.0,
        );
    }

    #[test]
    fn rejects_delete_all_browser_pages() {
        let (mut document, _) = create_test_document();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let error = match delete_browser_pdf_pages(&bytes, &[1]) {
            Ok(_) => panic!("delete-all should be rejected"),
            Err(error) => error.to_string(),
        };

        assert!(error.contains("cannot delete every page"));
    }

    #[test]
    fn reorder_preserves_catalog_and_info_metadata() {
        let (mut document, first_page_id) = create_test_document();
        let pages_id = document
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let second_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 100.into()],
        });
        let pages = document.get_dictionary_mut(pages_id).unwrap();
        pages.set(
            "Kids",
            vec![
                Object::Reference(first_page_id),
                Object::Reference(second_page_id),
            ],
        );
        pages.set("Count", 2);

        let info_id = document.add_object(dictionary! {
            "Title" => Object::string_literal("Preserved title"),
            "Author" => Object::string_literal("EVB"),
        });
        document.trailer.set("Info", info_id);
        let catalog_id = document.root_id().unwrap();
        let catalog = document.get_dictionary_mut(catalog_id).unwrap();
        catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
        catalog.set("PageLayout", Object::Name(b"TwoColumnLeft".to_vec()));
        catalog.set("Lang", Object::string_literal("en-US"));
        catalog.set("OpenAction", Object::Reference(second_page_id));

        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let result = reorder_browser_pdf_pages(&bytes, &[2, 1]).unwrap();
        let reordered = Document::load_mem(&result.data).unwrap();
        let reordered_pages = reordered.get_pages();
        let catalog = reordered.catalog().unwrap();
        let info_id = reordered
            .trailer
            .get(b"Info")
            .unwrap()
            .as_reference()
            .unwrap();
        let info = reordered.get_dictionary(info_id).unwrap();

        assert_eq!(catalog.get(b"PageMode").unwrap().as_name().unwrap(), b"UseOutlines");
        assert_eq!(
            catalog.get(b"PageLayout").unwrap().as_name().unwrap(),
            b"TwoColumnLeft"
        );
        assert_eq!(
            pdf_string_to_text(catalog.get(b"Lang").unwrap()).unwrap(),
            "en-US"
        );
        assert_eq!(
            catalog.get(b"OpenAction").unwrap().as_reference().unwrap(),
            *reordered_pages.get(&1).unwrap()
        );
        assert_eq!(
            pdf_string_to_text(info.get(b"Title").unwrap()).unwrap(),
            "Preserved title"
        );
        assert_eq!(pdf_string_to_text(info.get(b"Author").unwrap()).unwrap(), "EVB");
    }

    #[test]
    fn inserts_pages_between_destination_pages() {
        let (mut destination, _) = create_test_document();
        let second_destination_page = destination.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 100.into()],
        });
        let destination_pages_id = destination.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        destination
            .get_dictionary_mut(second_destination_page)
            .unwrap()
            .set("Parent", destination_pages_id);
        let first_destination_page = *destination.get_pages().get(&1).unwrap();
        let destination_pages = destination.get_dictionary_mut(destination_pages_id).unwrap();
        destination_pages.set("Kids", vec![
            Object::Reference(first_destination_page),
            Object::Reference(second_destination_page),
        ]);
        destination_pages.set("Count", 2);
        let mut destination_bytes = Vec::new();
        destination.save_to(&mut destination_bytes).unwrap();

        let (mut insertion, insertion_page_id) = create_test_document();
        insertion
            .get_dictionary_mut(insertion_page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 500.into(), 100.into()]);
        let mut insertion_bytes = Vec::new();
        insertion.save_to(&mut insertion_bytes).unwrap();

        let result = insert_browser_pdf_pages(&destination_bytes, &insertion_bytes, 1).unwrap();
        let inserted = Document::load_mem(&result.data).unwrap();
        let pages = inserted.get_pages();

        assert_eq!(result.page_count, 3);
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&1).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            200.0,
        );
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&2).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            500.0,
        );
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&3).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            300.0,
        );
    }

    #[test]
    fn reports_effective_geometry_for_inherited_crop_box() {
        let (mut document, page_id) = create_test_document();
        let pages_id = document.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        document
            .get_dictionary_mut(pages_id)
            .unwrap()
            .set("CropBox", vec![20.into(), 10.into(), 180.into(), 90.into()]);
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Rotate", 90);
        let geometry = get_browser_page_geometry(&document, 1).unwrap();

        assert_eq!(geometry.media_box.width(), 200.0);
        assert_eq!(geometry.media_box.height(), 100.0);
        assert_eq!(geometry.crop_box.unwrap().width(), 160.0);
        assert_eq!(geometry.crop_box.unwrap().height(), 80.0);
        assert_eq!(geometry.rotation, 90);
    }
