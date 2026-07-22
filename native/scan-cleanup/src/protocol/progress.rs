use crate::{
    engine::text_axis::TextAxisHint,
    protocol::manifest_v2::VERSION,
    split::{DocumentPrior, LayoutClassification},
};
use serde::Serialize;
use std::path::PathBuf;

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
