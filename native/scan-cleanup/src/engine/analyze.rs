//! Analysis-facing engine API.

pub use super::render::{
    analyze_page, analyze_page_with_document_prior, classify_page,
    classify_page_with_document_prior, AnalysisOutputMetadata, PageAnalysisResult,
    PageClassificationResult,
};
