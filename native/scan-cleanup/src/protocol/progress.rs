use crate::{
    engine::text_axis::TextAxisHint,
    protocol::manifest_v2::VERSION,
    split::{DocumentPrior, LayoutClassification},
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
    pub split_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub deskew_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub content_ms: f64,
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
    use super::PageStageTimings;

    #[test]
    fn stage_timings_are_additive_and_omit_default_fields() {
        assert_eq!(
            serde_json::to_value(PageStageTimings::default()).unwrap(),
            serde_json::json!({})
        );
        assert_eq!(
            serde_json::to_value(PageStageTimings {
                split_ms: 12.5,
                ..PageStageTimings::default()
            })
            .unwrap(),
            serde_json::json!({"splitMs": 12.5})
        );
    }
}
