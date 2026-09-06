//! Cross-page classification reconciliation.
use crate::cache::ByteLru;
use crate::domain::options::OutputMode;
use crate::engine::page_statistics::{
    bucket_classification, classification_bucket, dimensions_within_tolerance, median, ramp_local,
    robust_typographic_median, run_classification, PageResultMetadata, PageRunResult,
};
use crate::engine::resource_planning::page_cache_for;
use crate::engine::staged_input::{with_announced_staged_page_input, LeaseAnnouncer};
use crate::protocol::manifest_v3::{AnalysisPurpose, ManifestV3, Operation};
use crate::split::LayoutClassification;
use evb_native_support::{NativeError, NativeErrorEnvelope};
use std::error::Error;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy)]
pub(crate) struct Tier1Provenance {
    pub(crate) verdict: LayoutClassification,
    pub(crate) confidence: f64,
    pub(crate) candidate_cutter_ratio: Option<f64>,
    pub(crate) whitespace_score: f64,
}
pub(crate) fn reconcile_classification_batch(
    manifest: &ManifestV3,
    results: &mut [PageRunResult],
    cache: &Arc<Mutex<ByteLru>>,
    announce: LeaseAnnouncer<'_>,
) -> Result<(), Box<dyn Error>> {
    let eligible = results
        .iter()
        .enumerate()
        .filter(|(_, result)| {
            result.metadata.reconciliation_eligible && result.metadata.document_prior.is_none()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for index in eligible {
        let metadata = &results[index].metadata;
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            let representative = &results[cluster[0]].metadata;
            dimensions_within_tolerance(metadata.rotated_width, representative.rotated_width)
                && dimensions_within_tolerance(
                    metadata.rotated_height,
                    representative.rotated_height,
                )
        }) {
            cluster.push(index);
        } else {
            clusters.push(vec![index]);
        }
    }

    for cluster in clusters {
        let confident = cluster
            .iter()
            .copied()
            .filter(|&index| results[index].metadata.tier1_confidence >= 0.60)
            .collect::<Vec<_>>();
        let mut support = [0usize; 3];
        let mut confidence_sum = [0.0_f64; 3];
        for &index in &confident {
            let metadata = &results[index].metadata;
            let bucket = classification_bucket(metadata.tier1_verdict);
            support[bucket] += 1;
            confidence_sum[bucket] += metadata.tier1_confidence;
        }
        let Some(dominant_bucket) = (0..support.len())
            .filter(|&bucket| support[bucket] >= 2)
            .max_by(|&left, &right| {
                support[left]
                    .cmp(&support[right])
                    .then_with(|| confidence_sum[left].total_cmp(&confidence_sum[right]))
            })
        else {
            continue;
        };
        let tied = (0..support.len()).any(|bucket| {
            bucket != dominant_bucket
                && support[bucket] == support[dominant_bucket]
                && (confidence_sum[bucket] - confidence_sum[dominant_bucket]).abs() < 1e-9
        });
        if tied {
            continue;
        }
        let dominant_layout = bucket_classification(dominant_bucket);
        let dominant_count = support[dominant_bucket];
        let consensus = dominant_count as f64 / confident.len().max(1) as f64;
        let mean_confidence = confidence_sum[dominant_bucket] / dominant_count as f64;
        let mut cutter_ratios = confident
            .iter()
            .filter_map(|&index| {
                let metadata = &results[index].metadata;
                (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                    .then_some(metadata.cutter_x_px)
                    .flatten()
                    .map(|cutter| cutter / metadata.rotated_width.max(1) as f64)
            })
            .collect::<Vec<_>>();
        cutter_ratios.sort_by(f64::total_cmp);
        let cutter_ratio_median = (dominant_layout == LayoutClassification::TwoPageSpread)
            .then(|| median(&cutter_ratios))
            .flatten();
        if dominant_layout == LayoutClassification::TwoPageSpread && cutter_ratio_median.is_none() {
            continue;
        }
        let cutter_spread = cutter_ratios
            .first()
            .zip(cutter_ratios.last())
            .map_or(0.0, |(first, last)| last - first);
        let cutter_consistency = 1.0 - ramp_local(cutter_spread, 0.03, 0.12) * 0.40;
        let agreement_strength =
            (consensus * (0.65 + 0.25 * mean_confidence) * cutter_consistency).clamp(0.0, 0.95);
        let mut widths = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_width as f64)
            .collect::<Vec<_>>();
        let mut heights = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_height as f64)
            .collect::<Vec<_>>();
        widths.sort_by(f64::total_cmp);
        heights.sort_by(f64::total_cmp);
        let document_stroke_width_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].metadata.calibration_stroke_width_px),
        );
        let document_x_height_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].metadata.calibration_x_height_px),
        );
        let prior = crate::split::DocumentPrior {
            dominant_layout,
            cutter_ratio_median,
            cluster_dims: crate::split::ClusterDimensions {
                width: median(&widths).unwrap_or(1.0),
                height: median(&heights).unwrap_or(1.0),
            },
            agreement_strength,
            stroke_width_median_px: document_stroke_width_px,
            x_height_median_px: document_x_height_px,
        };

        for index in cluster {
            let metadata = &results[index].metadata;
            let candidate_is_off_prior = prior
                .cutter_ratio_median
                .zip(metadata.candidate_cutter_ratio)
                .is_some_and(|(prior_ratio, candidate_ratio)| {
                    (prior_ratio - candidate_ratio).abs() > 0.015
                });
            let rerun_with_prior = prior.dominant_layout == LayoutClassification::TwoPageSpread
                && (metadata.tier1_verdict != prior.dominant_layout
                    || metadata.tier1_confidence < 0.60
                    || candidate_is_off_prior);
            if rerun_with_prior {
                let tier1 = Tier1Provenance {
                    verdict: metadata.tier1_verdict,
                    confidence: metadata.tier1_confidence,
                    candidate_cutter_ratio: metadata.candidate_cutter_ratio,
                    whitespace_score: metadata.whitespace_score,
                };
                // Reconciliation re-reads the page, which is exactly why a
                // staged raster has to be replayable rather than consumed: the
                // lease is taken again and the owning process re-renders the
                // same input if its window already released it.
                let mut rerun = with_announced_staged_page_input(
                    manifest,
                    &manifest.pages[index],
                    announce,
                    || {
                        let page_cache = page_cache_for(&manifest.pages[index], cache)?;
                        run_classification(
                            &manifest.pages[index],
                            manifest.canvas_scope,
                            Some(prior),
                            manifest.operation == Operation::Analyze
                                || manifest.pages[index].options.output_mode == OutputMode::Auto,
                            manifest.analysis_purpose == AnalysisPurpose::PagePlan,
                            &page_cache,
                        )
                        .map_err(|error| {
                            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
                            NativeError::new(envelope.code, envelope.message)
                        })
                    },
                )?;
                rerun.timings += results[index].timings;
                results[index] = rerun;
                preserve_tier1_provenance_after_rerun(&mut results[index].metadata, tier1, prior);
                continue;
            }

            let metadata = &mut results[index].metadata;
            let tier1_cutter = (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                .then_some(metadata.cutter_x_px)
                .flatten();
            let decision = crate::split::reconcile_layout_decision(
                metadata.tier1_verdict,
                metadata.tier1_confidence,
                tier1_cutter,
                metadata.candidate_cutter_ratio,
                metadata.whitespace_score,
                metadata.rotated_width,
                metadata.rotated_height,
                prior,
            );
            metadata.layout_classification = decision.classification;
            metadata.layout_confidence = decision.confidence;
            metadata.cutter_x_px = decision.cutter_x;
            metadata.tier1_verdict = decision.reconciliation.tier1_verdict;
            metadata.reconciled = decision.reconciliation.reconciled;
            metadata.cluster_agreement = decision.reconciliation.cluster_agreement;
            metadata.document_prior = Some(prior);
            metadata.output_count = if metadata.excluded {
                0
            } else if decision.classification == LayoutClassification::TwoPageSpread {
                2
            } else {
                1
            };
            if decision.classification != LayoutClassification::TwoPageSpread {
                metadata.split_seam = None;
            }
            if decision.reconciliation.reconciled {
                metadata.outputs.clear();
            }
        }
    }
    Ok(())
}
pub(crate) fn preserve_tier1_provenance_after_rerun(
    metadata: &mut PageResultMetadata,
    tier1: Tier1Provenance,
    prior: crate::split::DocumentPrior,
) {
    metadata.tier1_verdict = tier1.verdict;
    metadata.tier1_confidence = tier1.confidence;
    metadata.candidate_cutter_ratio = tier1.candidate_cutter_ratio;
    metadata.whitespace_score = tier1.whitespace_score;
    metadata.reconciled = metadata.layout_classification != tier1.verdict;
    metadata.cluster_agreement = if metadata.layout_classification == prior.dominant_layout {
        prior.agreement_strength
    } else {
        -prior.agreement_strength
    };
    metadata.document_prior = Some(prior);
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::page_statistics::EnginePageTimings as PageStageTimings;
    use crate::engine::resource_planning::manifest_cache;
    use crate::protocol::manifest_v3::{
        AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, RenderMode, SplitSeamPolyline,
        VERSION,
    };
    use crate::split::{ClusterDimensions, DocumentPrior, LayoutClassification};
    use crate::{CleanupOptions, OrthogonalRotation};
    use scan_primitives::{GrayImage, Point};
    use std::{fs, path::PathBuf};

    #[cfg(unix)]
    #[test]
    fn reconciliation_does_not_skip_a_prior_rerun_for_nonregular_input() {
        let dir = PathBuf::from(format!("/tmp/evb-scan-reconcile-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // This direct seam intentionally bypasses ManifestV3::validate. A
        // production Analyze manifest rejects this directory before work
        // starts; reaching the decoder here proves reconciliation no longer
        // silently skips its prior rerun merely because the path is streamed.
        let input = dir.join("already-consumed-input");
        fs::create_dir(&input).unwrap();
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..4)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let result = |index: usize, verdict, confidence: f64| PageRunResult {
            outputs: Vec::new(),
            metadata: PageResultMetadata {
                source_page_index: index,
                layout_classification: verdict,
                layout_confidence: confidence,
                cutter_x_px: (verdict == LayoutClassification::TwoPageSpread).then_some(120.0),
                split_seam: None,
                rotation_degrees: OrthogonalRotation::None,
                canvas_scope: CanvasScope::default(),
                excluded: false,
                blank_outputs_skipped: 0,
                output_count: usize::from(verdict == LayoutClassification::TwoPageSpread) + 1,
                outputs: Vec::new(),
                tier1_verdict: verdict,
                reconciled: false,
                cluster_agreement: 0.0,
                split_diagnostics: crate::split::SplitDiagnostics::default(),
                document_prior: None,
                text_axis: None,
                recommended_output_mode: None,
                recommended_output_mode_confidence: None,
                recommended_output_mode_reason: None,
                soft_alpha_foreground_recommendation: None,
                output_mode_diagnostics: None,
                rotated_width: 240,
                rotated_height: 200,
                candidate_cutter_ratio: Some(0.5),
                whitespace_score: 0.9,
                reconciliation_eligible: true,
                tier1_confidence: confidence,
                calibration_stroke_width_px: None,
                calibration_x_height_px: None,
            },
            page_metadata_path: dir.join(format!("page-{index}.json")),
            timings: PageStageTimings::default(),
        };
        let mut results = vec![
            result(0, LayoutClassification::TwoPageSpread, 0.92),
            result(1, LayoutClassification::TwoPageSpread, 0.91),
            result(2, LayoutClassification::TwoPageSpread, 0.90),
            result(3, LayoutClassification::SingleUncutPage, 0.40),
        ];

        let error = reconcile_classification_batch(
            &manifest,
            &mut results,
            &manifest_cache(Operation::Analyze, None),
            &|_event, _page, _total| Ok(()),
        )
        .unwrap_err();
        assert!(!error.to_string().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reconciliation_prior_rerun_accumulates_every_stage_timing_field() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-reconcile-timings-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        let mut source = GrayImage::new(240, 200, 245);
        for y in 20..180 {
            for x in 20..110 {
                source.set(x, y, 40);
            }
        }
        fs::write(&input, crate::png::encode_gray(&source).unwrap()).unwrap();
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(8 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..4)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        // Every field carries a distinct pre-rerun measurement far above any
        // duration the rerun itself can add, so a dropped field is visible
        // regardless of machine speed.
        let seeded_timings = PageStageTimings {
            decode_ms: 1010.0,
            analysis_level_ms: 1020.0,
            normalization_ms: 1030.0,
            illumination_preparation_ms: 1040.0,
            layout_normalization_ms: 1050.0,
            calibration_ms: 1060.0,
            picture_mask_ms: 1070.0,
            mode_recommendation_ms: 1080.0,
            quality_normalization_ms: 1090.0,
            text_axis_ms: 1100.0,
            split_ms: 1110.0,
            deskew_ms: 1120.0,
            content_ms: 1130.0,
            rasterization_ms: 1140.0,
            mask_rasterization_ms: 1150.0,
            binarization_ms: 1160.0,
            threshold_preparation_ms: 1170.0,
            thresholding_ms: 1180.0,
            binary_postprocess_ms: 1190.0,
            mixed_composition_ms: 1200.0,
            output_processing_ms: 1210.0,
            render_ms: 1220.0,
            write_ms: 1230.0,
        };
        let result = |index: usize, verdict, confidence: f64, timings| PageRunResult {
            outputs: Vec::new(),
            metadata: PageResultMetadata {
                source_page_index: index,
                layout_classification: verdict,
                layout_confidence: confidence,
                cutter_x_px: (verdict == LayoutClassification::TwoPageSpread).then_some(120.0),
                split_seam: None,
                rotation_degrees: OrthogonalRotation::None,
                canvas_scope: CanvasScope::default(),
                excluded: false,
                blank_outputs_skipped: 0,
                output_count: usize::from(verdict == LayoutClassification::TwoPageSpread) + 1,
                outputs: Vec::new(),
                tier1_verdict: verdict,
                reconciled: false,
                cluster_agreement: 0.0,
                split_diagnostics: crate::split::SplitDiagnostics::default(),
                document_prior: None,
                text_axis: None,
                recommended_output_mode: None,
                recommended_output_mode_confidence: None,
                recommended_output_mode_reason: None,
                soft_alpha_foreground_recommendation: None,
                output_mode_diagnostics: None,
                rotated_width: 240,
                rotated_height: 200,
                candidate_cutter_ratio: Some(0.5),
                whitespace_score: 0.9,
                reconciliation_eligible: true,
                tier1_confidence: confidence,
                calibration_stroke_width_px: None,
                calibration_x_height_px: None,
            },
            page_metadata_path: dir.join(format!("page-{index}.json")),
            timings,
        };
        let mut results = vec![
            result(
                0,
                LayoutClassification::TwoPageSpread,
                0.92,
                PageStageTimings::default(),
            ),
            result(
                1,
                LayoutClassification::TwoPageSpread,
                0.91,
                PageStageTimings::default(),
            ),
            result(
                2,
                LayoutClassification::TwoPageSpread,
                0.90,
                PageStageTimings::default(),
            ),
            result(
                3,
                LayoutClassification::SingleUncutPage,
                0.40,
                seeded_timings,
            ),
        ];

        reconcile_classification_batch(
            &manifest,
            &mut results,
            &manifest_cache(Operation::Analyze, None),
            &|_event, _page, _total| Ok(()),
        )
        .unwrap();

        let reconciled = &results[3];
        assert!(
            reconciled.timings.decode_ms >= 1010.0,
            "decode_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.analysis_level_ms >= 1020.0,
            "analysis_level_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.normalization_ms >= 1030.0,
            "normalization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.illumination_preparation_ms >= 1040.0,
            "illumination_preparation_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.layout_normalization_ms >= 1050.0,
            "layout_normalization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.calibration_ms >= 1060.0,
            "calibration_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.picture_mask_ms >= 1070.0,
            "picture_mask_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.mode_recommendation_ms >= 1080.0,
            "mode_recommendation_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.quality_normalization_ms >= 1090.0,
            "quality_normalization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.text_axis_ms >= 1100.0,
            "text_axis_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.split_ms >= 1110.0,
            "split_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.deskew_ms >= 1120.0,
            "deskew_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.content_ms >= 1130.0,
            "content_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.rasterization_ms >= 1140.0,
            "rasterization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.mask_rasterization_ms >= 1150.0,
            "mask_rasterization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.binarization_ms >= 1160.0,
            "binarization_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.threshold_preparation_ms >= 1170.0,
            "threshold_preparation_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.thresholding_ms >= 1180.0,
            "thresholding_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.binary_postprocess_ms >= 1190.0,
            "binary_postprocess_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.mixed_composition_ms >= 1200.0,
            "mixed_composition_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.output_processing_ms >= 1210.0,
            "output_processing_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.render_ms >= 1220.0,
            "render_ms must accumulate the pre-rerun measurement"
        );
        assert!(
            reconciled.timings.write_ms >= 1230.0,
            "write_ms must accumulate the pre-rerun measurement"
        );
        // Tier-1 provenance and the document prior describe the original
        // measurement, not the prior-seeded rerun.
        assert_eq!(
            reconciled.metadata.tier1_verdict,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(reconciled.metadata.tier1_confidence, 0.40);
        assert_eq!(reconciled.metadata.candidate_cutter_ratio, Some(0.5));
        assert_eq!(reconciled.metadata.whitespace_score, 0.9);
        assert_eq!(
            reconciled
                .metadata
                .document_prior
                .map(|prior| prior.dominant_layout),
            Some(LayoutClassification::TwoPageSpread)
        );
        assert_eq!(
            reconciled.metadata.reconciled,
            reconciled.metadata.layout_classification != LayoutClassification::SingleUncutPage
        );
        for confident in &results[..3] {
            assert_eq!(confident.timings, PageStageTimings::default());
            assert_eq!(
                confident.metadata.tier1_verdict,
                LayoutClassification::TwoPageSpread
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prior_rerun_preserves_unbiased_tier1_provenance() {
        let seam = SplitSeamPolyline {
            points: vec![Point::new(120.0, 0.0), Point::new(121.0, 200.0)],
        };
        let mut metadata = PageResultMetadata {
            source_page_index: 3,
            layout_classification: LayoutClassification::TwoPageSpread,
            layout_confidence: 0.92,
            cutter_x_px: Some(121.0),
            split_seam: Some(seam.clone()),
            rotation_degrees: OrthogonalRotation::None,
            canvas_scope: CanvasScope::default(),
            excluded: false,
            blank_outputs_skipped: 0,
            output_count: 2,
            outputs: Vec::new(),
            tier1_verdict: LayoutClassification::TwoPageSpread,
            reconciled: false,
            cluster_agreement: 0.9,
            split_diagnostics: crate::split::SplitDiagnostics::default(),
            document_prior: None,
            text_axis: None,
            recommended_output_mode: None,
            recommended_output_mode_confidence: None,
            recommended_output_mode_reason: None,
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
            rotated_width: 240,
            rotated_height: 200,
            candidate_cutter_ratio: Some(0.505),
            whitespace_score: 0.8,
            reconciliation_eligible: true,
            tier1_confidence: 0.0,
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
        };
        let tier1 = Tier1Provenance {
            verdict: LayoutClassification::SingleUncutPage,
            confidence: 0.47,
            candidate_cutter_ratio: Some(0.49),
            whitespace_score: 0.18,
        };
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.5),
            cluster_dims: ClusterDimensions {
                width: 240.0,
                height: 200.0,
            },
            agreement_strength: 0.9,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };

        preserve_tier1_provenance_after_rerun(&mut metadata, tier1, prior);

        assert_eq!(
            metadata.tier1_verdict,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(metadata.tier1_confidence, 0.47);
        assert_eq!(metadata.candidate_cutter_ratio, Some(0.49));
        assert_eq!(metadata.whitespace_score, 0.18);
        assert!(metadata.reconciled);
        assert_eq!(metadata.cluster_agreement, 0.9);
        assert_eq!(metadata.document_prior, Some(prior));
        assert_eq!(metadata.output_count, 2);
        assert_eq!(metadata.split_seam, Some(seam));
    }
}
