    #[test]
    fn crops_pages_using_inherited_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();

        assert_eq!(crop_box(&document, page_id), vec![2.0, 3.0, 199.0, 96.0]);
    }

    #[test]
    fn remove_crop_restores_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();
        remove_crop_from_pages(&mut document, &[1]).unwrap();

        assert_eq!(crop_box(&document, page_id), vec![0.0, 0.0, 200.0, 100.0]);
    }

    #[test]
    fn skips_crop_when_margins_consume_page() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 100.0,
                bottom: 0.0,
                left: 0.0,
                right: 0.0,
            },
        )
        .unwrap();

        assert!(document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }
