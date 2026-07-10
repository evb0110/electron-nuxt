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
    fn rejects_crop_when_margins_consume_page() {
        let (mut document, page_id) = create_test_document();

        let error = crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 100.0,
                bottom: 0.0,
                left: 0.0,
                right: 0.0,
            },
        )
        .expect_err("consuming margins must reject the whole operation");

        assert!(error.to_string().contains("consume page 1"));
        assert!(document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }

    #[test]
    fn preflights_every_selected_page_before_mutating_any_page() {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let first_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        });
        let second_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 20.into(), 20.into()],
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(first_page_id), Object::Reference(second_page_id)],
                "Count" => 2,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let error = crop_pages(
            &mut document,
            &[1, 2],
            CropMargins {
                top: 11.0,
                bottom: 10.0,
                left: 1.0,
                right: 1.0,
            },
        )
        .expect_err("second-page preflight must reject the whole operation");

        assert!(error.to_string().contains("consume page 2"));
        assert!(document
            .get_dictionary(first_page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
        assert!(document
            .get_dictionary(second_page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }

    #[test]
    fn rejects_non_finite_or_negative_margins_before_mutation() {
        for invalid_margin in [f64::NAN, f64::INFINITY, -1.0] {
            let (mut document, page_id) = create_test_document();
            let error = crop_pages(
                &mut document,
                &[1],
                CropMargins {
                    top: invalid_margin,
                    bottom: 0.0,
                    left: 0.0,
                    right: 0.0,
                },
            )
            .expect_err("invalid margin must fail");

            assert!(error.to_string().contains("Invalid top crop margin"));
            assert!(document
                .get_dictionary(page_id)
                .unwrap()
                .get(b"CropBox")
                .is_err());
        }
    }
