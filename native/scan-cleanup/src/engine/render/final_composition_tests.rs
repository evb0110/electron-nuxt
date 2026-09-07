use super::*;

#[test]
fn mixed_composition_emits_binary_core_on_white_background() {
    let gray = GrayImage::new(4, 3, 200);
    let binary = BinaryImage::from_fn_parallel(4, 3, |x, y| x == 1 && y == 1);
    let picture_mask = BinaryImage::new(4, 3);
    let output = run(Input {
        gray: &gray,
        raw_gray: None,
        color: None,
        binary: &binary,
        picture_mask: &picture_mask,
        chroma_picture_mask: None,
        removed_edge_bands: None,
        text_mask: None,
        text_vicinity_mask: None,
        dpi: 300.0,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        create_layers: false,
        create_composite: true,
    });
    assert_eq!(output.gray.get(1, 1), 0);
    assert_eq!(output.gray.get(0, 0), 255);
    assert!(output.color.is_none());
    assert!(output.mixed_layers.is_none());
}

#[test]
fn mixed_composition_preserves_color_owned_photo_pixels_and_layers() {
    let gray = GrayImage::new(20, 10, 200);
    let mut color = RgbImage::new(20, 10, [200, 200, 200]);
    color.set(15, 5, [12, 34, 56]);
    let binary = BinaryImage::from_fn_parallel(20, 10, |x, y| x == 0 && y == 0);
    let picture_mask = BinaryImage::from_fn_parallel(20, 10, |x, y| x == 15 && y == 5);
    let chroma_picture_mask = picture_mask.clone();
    let output = run(Input {
        gray: &gray,
        raw_gray: None,
        color: Some(&color),
        binary: &binary,
        picture_mask: &picture_mask,
        chroma_picture_mask: Some(&chroma_picture_mask),
        removed_edge_bands: None,
        text_mask: None,
        text_vicinity_mask: None,
        dpi: 300.0,
        preserve_confirmed_photo_tones: true,
        use_soft_alpha_foreground: false,
        create_layers: true,
        create_composite: true,
    });

    assert_eq!((output.gray.width(), output.gray.height()), (20, 10));
    assert_eq!(output.gray.get(15, 5), 200);
    assert_eq!(
        output.color.as_ref().expect("chroma output").get(15, 5),
        [12, 34, 56]
    );
    let layers = output.mixed_layers.expect("requested mixed layers");
    assert_eq!(
        (layers.background.width(), layers.background.height()),
        (20, 10)
    );
    assert!(layers.color_background.is_some());
    assert!(layers.foreground_mask.get(0, 0));
}

#[test]
fn soft_alpha_composition_exposes_foreground_coverage_in_layers() {
    let gray = GrayImage::new(4, 3, 100);
    let binary = BinaryImage::from_fn_parallel(4, 3, |x, y| x == 1 && y == 1);
    let picture_mask = BinaryImage::new(4, 3);
    let output = run(Input {
        gray: &gray,
        raw_gray: None,
        color: None,
        binary: &binary,
        picture_mask: &picture_mask,
        chroma_picture_mask: None,
        removed_edge_bands: None,
        text_mask: None,
        text_vicinity_mask: None,
        dpi: 300.0,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: true,
        create_layers: true,
        create_composite: true,
    });

    assert_eq!(output.gray.get(1, 1), 100);
    let layers = output.mixed_layers.expect("requested soft-alpha layers");
    assert_eq!(
        layers
            .foreground_alpha
            .as_ref()
            .expect("alpha plane")
            .get(1, 1),
        155
    );
    assert!(layers.color_background.is_none());
}

#[test]
fn composition_without_layers_returns_only_the_requested_gray_plane() {
    let gray = GrayImage::new(3, 2, 180);
    let binary = BinaryImage::from_fn_parallel(3, 2, |x, y| x == 0 && y == 0);
    let picture_mask = BinaryImage::new(3, 2);
    let output = run(Input {
        gray: &gray,
        raw_gray: None,
        color: None,
        binary: &binary,
        picture_mask: &picture_mask,
        chroma_picture_mask: None,
        removed_edge_bands: None,
        text_mask: None,
        text_vicinity_mask: None,
        dpi: 300.0,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        create_layers: false,
        create_composite: false,
    });

    assert_eq!((output.gray.width(), output.gray.height()), (3, 2));
    assert_eq!(output.gray.get(0, 0), 255);
    assert!(output.color.is_none());
    assert!(output.mixed_layers.is_none());
}
