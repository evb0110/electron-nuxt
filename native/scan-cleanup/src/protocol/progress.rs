use crate::{
    engine::text_axis::TextAxisHint,
    mode_select::{OutputModeDiagnostics, OutputModeRecommendationReason},
    protocol::manifest_v3::VERSION,
    split::{DocumentPrior, LayoutClassification},
    OutputMode,
};
use serde::Serialize;
use std::path::PathBuf;

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageStageTimings {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub decode_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub analysis_level_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub illumination_preparation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layout_normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub calibration_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub picture_mask_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mode_recommendation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub quality_normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub text_axis_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub split_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub deskew_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub content_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rasterization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mask_rasterization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub binarization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub threshold_preparation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub thresholding_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub binary_postprocess_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mixed_composition_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub output_processing_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub render_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub write_ms: f64,
}

impl PageStageTimings {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressStage {
    Started,
    PageAnalyzed,
    PageComplete,
    Completed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: ProgressStage,
    pub completed_pages: usize,
    pub total_pages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_paths: Option<Vec<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<LayoutClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cutter_x_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier1_verdict: Option<LayoutClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_agreement: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_prior: Option<DocumentPrior>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_axis: Option<TextAxisHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_timings: Option<PageStageTimings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode: Option<OutputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode_reason: Option<OutputModeRecommendationReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_alpha_foreground_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_mode_diagnostics: Option<OutputModeDiagnostics>,
}

#[derive(Serialize)]
pub struct ProgressEnvelope {
    pub version: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub progress: Progress,
}

impl ProgressEnvelope {
    pub fn new(progress: Progress) -> Self {
        Self {
            version: VERSION,
            kind: "progress",
            progress,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_timings_are_additive_and_omit_default_fields() {
        assert_eq!(
            serde_json::to_value(PageStageTimings::default()).unwrap(),
            serde_json::json!({})
        );
        assert_eq!(
            serde_json::to_value(PageStageTimings {
                layout_normalization_ms: 12.5,
                ..PageStageTimings::default()
            })
            .unwrap(),
            serde_json::json!({"layoutNormalizationMs": 12.5})
        );
    }

    #[test]
    fn analysis_progress_matches_shared_v3_golden() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol/analysis-progress-v3.json");
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let actual = serde_json::to_value(ProgressEnvelope::new(Progress {
            stage: ProgressStage::PageAnalyzed,
            completed_pages: 2,
            total_pages: 4,
            page_number: Some(3),
            output_paths: None,
            classification: Some(LayoutClassification::SingleUncutPage),
            confidence: Some(0.91),
            cutter_x_px: None,
            tier1_verdict: Some(LayoutClassification::SingleUncutPage),
            reconciled: Some(false),
            cluster_agreement: Some(0.0),
            document_prior: None,
            text_axis: None,
            stage_timings: None,
            recommended_output_mode: Some(OutputMode::Mixed),
            recommended_output_mode_confidence: Some(0.9),
            recommended_output_mode_reason: Some(OutputModeRecommendationReason::TextWithPictures),
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
        }))
        .unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn page_complete_progress_matches_populated_shared_v3_golden() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol/page-complete-progress-v3.json");
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let actual = serde_json::to_value(ProgressEnvelope::new(Progress {
            stage: ProgressStage::PageComplete,
            completed_pages: 2,
            total_pages: 4,
            page_number: Some(2),
            output_paths: Some(vec![
                PathBuf::from("/fixtures/output/page-2-left.png"),
                PathBuf::from("/fixtures/output/page-2-right.png"),
            ]),
            classification: Some(LayoutClassification::TwoPageSpread),
            confidence: Some(0.984),
            cutter_x_px: Some(1180.0),
            tier1_verdict: Some(LayoutClassification::SingleUncutPage),
            reconciled: Some(true),
            cluster_agreement: Some(0.885),
            document_prior: Some(DocumentPrior {
                dominant_layout: LayoutClassification::TwoPageSpread,
                cutter_ratio_median: Some(0.535),
                cluster_dims: crate::split::ClusterDimensions {
                    width: 2203.0,
                    height: 1600.0,
                },
                agreement_strength: 0.885,
                stroke_width_median_px: None,
                x_height_median_px: None,
            }),
            text_axis: Some(TextAxisHint {
                sideways: true,
                confidence: 0.97,
            }),
            stage_timings: Some(PageStageTimings {
                split_ms: 12.5,
                render_ms: 24.0,
                ..PageStageTimings::default()
            }),
            recommended_output_mode: Some(OutputMode::Mixed),
            recommended_output_mode_confidence: Some(0.91),
            recommended_output_mode_reason: Some(OutputModeRecommendationReason::TextWithPictures),
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
        }))
        .unwrap();

        assert_eq!(actual, expected);
    }
}
