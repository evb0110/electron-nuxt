use super::*;

#[test]
fn leaves_non_spread_input_unchanged() {
    let binary = BinaryImage::from_fn_parallel(8, 8, |x, y| x == y);
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::IDENTITY,
        Affine::IDENTITY,
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let (kept, removed) = run(Input {
        binary: &binary,
        picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        blank_leaf: false,
        dpi: 300.0,
    });
    assert_eq!(kept, binary);
    assert_eq!(removed.count_black(), 0);
}
