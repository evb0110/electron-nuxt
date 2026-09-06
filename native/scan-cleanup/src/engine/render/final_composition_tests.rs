use super::*;

#[test]
fn mixed_composition_emits_binary_core_on_white_background() {
    let gray = GrayImage::new(4, 3, 200);
    let binary = BinaryImage::from_fn_parallel(4, 3, |x, y| x == 1 && y == 1);
    let picture_mask = BinaryImage::new(4, 3);
    let (output, color, layers) = run(Input {
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
    assert_eq!(output.get(1, 1), 0);
    assert_eq!(output.get(0, 0), 255);
    assert!(color.is_none());
    assert!(layers.is_none());
}
