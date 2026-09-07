use super::*;
use crate::split::FoldBand;

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
    let Output { kept, removed } = run(Input {
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

#[test]
fn geometry_stage_maps_fold_samples_and_content_rectangle() {
    let region = Rect::new(0.0, 0.0, 4.0, 8.0);
    let plan = ComposedRenderPlan::new(
        region,
        Affine::scaling(2.0, 3.0),
        Affine::scaling(0.5, 1.0 / 3.0),
        None,
        8,
        24,
        Rect::new(0.0, 0.0, 8.0, 24.0),
    );
    let geometry = prepare_fold_geometry(FoldGeometryInput {
        half: PageHalf::Left,
        region,
        render_plan: &plan,
        source_content_box: Some(Rect::new(1.0, 2.0, 2.0, 3.0)),
    })
    .expect("the synthetic fold samples must map");

    assert_eq!(geometry.samples.first(), Some(&(0.0, 8.0)));
    assert_eq!(geometry.samples.last(), Some(&(24.0, 8.0)));
    assert_eq!(geometry.edge_x_at(12.0), 8.0);
    assert_eq!(
        geometry.rendered_content_rect,
        Some(Rect::new(2.0, 6.0, 4.0, 9.0))
    );
}

#[test]
fn retention_stage_reports_removed_pixels_and_respects_picture_ownership() {
    let height = 120;
    let split = crate::split::detect_split(
        &GrayImage::new(200, height, 255),
        300.0,
        crate::LayoutMode::TwoPage,
        None,
    );
    assert_eq!(split.classification, LayoutClassification::TwoPageSpread);
    let region = Rect::new(0.0, 0.0, 100.0, height as f64);
    let plan = ComposedRenderPlan::new(
        region,
        Affine::IDENTITY,
        Affine::IDENTITY,
        None,
        100,
        height,
        Rect::new(0.0, 0.0, 100.0, height as f64),
    );
    let mut binary = BinaryImage::new(100, height);
    for y in 50..52 {
        for x in 98..100 {
            binary.set(x, y, true);
        }
    }
    let output = run(Input {
        binary: &binary,
        picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        half: PageHalf::Left,
        split: &split,
        region,
        render_plan: &plan,
        source_content_box: None,
        blank_leaf: false,
        dpi: 300.0,
    });
    assert!(output.removed.count_black() > 0);
    assert_eq!(
        output.kept.count_black() + output.removed.count_black(),
        binary.count_black()
    );

    let mut picture_mask = BinaryImage::new(100, height);
    picture_mask.set(98, 50, true);
    let geometry = prepare_fold_geometry(FoldGeometryInput {
        half: PageHalf::Left,
        region,
        render_plan: &plan,
        source_content_box: None,
    })
    .expect("the synthetic fold samples must map");
    let context = prepare_filter_context(FilterContextInput {
        binary: &binary,
        picture_mask: Some(&picture_mask),
        text_mask: None,
        text_vicinity_mask: None,
        half: PageHalf::Left,
        fold_geometry: &geometry,
        blank_leaf: false,
        dpi: 300.0,
        split: &split,
    });
    let labels = classify_rail_candidates(&context);
    let kept = retain_fragments(&context, &labels);
    assert!(kept.get(98, 50));
}

#[test]
fn rail_stage_without_measured_gutter_preserves_all_component_labels() {
    let binary = BinaryImage::from_fn_parallel(16, 16, |x, y| x == 7 && (4..12).contains(&y));
    let split = crate::split::single_page(16, 16);
    let region = Rect::new(0.0, 0.0, 16.0, 16.0);
    let plan = ComposedRenderPlan::new(
        region,
        Affine::IDENTITY,
        Affine::IDENTITY,
        None,
        16,
        16,
        region,
    );
    let geometry = prepare_fold_geometry(FoldGeometryInput {
        half: PageHalf::Left,
        region,
        render_plan: &plan,
        source_content_box: None,
    })
    .expect("the synthetic fold samples must map");
    let context = prepare_filter_context(FilterContextInput {
        binary: &binary,
        picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        half: PageHalf::Left,
        fold_geometry: &geometry,
        blank_leaf: false,
        dpi: 300.0,
        split: &split,
    });
    let labels = classify_rail_candidates(&context);
    assert!(labels.iter().all(|claimed| !claimed));
}

#[test]
fn rail_stage_groups_aligned_ragged_components_and_marks_them_for_removal() {
    let height = 180;
    let mut split = crate::split::detect_split(
        &GrayImage::new(800, height, 255),
        300.0,
        crate::LayoutMode::TwoPage,
        None,
    );
    split.cutter_x = Some(400.0);
    split.diagnostics.fold_band = FoldBand::measured(390.0, 410.0);
    let region = Rect::new(400.0, 0.0, 400.0, height as f64);
    let plan = ComposedRenderPlan::new(
        region,
        Affine::IDENTITY,
        Affine::IDENTITY,
        None,
        400,
        height,
        Rect::new(0.0, 0.0, 400.0, height as f64),
    );
    let mut binary = BinaryImage::new(400, height);
    for y in 25..145 {
        binary.set(0, y, true);
        binary.set(1, y, true);
        if y % 4 != 0 {
            for x in 2..6 {
                binary.set(x, y, true);
            }
        }
    }
    let geometry = prepare_fold_geometry(FoldGeometryInput {
        half: PageHalf::Right,
        region,
        render_plan: &plan,
        source_content_box: None,
    })
    .expect("the synthetic fold samples must map");
    let context = prepare_filter_context(FilterContextInput {
        binary: &binary,
        picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        half: PageHalf::Right,
        fold_geometry: &geometry,
        blank_leaf: false,
        dpi: 300.0,
        split: &split,
    });
    let labels = classify_rail_candidates(&context);
    assert!(labels.iter().any(|claimed| *claimed));
    let kept = retain_fragments(&context, &labels);
    assert_eq!(kept.count_black(), 0);
}
