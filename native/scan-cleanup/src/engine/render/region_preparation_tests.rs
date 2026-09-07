use super::*;

#[test]
fn crops_analysis_plane_to_the_requested_region() {
    let source = GrayImage::new(20, 12, 255);
    let options = CleanupOptions::default();
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        analysis_picture_mask: None,
        tone_picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(3.0, 2.0, 7.0, 5.0),
        working_width: 7,
        working_height: 5,
    });
    assert_eq!(
        (
            output.analysis_working.width(),
            output.analysis_working.height()
        ),
        (7, 5)
    );
    assert_eq!(output.local_scale_x, 1.0);
    assert_eq!(output.local_scale_y, 1.0);
    assert!(output.text_tone_diagnostics.is_none());
}

#[test]
fn propagates_non_unit_analysis_scales_into_crop_dimensions_and_local_scales() {
    let source = GrayImage::new(100, 80, 255);
    let options = CleanupOptions::default();
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 0.5,
        analysis_scale_y: 0.25,
        analysis_picture_mask: None,
        tone_picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(10.0, 8.0, 20.0, 16.0),
        working_width: 20,
        working_height: 16,
    });

    assert_eq!(
        (
            output.analysis_working.width(),
            output.analysis_working.height()
        ),
        (10, 4)
    );
    assert_eq!(output.local_scale_x, 0.5);
    assert_eq!(output.local_scale_y, 0.25);
}
