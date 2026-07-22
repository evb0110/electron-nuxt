use crate::{analysis::build_analysis_level, deskew::detect_skew, LayoutMode};
use scan_primitives::{
    morphology::{open, reconstruct_binary},
    threshold::{otsu_threshold, threshold_global},
    Affine, BinaryImage, ComponentMap, GrayImage, Point, Polygon,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

const SPLIT_ANALYSIS_DPI: f64 = 150.0;
const MAX_EVIDENCE_DISAGREEMENT: f64 = 0.04;
const MAX_OFFCUT_WIDTH_FRACTION: f64 = 0.18;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutClassification {
    SingleUncutPage,
    PageWithOffcut,
    TwoPageSpread,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClusterDimensions {
    #[serde(rename = "widthPx")]
    pub width: f64,
    #[serde(rename = "heightPx")]
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPrior {
    pub dominant_layout: LayoutClassification,
    pub cutter_ratio_median: Option<f64>,
    pub cluster_dims: ClusterDimensions,
    pub agreement_strength: f64,
}

impl DocumentPrior {
    pub fn validate(self) -> Result<(), String> {
        if !self.cluster_dims.width.is_finite()
            || !self.cluster_dims.height.is_finite()
            || self.cluster_dims.width <= 0.0
            || self.cluster_dims.height <= 0.0
        {
            return Err("Document prior cluster dimensions must be positive and finite".into());
        }
        if !self.agreement_strength.is_finite() || !(0.0..=1.0).contains(&self.agreement_strength) {
            return Err("Document prior agreement strength must be within 0..=1".into());
        }
        if self
            .cutter_ratio_median
            .is_some_and(|ratio| !ratio.is_finite() || !(0.20..=0.80).contains(&ratio))
        {
            return Err("Document prior cutter ratio must be within 0.20..=0.80".into());
        }
        if self.dominant_layout == LayoutClassification::TwoPageSpread
            && self.cutter_ratio_median.is_none()
        {
            return Err("A spread document prior requires a cutter ratio".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationMetadata {
    pub tier1_verdict: LayoutClassification,
    pub reconciled: bool,
    pub cluster_agreement: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutDecision {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub reconciliation: ReconciliationMetadata,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SplitDiagnostics {
    pub analysis_dpi: f64,
    pub deskew_angle_degrees: f64,
    pub deskew_confidence: f64,
    pub whitespace_x: f64,
    pub fold_x: f64,
    pub decision_x: f64,
    pub whitespace_score: f64,
    pub bilateral_score: f64,
    pub left_page_score: f64,
    pub right_page_score: f64,
    pub left_content_score: f64,
    pub right_content_score: f64,
    pub left_surface_score: f64,
    pub right_surface_score: f64,
    pub outer_margin_score: f64,
    pub gutter_score: f64,
    pub agreement_score: f64,
    pub fold_score: f64,
    pub gutter_darkness_score: f64,
    pub soft_gutter_score: f64,
    pub soft_gutter_coverage: f64,
    pub aspect_ratio: f64,
    pub aspect_spread_score: f64,
    pub aspect_single_score: f64,
    pub independent_spread_cues: usize,
    pub offcut_boundary_score: f64,
    pub offcut_empty_score: f64,
    pub offcut_width_score: f64,
    pub offcut_no_text_rows_score: f64,
    pub alternative_product: f64,
    pub evidence_product: f64,
    pub abstained: bool,
}

#[derive(Clone, Debug)]
pub struct SplitResult {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub pages: Vec<Polygon>,
    pub diagnostics: SplitDiagnostics,
    pub reconciliation: ReconciliationMetadata,
    pub(crate) reusable_binary: Option<BinaryImage>,
}

impl SplitResult {
    pub(crate) fn apply_document_prior(
        &mut self,
        width: usize,
        height: usize,
        prior: DocumentPrior,
    ) {
        let candidate_ratio = (self.diagnostics.decision_x > 0.0)
            .then_some(self.diagnostics.decision_x / width.max(1) as f64);
        let decision = reconcile_layout_decision(
            self.classification,
            self.confidence,
            self.cutter_x,
            candidate_ratio,
            self.diagnostics.whitespace_score,
            width,
            height,
            prior,
        );
        self.classification = decision.classification;
        self.confidence = decision.confidence;
        self.cutter_x = decision.cutter_x;
        self.reconciliation = decision.reconciliation;
        self.diagnostics.evidence_product = decision.confidence;
        self.pages = match decision.cutter_x {
            Some(cutter) => vec![
                page_polygon(0.0, cutter, height),
                page_polygon(cutter, width as f64, height),
            ],
            None => vec![page_polygon(0.0, width as f64, height)],
        };
    }

    /// A lossy analysis level may still prove a spread from independent bilateral
    /// evidence, but it must not authorize destructive edge removal. Preserve
    /// the analysis diagnostics while converting that uncertain offcut to the
    /// classifier's normal fail-closed single-page result.
    pub(crate) fn abstain_from_resolution_limited_offcut(&mut self) {
        if self.classification != LayoutClassification::PageWithOffcut {
            return;
        }
        self.diagnostics.abstained = true;
        self.diagnostics.alternative_product = self.diagnostics.evidence_product;
        self.confidence = single_confidence(&self.diagnostics);
        self.diagnostics.evidence_product = self.confidence;
        self.classification = LayoutClassification::SingleUncutPage;
        self.reconciliation.tier1_verdict = LayoutClassification::SingleUncutPage;
        self.cutter_x = None;
        let width = self
            .pages
            .iter()
            .flat_map(|page| page.points.iter())
            .map(|point| point.x)
            .fold(0.0, f64::max);
        let height = self
            .pages
            .iter()
            .flat_map(|page| page.points.iter())
            .map(|point| point.y)
            .fold(0.0, f64::max);
        self.pages = vec![page_polygon(0.0, width, height.ceil() as usize)];
    }
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    x: f64,
    score: f64,
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct FoldCandidate {
    x: f64,
    score: f64,
    vertical_coverage: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct SoftGutterCandidate {
    x: f64,
    score: f64,
    vertical_coverage: f64,
}

struct AnalysisImage<'a> {
    gray: Cow<'a, GrayImage>,
    binary: BinaryImage,
    cleaned: BinaryImage,
    dpi: f64,
    deskew_angle_degrees: f64,
    deskew_confidence: f64,
}

pub fn detect_split(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
) -> SplitResult {
    detect_split_impl(gray, dpi, mode, manual_split_x, false, None)
}

pub(crate) fn detect_split_at_analysis_level_with_threshold(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
    threshold: u8,
) -> SplitResult {
    detect_split_impl(gray, dpi, mode, manual_split_x, true, Some(threshold))
}

fn detect_split_impl(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
    already_bounded: bool,
    threshold: Option<u8>,
) -> SplitResult {
    if let Some(cutter) = manual_split_x {
        // A manually positioned cutter in Auto mode is an explicit spread
        // decision. Treating Auto as single here discarded the two halves on
        // the next preview and made the cutter disappear from the editor.
        let classification = if matches!(mode, LayoutMode::Auto) {
            LayoutClassification::TwoPageSpread
        } else {
            mode_classification(mode)
        };
        return split_at(
            gray.width(),
            gray.height(),
            cutter.clamp(1.0, gray.width().saturating_sub(1) as f64),
            classification,
            1.0,
            SplitDiagnostics::default(),
        );
    }
    if !matches!(mode, LayoutMode::Auto) {
        return if matches!(mode, LayoutMode::Single) {
            single(
                gray.width(),
                gray.height(),
                1.0,
                SplitDiagnostics::default(),
            )
        } else {
            split_at(
                gray.width(),
                gray.height(),
                gray.width() as f64 * 0.5,
                mode_classification(mode),
                1.0,
                SplitDiagnostics::default(),
            )
        };
    }

    let analysis = prepare_analysis(gray, dpi, already_bounded, threshold);
    let whitespace = whitespace_candidate(&analysis.cleaned, true);
    let offcut_whitespace = whitespace_candidate(&analysis.cleaned, false);
    let aspect_ratio = analysis.gray.width() as f64 / analysis.gray.height().max(1) as f64;
    let fold = (aspect_ratio >= 1.0)
        .then(|| fold_line_candidate(&analysis.gray))
        .flatten();
    let mut diagnostics = SplitDiagnostics {
        analysis_dpi: analysis.dpi,
        deskew_angle_degrees: analysis.deskew_angle_degrees,
        deskew_confidence: analysis.deskew_confidence,
        fold_score: fold.map_or(0.0, |candidate| candidate.score),
        fold_x: fold.map_or(0.0, |candidate| candidate.x),
        aspect_ratio,
        aspect_spread_score: ramp(aspect_ratio, 1.15, 1.40),
        aspect_single_score: ramp(1.15 - aspect_ratio, 0.0, 0.35),
        ..SplitDiagnostics::default()
    };

    if aspect_ratio >= 1.0 {
        if let Some(mut result) =
            spread_decision(gray, &analysis, whitespace, fold, &mut diagnostics)
        {
            if analysis.deskew_angle_degrees == 0.0 {
                result.reusable_binary = Some(analysis.binary);
            }
            return result;
        }
    }
    if let Some(mut result) = offcut_decision(gray, &analysis, offcut_whitespace, &mut diagnostics)
    {
        if analysis.deskew_angle_degrees == 0.0 {
            result.reusable_binary = Some(analysis.binary);
        }
        return result;
    }

    diagnostics.abstained = whitespace.is_some() || offcut_whitespace.is_some() || fold.is_some();
    let confidence = single_confidence(&diagnostics);
    diagnostics.alternative_product = diagnostics.evidence_product;
    diagnostics.evidence_product = confidence;
    let mut result = single(gray.width(), gray.height(), confidence, diagnostics);
    if analysis.deskew_angle_degrees == 0.0 {
        result.reusable_binary = Some(analysis.binary);
    }
    result
}

fn prepare_analysis(
    gray: &GrayImage,
    dpi: f64,
    already_bounded: bool,
    threshold: Option<u8>,
) -> AnalysisImage<'_> {
    let (working, analysis_dpi) = if already_bounded {
        (Cow::Borrowed(gray), dpi)
    } else {
        let level = build_analysis_level(gray, dpi, SPLIT_ANALYSIS_DPI);
        (Cow::Owned(level.image), level.dpi)
    };
    // Portrait sheets are overwhelmingly single-page candidates in this policy,
    // and the fold search already tolerates small line slopes. Reserve the
    // comparatively expensive global deskew pass for spread-shaped geometry.
    let should_deskew = working.width() as f64 / working.height().max(1) as f64 >= 1.15;
    let deskew = should_deskew.then(|| detect_skew(&working, analysis_dpi));
    let deskewed = if deskew.is_some_and(|result| result.accepted) {
        Cow::Owned(rotate_gray(
            &working,
            -deskew.map_or(0.0, |result| result.angle_degrees),
        ))
    } else {
        working
    };
    let threshold = if deskew.is_some_and(|result| result.accepted) {
        otsu_threshold(&deskewed)
    } else {
        threshold.unwrap_or_else(|| otsu_threshold(&deskewed))
    };
    let binary = threshold_global(&deskewed, threshold);
    let cleaned = shadow_cleaned_binary(&binary, analysis_dpi);
    AnalysisImage {
        gray: deskewed,
        binary,
        cleaned,
        dpi: analysis_dpi,
        deskew_angle_degrees: deskew.map_or(0.0, |result| result.angle_degrees),
        deskew_confidence: deskew.map_or(0.0, |result| result.confidence),
    }
}

fn spread_decision(
    original: &GrayImage,
    analysis: &AnalysisImage<'_>,
    whitespace: Option<Candidate>,
    fold: Option<FoldCandidate>,
    diagnostics: &mut SplitDiagnostics,
) -> Option<SplitResult> {
    let whitespace = whitespace?;
    let position = whitespace.x / analysis.gray.width().max(1) as f64;
    if !(0.28..=0.72).contains(&position) {
        return None;
    }

    let local_fold = fold_candidate_near_whitespace(&analysis.gray, whitespace);
    let agrees = fold.is_some_and(|candidate| {
        let distance = (candidate.x - whitespace.x).abs() / analysis.gray.width().max(1) as f64;
        distance <= MAX_EVIDENCE_DISAGREEMENT
    });
    let agreed_global = fold.filter(|_| agrees);
    let selected_fold = match (local_fold, agreed_global) {
        (Some(local), Some(global)) if global.score > local.score => Some(global),
        (Some(local), _) => Some(local),
        (None, global) => global,
    };
    let fold_score = selected_fold.map_or(0.0, |candidate| candidate.score);
    let fold_x = selected_fold.map_or(whitespace.x, |candidate| candidate.x);
    let fold_darkness = gutter_darkness_score(&analysis.gray, fold_x);
    let (shadow_x, shadow_score) = darkest_gutter_position(&analysis.gray, whitespace);
    let soft_gutter = soft_gutter_candidate(&analysis.gray, whitespace);
    let (line_decision_x, gutter_darkness) = if shadow_score > fold_darkness {
        (shadow_x, shadow_score)
    } else {
        (fold_x, fold_darkness)
    };
    let decision_x = soft_gutter
        .filter(|candidate| candidate.score > gutter_darkness.max(fold_score))
        .map_or(line_decision_x, |candidate| candidate.x);
    let agreement_score = if fold.is_some() && !agrees { 0.65 } else { 1.0 };
    let soft_gutter_score = soft_gutter.map_or(0.0, |candidate| candidate.score);
    let gutter_score = gutter_darkness.max(fold_score).max(soft_gutter_score) * agreement_score;
    let bilateral = bilateral_page_score(&analysis.cleaned, &analysis.gray, decision_x);
    let outer_margins = outer_margin_score(&analysis.cleaned, &analysis.binary, decision_x);
    let (confidence, independent_spread_cues) = spread_confidence(
        whitespace.score,
        bilateral.score,
        outer_margins,
        fold_score,
        soft_gutter_score,
        diagnostics.aspect_spread_score,
    );

    diagnostics.whitespace_score = whitespace.score;
    diagnostics.whitespace_x = whitespace.x;
    diagnostics.fold_x = selected_fold.map_or(diagnostics.fold_x, |candidate| candidate.x);
    diagnostics.decision_x = decision_x;
    diagnostics.bilateral_score = bilateral.score;
    diagnostics.left_page_score = bilateral.left.page_score;
    diagnostics.right_page_score = bilateral.right.page_score;
    diagnostics.left_content_score = bilateral.left.content_score;
    diagnostics.right_content_score = bilateral.right.content_score;
    diagnostics.left_surface_score = bilateral.left.surface_score;
    diagnostics.right_surface_score = bilateral.right.surface_score;
    diagnostics.outer_margin_score = outer_margins;
    diagnostics.gutter_darkness_score = gutter_darkness;
    diagnostics.soft_gutter_score = soft_gutter_score;
    diagnostics.soft_gutter_coverage =
        soft_gutter.map_or(0.0, |candidate| candidate.vertical_coverage);
    diagnostics.gutter_score = gutter_score;
    diagnostics.agreement_score = agreement_score;
    diagnostics.independent_spread_cues = independent_spread_cues;
    diagnostics.evidence_product = diagnostics.evidence_product.max(confidence);

    // These are policy gates, not compensating weights. A very strong cue may
    // never make up for a missing independent cue.
    if whitespace.score < 0.20
        || bilateral.score < 0.08
        || outer_margins < 0.02
        || gutter_score < 0.25
        || fold_score < 0.25 && soft_gutter_score < 0.25 && gutter_darkness < 0.25
        || fold_score < 0.25 && gutter_darkness < 0.25 && diagnostics.aspect_spread_score < 0.15
        || fold.is_some()
            && !agrees
            && local_fold.is_none()
            && gutter_darkness.max(soft_gutter_score) < 0.25
    {
        diagnostics.abstained = true;
        return None;
    }

    let cutter = scale_x(decision_x, analysis.gray.width(), original.width());
    Some(split_at(
        original.width(),
        original.height(),
        cutter,
        LayoutClassification::TwoPageSpread,
        confidence,
        *diagnostics,
    ))
}

fn offcut_decision(
    original: &GrayImage,
    analysis: &AnalysisImage<'_>,
    whitespace: Option<Candidate>,
    diagnostics: &mut SplitDiagnostics,
) -> Option<SplitResult> {
    let edge_whitespace = whitespace.filter(|candidate| {
        let position = candidate.x / analysis.gray.width().max(1) as f64;
        !(0.28..=0.72).contains(&position)
    });
    let fold = edge_whitespace
        .and_then(|candidate| fold_candidate_near_whitespace(&analysis.gray, candidate))?;
    let position = fold.x / analysis.gray.width().max(1) as f64;
    let discarded_fraction = position.min(1.0 - position);
    if discarded_fraction >= MAX_OFFCUT_WIDTH_FRACTION || fold.vertical_coverage < 0.52 {
        return None;
    }

    let whitespace_score = edge_whitespace
        .filter(|candidate| {
            (candidate.x - fold.x).abs() <= analysis.gray.width() as f64 * MAX_EVIDENCE_DISAGREEMENT
        })
        .map_or(0.0, |candidate| candidate.score);
    let boundary_score = fold.score * (0.7 + 0.3 * whitespace_score);
    let empty_score = smaller_side_empty_score(&analysis.cleaned, fold.x, analysis.dpi);
    let width_score = ramp(
        MAX_OFFCUT_WIDTH_FRACTION - discarded_fraction,
        0.0,
        MAX_OFFCUT_WIDTH_FRACTION - 0.10,
    );
    let no_text_rows_score = 1.0 - aligned_text_rows_score(&analysis.binary, fold.x);
    let evidence_product = boundary_score * empty_score * width_score * no_text_rows_score;

    diagnostics.whitespace_score = diagnostics.whitespace_score.max(whitespace_score);
    diagnostics.whitespace_x = edge_whitespace.map_or(0.0, |candidate| candidate.x);
    diagnostics.fold_x = fold.x;
    diagnostics.decision_x = fold.x;
    diagnostics.offcut_boundary_score = boundary_score;
    diagnostics.offcut_empty_score = empty_score;
    diagnostics.offcut_width_score = width_score;
    diagnostics.offcut_no_text_rows_score = no_text_rows_score;
    diagnostics.evidence_product = diagnostics.evidence_product.max(evidence_product);

    if boundary_score < 0.45
        || empty_score < 0.95
        || width_score <= 0.0
        || no_text_rows_score < 0.90
    {
        diagnostics.abstained = true;
        return None;
    }

    let cutter = scale_x(fold.x, analysis.gray.width(), original.width());
    Some(split_at(
        original.width(),
        original.height(),
        cutter,
        LayoutClassification::PageWithOffcut,
        evidence_product,
        *diagnostics,
    ))
}

fn rotate_gray(source: &GrayImage, correction_degrees: f64) -> GrayImage {
    let cx = source.width() as f64 * 0.5;
    let cy = source.height() as f64 * 0.5;
    let inverse = Affine::translation(-cx, -cy)
        .then(Affine::rotation_radians(-correction_degrees.to_radians()))
        .then(Affine::translation(cx, cy));
    let mut output = GrayImage::new(source.width(), source.height(), 255);
    for y in 0..output.height() {
        for x in 0..output.width() {
            let mapped = inverse.apply(Point::new(x as f64 + 0.5, y as f64 + 0.5));
            if mapped.x >= 0.0
                && mapped.y >= 0.0
                && mapped.x < source.width() as f64
                && mapped.y < source.height() as f64
            {
                output.set(
                    x,
                    y,
                    source.get(
                        mapped
                            .x
                            .floor()
                            .min(source.width().saturating_sub(1) as f64)
                            as usize,
                        mapped
                            .y
                            .floor()
                            .min(source.height().saturating_sub(1) as f64)
                            as usize,
                    ),
                );
            }
        }
    }
    output
}

fn shadow_cleaned_binary(binary: &BinaryImage, dpi: f64) -> BinaryImage {
    let shadow_radius = ((dpi / 300.0) * 60.0).round().max(12.0) as usize;
    let seed = open(
        binary,
        shadow_radius,
        ((dpi / 300.0) * 4.0).round().max(1.0) as usize,
    );
    let cleaned = binary.subtract(&reconstruct_binary(&seed, binary));
    let map = ComponentMap::from_binary(&cleaned);
    let min_area = ((dpi / 300.0).powi(2) * 3.0).round().max(2.0) as usize;
    map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let is_page_boundary = height as f64 >= cleaned.height() as f64 * 0.35
            && width as f64 <= cleaned.width() as f64 * 0.025;
        component.area >= min_area && !is_page_boundary
    })
}

fn whitespace_candidate(cleaned: &BinaryImage, central: bool) -> Option<Candidate> {
    if cleaned.width() < 8 || cleaned.height() < 8 {
        return None;
    }
    let columns = column_counts(cleaned);
    let search_left = cleaned.width() / 20;
    let search_right = cleaned.width() - search_left;
    let quiet_limit = (cleaned.height() as f64 * 0.012).ceil() as usize;
    let mut best: Option<Candidate> = None;
    let mut start = None;
    for x in search_left..=search_right {
        let quiet = x < search_right && columns[x] <= quiet_limit;
        if quiet && start.is_none() {
            start = Some(x);
        }
        if !quiet {
            if let Some(run_start) = start.take() {
                let run_width = x - run_start;
                let midpoint = (run_start + x) as f64 * 0.5;
                let width_fraction = run_width as f64 / cleaned.width() as f64;
                let mean_ink =
                    columns[run_start..x].iter().sum::<usize>() as f64 / run_width.max(1) as f64;
                let quietness = 1.0 - (mean_ink / quiet_limit.max(1) as f64).clamp(0.0, 1.0);
                let width_score = ramp(width_fraction, 0.001, 0.025);
                let score = width_score * (0.65 + 0.35 * quietness);
                let position = midpoint / cleaned.width() as f64;
                let eligible = if central {
                    (0.20..=0.80).contains(&position)
                } else {
                    !(0.28..=0.72).contains(&position)
                };
                if !eligible {
                    continue;
                }
                let candidate = Candidate {
                    x: midpoint,
                    score,
                    start: run_start,
                    end: x,
                };
                let centrality = 1.0 - ((position - 0.5).abs() / 0.30).min(1.0);
                let ranking = if central {
                    candidate.score * (0.25 + 0.75 * centrality)
                } else {
                    candidate.score
                };
                let current_ranking = best.map_or(-1.0, |current| {
                    let current_position = current.x / cleaned.width() as f64;
                    let current_centrality = 1.0 - ((current_position - 0.5).abs() / 0.30).min(1.0);
                    if central {
                        current.score * (0.25 + 0.75 * current_centrality)
                    } else {
                        current.score
                    }
                });
                if ranking > current_ranking {
                    best = Some(candidate);
                }
            }
        }
    }
    best.filter(|candidate| candidate.score >= 0.15)
}

#[derive(Clone, Copy, Debug, Default)]
struct BilateralScore {
    score: f64,
    left: SideScore,
    right: SideScore,
}

fn bilateral_page_score(cleaned: &BinaryImage, gray: &GrayImage, cutter_x: f64) -> BilateralScore {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    let left = side_page_score(cleaned, gray, 0, cutter);
    let right = side_page_score(cleaned, gray, cutter, cleaned.width());
    let content_balance = if left.ink == 0 || right.ink == 0 {
        0.0
    } else {
        ramp(
            left.ink.min(right.ink) as f64 / left.ink.max(right.ink) as f64,
            0.004,
            0.30,
        )
    };
    // A physically blank leaf is still a complete page. It may substitute for
    // content balance only when the grayscale raster independently exposes a
    // page-surface edge; a flat born-digital blank half never receives this
    // escape hatch.
    let blank_leaf_balance = if left.surface_score > 0.0 || right.surface_score > 0.0 {
        left.page_score.min(right.page_score)
    } else {
        0.0
    };
    BilateralScore {
        score: left.page_score.min(right.page_score) * content_balance.max(blank_leaf_balance),
        left,
        right,
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SideScore {
    page_score: f64,
    content_score: f64,
    surface_score: f64,
    ink: usize,
}

fn side_page_score(binary: &BinaryImage, gray: &GrayImage, left: usize, right: usize) -> SideScore {
    let width = right.saturating_sub(left);
    if width < 2 || binary.height() < 2 {
        return SideScore::default();
    }
    let mut ink = 0usize;
    let mut min_x = right;
    let mut max_x = left;
    let mut min_y = binary.height();
    let mut max_y = 0usize;
    for y in 0..binary.height() {
        for x in left..right {
            if binary.get(x, y) {
                ink += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    let coverage = ink as f64 / (width * binary.height()) as f64;
    let half_aspect = width as f64 / binary.height() as f64;
    let shape_score = ramp(half_aspect, 0.46, 0.58) * ramp(1.35 - half_aspect, 0.0, 0.25);
    let content_score = if ink == 0 {
        0.0
    } else {
        let horizontal_span = (max_x - min_x + 1) as f64 / width as f64;
        let vertical_span = (max_y - min_y + 1) as f64 / binary.height() as f64;
        let ink_score = ramp(coverage, 0.00005, 0.006);
        let span_score = ramp(horizontal_span, 0.08, 0.45) * ramp(vertical_span, 0.06, 0.45);
        shape_score * ink_score * span_score
    };
    let surface_score = shape_score * page_surface_score(gray, left, right);
    SideScore {
        page_score: content_score.max(surface_score),
        content_score,
        surface_score,
        ink,
    }
}

fn page_surface_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    page_surface_edge_score(gray, left, right).max(page_surface_texture_score(gray, left, right))
}

fn page_surface_edge_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    let width = right.saturating_sub(left);
    if width < 8 || gray.height() < 16 {
        return 0.0;
    }
    let edge_band = (gray.height() as f64 * 0.10).ceil().max(4.0) as usize;
    let sample_step = (width / 320).max(1);
    let mut covered = 0usize;
    let mut samples = 0usize;
    for x in (left + 2..right.saturating_sub(2)).step_by(sample_step) {
        samples += 1;
        let top_end = edge_band.min(gray.height().saturating_sub(2));
        let bottom_start = gray.height().saturating_sub(edge_band).max(2);
        let internal_edge = (2..top_end)
            .chain(bottom_start..gray.height().saturating_sub(2))
            .any(|y| {
                let gradient = i16::from(gray.get(x, y + 2)) - i16::from(gray.get(x, y - 2));
                gradient.unsigned_abs() >= 28
            });
        let clipped_edge = [
            i16::from(gray.get(x, 0)) - i16::from(gray.get(x, top_end)),
            i16::from(gray.get(x, gray.height() - 1))
                - i16::from(gray.get(x, bottom_start.saturating_sub(1))),
        ]
        .into_iter()
        .any(|gradient| gradient.unsigned_abs() >= 28);
        let edge_present = internal_edge || clipped_edge;
        covered += usize::from(edge_present);
    }
    ramp(covered as f64 / samples.max(1) as f64, 0.12, 0.55)
}

fn page_surface_texture_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    const GRID: usize = 10;
    let width = right.saturating_sub(left);
    if width < GRID || gray.height() < GRID {
        return 0.0;
    }
    let inset_x = (width as f64 * 0.05).round() as usize;
    let inset_y = (gray.height() as f64 * 0.10).round() as usize;
    let inner_left = left + inset_x;
    let inner_right = right.saturating_sub(inset_x);
    let inner_top = inset_y;
    let inner_bottom = gray.height().saturating_sub(inset_y);
    let inner_width = inner_right.saturating_sub(inner_left);
    let inner_height = inner_bottom.saturating_sub(inner_top);
    if inner_width == 0 || inner_height == 0 {
        return 0.0;
    }

    let mut dark_samples = [0u8; GRID * GRID];
    for y in inner_top..inner_bottom {
        let cell_y = ((y - inner_top) * GRID / inner_height).min(GRID - 1);
        for x in inner_left..inner_right {
            if gray.get(x, y) >= 235 {
                continue;
            }
            let cell_x = ((x - inner_left) * GRID / inner_width).min(GRID - 1);
            let count = &mut dark_samples[cell_y * GRID + cell_x];
            *count = count.saturating_add(1).min(2);
        }
    }
    let occupied = dark_samples.iter().filter(|&&count| count >= 2).count();
    ramp(occupied as f64 / dark_samples.len() as f64, 0.05, 0.35)
}

fn outer_margin_score(cleaned: &BinaryImage, raw: &BinaryImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    edge_margin_score(cleaned, raw, 0, cutter, true).min(edge_margin_score(
        cleaned,
        raw,
        cutter,
        cleaned.width(),
        false,
    ))
}

fn edge_margin_score(
    binary: &BinaryImage,
    raw: &BinaryImage,
    left: usize,
    right: usize,
    outer_is_left: bool,
) -> f64 {
    let width = right.saturating_sub(left);
    if width < 4 {
        return 0.0;
    }
    let columns = column_counts_range(binary, left, right);
    let quiet_limit = (binary.height() as f64 * 0.01).ceil() as usize;
    let scan = (width as f64 * 0.12).ceil().max(3.0) as usize;
    let edge_columns = if outer_is_left {
        &columns[..scan.min(columns.len())]
    } else {
        &columns[columns.len().saturating_sub(scan)..]
    };
    let quiet_ratio = edge_columns
        .iter()
        .filter(|&&ink| ink <= quiet_limit)
        .count() as f64
        / edge_columns.len().max(1) as f64;
    let quiet_score = ramp(quiet_ratio, 0.25, 0.80);
    let edge_band = (width as f64 * 0.06).ceil().max(2.0) as usize;
    let raw_columns = column_counts_range(raw, left, right);
    let outer_raw_columns: Box<dyn Iterator<Item = &usize>> = if outer_is_left {
        Box::new(raw_columns.iter().take(edge_band))
    } else {
        Box::new(raw_columns.iter().rev().take(edge_band))
    };
    let border_score = outer_raw_columns
        .map(|&ink| ink as f64 / raw.height() as f64)
        .fold(0.0, f64::max);
    let tight_crop_border = if quiet_ratio < 0.25 { 0.35 } else { 0.0 };
    quiet_score
        .max(ramp(border_score, 0.35, 0.80))
        .max(tight_crop_border)
}

fn gutter_darkness_score(gray: &GrayImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(gray.width(), cutter_x);
    let narrow = (gray.width() as f64 * 0.006).round().max(1.0) as usize;
    let shoulder = (gray.width() as f64 * 0.025).round().max(3.0) as usize;
    let gutter = mean_luminance(
        gray,
        cutter.saturating_sub(narrow),
        (cutter + narrow + 1).min(gray.width()),
    );
    let left = mean_luminance(
        gray,
        cutter.saturating_sub(shoulder),
        cutter.saturating_sub(narrow),
    );
    let right = mean_luminance(
        gray,
        (cutter + narrow + 1).min(gray.width()),
        (cutter + shoulder).min(gray.width()),
    );
    ramp((left + right) * 0.5 - gutter, 4.0, 32.0)
}

fn darkest_gutter_position(gray: &GrayImage, whitespace: Candidate) -> (f64, f64) {
    (whitespace.start..whitespace.end)
        .map(|x| (x as f64, gutter_darkness_score(gray, x as f64)))
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .unwrap_or((whitespace.x, 0.0))
}

fn soft_gutter_candidate(gray: &GrayImage, whitespace: Candidate) -> Option<SoftGutterCandidate> {
    if gray.width() < 24 || gray.height() < 24 || whitespace.start >= whitespace.end {
        return None;
    }
    let core_radius = (gray.width() as f64 * 0.0035).round().max(1.0) as usize;
    let inner_radius = (gray.width() as f64 * 0.010).round().max(3.0) as usize;
    let shoulder_radius = (gray.width() as f64 * 0.030).round().max(7.0) as usize;
    let y_start = gray.height() / 20;
    let y_end = gray.height() - y_start;
    let y_step = ((y_end - y_start) / 160).max(1);
    let x_step = ((whitespace.end - whitespace.start) / 64).max(1);
    let sample_rows = (y_start..y_end)
        .step_by(y_step)
        .map(|y| {
            let mut prefix = Vec::with_capacity(gray.width() + 1);
            prefix.push(0_u32);
            for x in 0..gray.width() {
                prefix.push(prefix[x] + u32::from(gray.get(x, y)));
            }
            prefix
        })
        .collect::<Vec<_>>();
    let mut best: Option<SoftGutterCandidate> = None;

    for x in (whitespace.start..whitespace.end).step_by(x_step) {
        if x <= shoulder_radius || x + shoulder_radius >= gray.width() {
            continue;
        }
        let mut samples = 0usize;
        let mut depressed = 0usize;
        let mut longest_run = 0usize;
        let mut current_run = 0usize;
        let mut depression_sum = 0.0;
        for prefix in &sample_rows {
            samples += 1;
            let core = prefixed_mean_luminance(
                prefix,
                x.saturating_sub(core_radius),
                (x + core_radius + 1).min(gray.width()),
            );
            let left = prefixed_mean_luminance(
                prefix,
                x - shoulder_radius,
                x.saturating_sub(inner_radius),
            );
            let right = prefixed_mean_luminance(
                prefix,
                (x + inner_radius).min(gray.width()),
                (x + shoulder_radius).min(gray.width()),
            );
            let symmetric_dip = left.min(right) - core;
            let one_sided_ramp = (left.max(right) - core) * 0.72;
            let depression = symmetric_dip.max(one_sided_ramp);
            if core <= 249.0 && depression >= 2.5 {
                depressed += 1;
                current_run += 1;
                longest_run = longest_run.max(current_run);
                depression_sum += depression;
            } else {
                current_run = 0;
            }
        }
        let coverage = depressed as f64 / samples.max(1) as f64;
        let continuity = longest_run as f64 / samples.max(1) as f64;
        let mean_depression = depression_sum / depressed.max(1) as f64;
        let score = ramp(mean_depression, 3.0, 18.0)
            * ramp(coverage, 0.42, 0.78)
            * ramp(continuity, 0.28, 0.65);
        let candidate = SoftGutterCandidate {
            x: x as f64,
            score,
            vertical_coverage: coverage,
        };
        if best.is_none_or(|current| candidate.score > current.score) {
            best = Some(candidate);
        }
    }
    best.filter(|candidate| candidate.score >= 0.04)
}

fn prefixed_mean_luminance(prefix: &[u32], left: usize, right: usize) -> f64 {
    if left >= right || right >= prefix.len() {
        return 255.0;
    }
    f64::from(prefix[right] - prefix[left]) / (right - left) as f64
}

fn fold_line_candidate(gray: &GrayImage) -> Option<FoldCandidate> {
    fold_line_candidate_in_range(gray, gray.width() / 4, gray.width() * 3 / 4)
}

fn fold_line_candidate_in_range(
    gray: &GrayImage,
    search_left: usize,
    search_right: usize,
) -> Option<FoldCandidate> {
    if gray.width() < 8 || gray.height() < 8 {
        return None;
    }
    const ANGLE_STEPS: usize = 29;
    let slopes = (0..ANGLE_STEPS)
        .map(|index| (-7.0 + index as f64 * 0.5).to_radians().tan())
        .collect::<Vec<_>>();
    let mut accumulator = vec![0u64; ANGLE_STEPS * gray.width()];
    let center_y = gray.height() as f64 * 0.5;
    for y in 1..gray.height() - 1 {
        for x in 2..gray.width() - 2 {
            let horizontal = i16::from(gray.get(x + 2, y)) - i16::from(gray.get(x - 2, y));
            let vertical = i16::from(gray.get(x, y + 1)) - i16::from(gray.get(x, y - 1));
            let weight = horizontal.abs().saturating_sub(vertical.abs());
            if weight < 8 {
                continue;
            }
            for (angle_index, slope) in slopes.iter().enumerate() {
                let center_x = x as f64 - slope * (y as f64 - center_y);
                let bin = center_x.round() as isize;
                if bin >= 0 && bin < gray.width() as isize {
                    accumulator[angle_index * gray.width() + bin as usize] += weight as u64;
                }
            }
        }
    }
    let search_left = search_left.clamp(2, gray.width().saturating_sub(3));
    let search_right = search_right.clamp(search_left + 1, gray.width().saturating_sub(2));
    let mut best = (0usize, 0usize, 0u64);
    let mut total = 0u64;
    let mut candidates = 0usize;
    for angle_index in 0..ANGLE_STEPS {
        for x in search_left..search_right {
            let score = accumulator[angle_index * gray.width() + x];
            total += score;
            candidates += 1;
            if score > best.2 {
                best = (angle_index, x, score);
            }
        }
    }
    let average = total as f64 / candidates.max(1) as f64;
    let coherence = if average > 0.0 {
        best.2 as f64 / average
    } else {
        0.0
    };
    let line_strength = best.2 as f64 / (gray.height() as f64 * 48.0);
    let coverage = vertical_gradient_coverage(gray, best.1 as f64, slopes[best.0]);
    let score =
        ramp(coherence, 3.0, 14.0) * ramp(line_strength, 0.12, 0.75) * ramp(coverage, 0.04, 0.42);
    (score >= 0.04).then_some(FoldCandidate {
        x: best.1 as f64,
        score,
        vertical_coverage: coverage,
    })
}

fn fold_candidate_near_whitespace(
    gray: &GrayImage,
    whitespace: Candidate,
) -> Option<FoldCandidate> {
    let hough = fold_line_candidate_in_range(
        gray,
        whitespace.start.saturating_sub(4),
        (whitespace.end + 4).min(gray.width()),
    );
    let step = ((whitespace.end.saturating_sub(whitespace.start)) / 64).max(1);
    let vertical = (whitespace.start..whitespace.end)
        .step_by(step)
        .map(|x| x as f64)
        .filter_map(|x| vertical_boundary_candidate_at(gray, x))
        .max_by(|left, right| left.score.total_cmp(&right.score));
    match (hough, vertical) {
        (Some(hough), Some(vertical)) if vertical.score > hough.score => Some(vertical),
        (Some(hough), _) => Some(hough),
        (None, vertical) => vertical,
    }
}

fn vertical_boundary_candidate_at(gray: &GrayImage, x: f64) -> Option<FoldCandidate> {
    if gray.width() < 8 || gray.height() < 8 || x < 3.0 || x + 3.0 >= gray.width() as f64 {
        return None;
    }
    let coverage = vertical_gradient_coverage(gray, x, 0.0);
    let center = x.round() as isize;
    let mut strength = 0u64;
    for y in 1..gray.height() - 1 {
        let strongest = (-3..=3)
            .filter_map(|offset| {
                let sample = center + offset;
                if sample < 2 || sample + 2 >= gray.width() as isize {
                    return None;
                }
                let sample = sample as usize;
                let horizontal =
                    i16::from(gray.get(sample + 2, y)) - i16::from(gray.get(sample - 2, y));
                let vertical =
                    i16::from(gray.get(sample, y + 1)) - i16::from(gray.get(sample, y - 1));
                Some((horizontal.abs() - vertical.abs()).max(0) as u64)
            })
            .max()
            .unwrap_or(0);
        strength += strongest;
    }
    let mean_strength = strength as f64 / gray.height().saturating_sub(2).max(1) as f64;
    let score = ramp(coverage, 0.06, 0.40) * ramp(mean_strength, 5.0, 30.0);
    (score >= 0.04).then_some(FoldCandidate {
        x,
        score,
        vertical_coverage: coverage,
    })
}

fn vertical_gradient_coverage(gray: &GrayImage, center_x: f64, slope: f64) -> f64 {
    let center_y = gray.height() as f64 * 0.5;
    let mut covered = 0usize;
    for y in 1..gray.height() - 1 {
        let x = center_x + slope * (y as f64 - center_y);
        let x = x.round() as isize;
        let present = (-3..=3).any(|offset| {
            let sample = x + offset;
            if sample < 2 || sample + 2 >= gray.width() as isize {
                return false;
            }
            let sample = sample as usize;
            let horizontal =
                i16::from(gray.get(sample + 2, y)) - i16::from(gray.get(sample - 2, y));
            let vertical = i16::from(gray.get(sample, y + 1)) - i16::from(gray.get(sample, y - 1));
            horizontal.abs().saturating_sub(vertical.abs()) >= 8
        });
        covered += usize::from(present);
    }
    covered as f64 / gray.height().saturating_sub(2).max(1) as f64
}

fn smaller_side_empty_score(cleaned: &BinaryImage, cutter_x: f64, dpi: f64) -> f64 {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    let boundary_band = (cleaned.width() as f64 * 0.008).round().max(2.0) as usize;
    let (left, right) = if cutter <= cleaned.width() - cutter {
        (0, cutter.saturating_sub(boundary_band))
    } else {
        (
            (cutter + boundary_band).min(cleaned.width()),
            cleaned.width(),
        )
    };
    let mut ink = 0usize;
    for y in 0..cleaned.height() {
        for x in left..right {
            ink += usize::from(cleaned.get(x, y));
        }
    }
    let area = (right - left).saturating_mul(cleaned.height());
    let dpi_scaled_speck_budget = (24.0 * (dpi / 300.0).powi(2)).round().max(4.0) as usize;
    let coverage_budget = (area as f64 * 0.0002).round() as usize;
    let budget = dpi_scaled_speck_budget.max(coverage_budget).max(1);
    if ink > budget {
        0.0
    } else {
        1.0 - 0.04 * ink as f64 / budget as f64
    }
}

fn aligned_text_rows_score(binary: &BinaryImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(binary.width(), cutter_x);
    let discarded_is_left = cutter <= binary.width() - cutter;
    let boundary_band = (binary.width() as f64 * 0.008).round().max(2.0) as usize;
    let discarded_range = if discarded_is_left {
        0..cutter.saturating_sub(boundary_band)
    } else {
        (cutter + boundary_band).min(binary.width())..binary.width()
    };
    let retained_range = if discarded_is_left {
        (cutter + boundary_band).min(binary.width())..binary.width()
    } else {
        0..cutter.saturating_sub(boundary_band)
    };
    let mut ink_rows = 0usize;
    let mut aligned_rows = 0usize;
    for y in 0..binary.height() {
        let discarded_has_ink = discarded_range.clone().any(|x| binary.get(x, y));
        if discarded_has_ink {
            ink_rows += 1;
            if retained_range.clone().any(|x| binary.get(x, y)) {
                aligned_rows += 1;
            }
        }
    }
    if ink_rows == 0 {
        0.0
    } else {
        aligned_rows as f64 / ink_rows as f64
    }
}

fn column_counts(binary: &BinaryImage) -> Vec<usize> {
    column_counts_range(binary, 0, binary.width())
}

fn column_counts_range(binary: &BinaryImage, left: usize, right: usize) -> Vec<usize> {
    let mut columns = vec![0usize; right.saturating_sub(left)];
    for y in 0..binary.height() {
        for (offset, count) in columns.iter_mut().enumerate() {
            *count += usize::from(binary.get(left + offset, y));
        }
    }
    columns
}

fn mean_luminance(gray: &GrayImage, left: usize, right: usize) -> f64 {
    if left >= right || right > gray.width() {
        return 255.0;
    }
    let mut sum = 0u64;
    let mut count = 0usize;
    for y in 0..gray.height() {
        for x in left..right {
            sum += u64::from(gray.get(x, y));
            count += 1;
        }
    }
    sum as f64 / count.max(1) as f64
}

fn ramp(value: f64, low: f64, high: f64) -> f64 {
    if high <= low {
        return f64::from(value >= high);
    }
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}

fn single_confidence(diagnostics: &SplitDiagnostics) -> f64 {
    let spread_rejection = strongest_three_product([
        1.0 - diagnostics.whitespace_score,
        1.0 - diagnostics.bilateral_score,
        1.0 - diagnostics.outer_margin_score,
        1.0 - diagnostics.gutter_score,
        diagnostics.aspect_single_score,
    ]);
    let offcut_rejection = strongest_three_product([
        1.0 - diagnostics.offcut_boundary_score,
        1.0 - diagnostics.offcut_empty_score,
        1.0 - diagnostics.offcut_width_score,
        1.0 - diagnostics.offcut_no_text_rows_score,
    ]);
    spread_rejection * offcut_rejection
}

fn spread_confidence(
    whitespace: f64,
    bilateral: f64,
    outer_margins: f64,
    fold: f64,
    soft_gutter: f64,
    aspect: f64,
) -> (f64, usize) {
    let cues = [
        ramp(whitespace, 0.20, 0.80),
        ramp(bilateral, 0.08, 0.50),
        ramp(outer_margins, 0.02, 0.70),
        ramp(fold, 0.20, 0.75),
        ramp(soft_gutter, 0.20, 0.80),
        aspect,
    ];
    let independent = cues.iter().filter(|&&score| score > 0.0).count();
    let mean_strength = cues.iter().sum::<f64>() / cues.len() as f64;
    let confidence = match independent {
        6 => 0.90 + 0.10 * mean_strength,
        5 => 0.80 + 0.10 * mean_strength,
        4 => (0.55 + 0.20 * mean_strength).min(0.79),
        _ => 0.45 * mean_strength,
    };
    (confidence.clamp(0.0, 1.0), independent)
}

fn strongest_three_product<const N: usize>(mut scores: [f64; N]) -> f64 {
    scores.sort_by(f64::total_cmp);
    scores[N.saturating_sub(3)..].iter().product()
}

#[allow(clippy::too_many_arguments)]
pub fn reconcile_layout_decision(
    tier1_classification: LayoutClassification,
    tier1_confidence: f64,
    tier1_cutter_x: Option<f64>,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
    width: usize,
    height: usize,
    prior: DocumentPrior,
) -> LayoutDecision {
    let mut decision = LayoutDecision {
        classification: tier1_classification,
        confidence: tier1_confidence.clamp(0.0, 1.0),
        cutter_x: tier1_cutter_x,
        reconciliation: ReconciliationMetadata {
            tier1_verdict: tier1_classification,
            reconciled: false,
            cluster_agreement: 0.0,
        },
    };
    if prior.validate().is_err()
        || !dimension_matches(width, prior.cluster_dims.width)
        || !dimension_matches(height, prior.cluster_dims.height)
    {
        return decision;
    }

    let agreement = prior.agreement_strength.clamp(0.0, 1.0);
    if tier1_classification == prior.dominant_layout {
        decision.confidence = confidence_with_document_agreement(decision.confidence, agreement);
        decision.reconciliation.cluster_agreement = agreement;
        return decision;
    }

    let reconciled_cutter = match prior.dominant_layout {
        LayoutClassification::TwoPageSpread => {
            let median = prior
                .cutter_ratio_median
                .expect("validated spread prior has a cutter");
            candidate_cutter_ratio
                .filter(|ratio| {
                    whitespace_score >= 0.15
                        && (0.28..=0.72).contains(ratio)
                        && (*ratio - median).abs() <= 0.035
                })
                .map(|ratio| ratio * width as f64)
        }
        LayoutClassification::SingleUncutPage => None,
        LayoutClassification::PageWithOffcut => {
            decision.confidence *= 1.0 - agreement * 0.5;
            decision.reconciliation.cluster_agreement = -agreement;
            return decision;
        }
    };
    let can_reconcile = prior.dominant_layout == LayoutClassification::SingleUncutPage
        || reconciled_cutter.is_some();
    if can_reconcile {
        decision.classification = prior.dominant_layout;
        decision.cutter_x = reconciled_cutter;
        decision.confidence = confidence_with_document_agreement(decision.confidence, agreement);
        decision.reconciliation.reconciled = true;
        decision.reconciliation.cluster_agreement = agreement;
    } else {
        decision.confidence *= 1.0 - agreement * 0.5;
        decision.reconciliation.cluster_agreement = -agreement;
    }
    decision
}

fn confidence_with_document_agreement(page_confidence: f64, agreement: f64) -> f64 {
    1.0 - (1.0 - page_confidence.clamp(0.0, 1.0)) * (1.0 - agreement.clamp(0.0, 1.0))
}

fn dimension_matches(actual: usize, expected: f64) -> bool {
    (actual as f64 - expected).abs() / expected.max(1.0) <= 0.02
}

fn clamp_cutter(width: usize, cutter_x: f64) -> usize {
    cutter_x.round().clamp(1.0, width.saturating_sub(1) as f64) as usize
}

fn scale_x(x: f64, from_width: usize, to_width: usize) -> f64 {
    x / from_width.max(1) as f64 * to_width as f64
}

fn single(
    width: usize,
    height: usize,
    confidence: f64,
    diagnostics: SplitDiagnostics,
) -> SplitResult {
    let reconciliation = ReconciliationMetadata {
        tier1_verdict: LayoutClassification::SingleUncutPage,
        reconciled: false,
        cluster_agreement: 0.0,
    };
    SplitResult {
        classification: LayoutClassification::SingleUncutPage,
        confidence,
        cutter_x: None,
        pages: vec![page_polygon(0.0, width as f64, height)],
        diagnostics,
        reconciliation,
        reusable_binary: None,
    }
}

fn split_at(
    width: usize,
    height: usize,
    x: f64,
    classification: LayoutClassification,
    confidence: f64,
    diagnostics: SplitDiagnostics,
) -> SplitResult {
    let reconciliation = ReconciliationMetadata {
        tier1_verdict: classification,
        reconciled: false,
        cluster_agreement: 0.0,
    };
    SplitResult {
        classification,
        confidence,
        cutter_x: Some(x),
        pages: vec![
            page_polygon(0.0, x, height),
            page_polygon(x, width as f64, height),
        ],
        diagnostics,
        reconciliation,
        reusable_binary: None,
    }
}

fn page_polygon(left: f64, right: f64, height: usize) -> Polygon {
    Polygon {
        points: vec![
            Point::new(left, 0.0),
            Point::new(right, 0.0),
            Point::new(right, height as f64),
            Point::new(left, height as f64),
        ],
    }
}

fn mode_classification(mode: LayoutMode) -> LayoutClassification {
    match mode {
        LayoutMode::PageWithOffcut | LayoutMode::KeepLeft | LayoutMode::KeepRight => {
            LayoutClassification::PageWithOffcut
        }
        LayoutMode::TwoPage => LayoutClassification::TwoPageSpread,
        LayoutMode::Auto | LayoutMode::Single => LayoutClassification::SingleUncutPage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_text_lines(gray: &mut GrayImage, x1: usize, x2: usize) {
        for y in (28..gray.height().saturating_sub(28)).step_by(18) {
            for x in x1..x2 {
                gray.set(x, y, 20);
                gray.set(x, y + 1, 20);
            }
        }
    }

    fn add_vertical_fold(gray: &mut GrayImage, x: usize) {
        for y in 4..gray.height().saturating_sub(4) {
            gray.set(x, y, 95);
            if x + 1 < gray.width() {
                gray.set(x + 1, y, 175);
            }
        }
    }

    #[test]
    fn locates_known_two_page_gutter() {
        let mut gray = GrayImage::new(360, 240, 245);
        add_text_lines(&mut gray, 20, 160);
        add_text_lines(&mut gray, 202, 340);
        add_vertical_fold(&mut gray, 180);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!(
            (result.cutter_x.unwrap() - 181.0).abs() <= 5.0,
            "{result:?}"
        );
        assert!(result.confidence > 0.0);
        assert_eq!(result.confidence, result.diagnostics.evidence_product);
        if result.confidence == 1.0 {
            let agreeing = [
                result.diagnostics.whitespace_score,
                result.diagnostics.bilateral_score,
                result.diagnostics.outer_margin_score,
                result.diagnostics.gutter_score,
            ]
            .into_iter()
            .filter(|&score| score >= 0.95)
            .count();
            assert!(agreeing >= 3, "{result:?}");
        }
    }

    #[test]
    fn manual_cutter_in_auto_mode_remains_a_two_page_spread() {
        let gray = GrayImage::new(300, 180, 245);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, Some(151.0));
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert_eq!(result.cutter_x, Some(151.0));
        assert_eq!(result.pages.len(), 2);
    }

    #[test]
    fn manual_override_is_authoritative() {
        let gray = GrayImage::new(200, 100, 255);
        let result = detect_split(&gray, 300.0, LayoutMode::TwoPage, Some(84.0));
        assert_eq!(result.cutter_x, Some(84.0));
        assert_eq!(result.confidence, 1.0);
    }

    #[test]
    fn a_fold_without_two_page_bodies_abstains() {
        let mut gray = GrayImage::new(360, 240, 235);
        add_vertical_fold(&mut gray, 180);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::SingleUncutPage);
        assert!(result.diagnostics.abstained);
    }

    #[test]
    fn portrait_two_column_page_is_not_a_spread() {
        let mut gray = GrayImage::new(300, 460, 245);
        add_text_lines(&mut gray, 24, 136);
        add_text_lines(&mut gray, 164, 276);
        add_vertical_fold(&mut gray, 150);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::SingleUncutPage);
        assert!(result.diagnostics.bilateral_score < 0.32, "{result:?}");
    }

    #[test]
    fn whitespace_without_gutter_evidence_is_not_a_spread() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.abstained, "{result:?}");
        assert_eq!(result.diagnostics.soft_gutter_score, 0.0, "{result:?}");
        assert!(result.diagnostics.aspect_spread_score > 0.0, "{result:?}");
    }

    #[test]
    fn soft_shadow_gutter_counts_without_a_crisp_fold_line() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        for y in 8..gray.height().saturating_sub(8) {
            for x in 316usize..=344 {
                let distance = x.abs_diff(330) as f64;
                let darkness = ((1.0_f64 - distance / 15.0).max(0.0) * 25.0).round() as u8;
                gray.set(x, y, 245 - darkness);
            }
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:?}"
        );
        assert!(result.diagnostics.soft_gutter_score >= 0.25, "{result:?}");
        assert!(
            result.diagnostics.soft_gutter_coverage >= 0.75,
            "{result:?}"
        );
        assert!((result.cutter_x.unwrap() - 330.0).abs() <= 8.0);
    }

    #[test]
    fn disagreeing_fold_and_whitespace_abstain() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        add_vertical_fold(&mut gray, 240);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.abstained, "{result:?}");
        assert!(result.diagnostics.agreement_score < 1.0, "{result:?}");
    }

    #[test]
    fn split_analysis_deskews_before_collecting_cues() {
        let mut level = GrayImage::new(660, 420, 245);
        add_text_lines(&mut level, 35, 300);
        add_text_lines(&mut level, 360, 625);
        add_vertical_fold(&mut level, 330);
        let tilted = rotate_gray(&level, 3.0);
        let result = detect_split(&tilted, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:?}"
        );
        assert!(
            result.diagnostics.deskew_angle_degrees.abs() >= 2.0,
            "{result:?}"
        );
        assert!((result.cutter_x.unwrap() - 330.0).abs() <= 12.0);
    }

    #[test]
    fn aligned_rows_prevent_discarding_a_narrow_side() {
        let mut gray = GrayImage::new(660, 936, 245);
        add_text_lines(&mut gray, 45, 530);
        add_vertical_fold(&mut gray, 570);
        for y in (28..gray.height().saturating_sub(28)).step_by(18).take(10) {
            gray.set(610, y, 20);
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.offcut_empty_score >= 0.95, "{result:?}");
        assert!(
            result.diagnostics.offcut_no_text_rows_score < 0.90,
            "{result:?}"
        );
    }

    #[test]
    fn auto_layout_distinguishes_real_margin_spread_and_empty_offcut() {
        let mut margin = GrayImage::new(660, 936, 245);
        add_text_lines(&mut margin, 45, 530);
        add_text_lines(&mut margin, 600, 635);
        let margin = detect_split(&margin, 150.0, LayoutMode::Auto, None);
        assert_eq!(margin.classification, LayoutClassification::SingleUncutPage);

        let mut spread = GrayImage::new(660, 420, 245);
        add_text_lines(&mut spread, 35, 300);
        add_text_lines(&mut spread, 360, 625);
        add_vertical_fold(&mut spread, 330);
        let spread = detect_split(&spread, 150.0, LayoutMode::Auto, None);
        assert_eq!(spread.classification, LayoutClassification::TwoPageSpread);

        let mut offcut = GrayImage::new(660, 936, 245);
        add_text_lines(&mut offcut, 45, 530);
        add_vertical_fold(&mut offcut, 570);
        let offcut = detect_split(&offcut, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            offcut.classification,
            LayoutClassification::PageWithOffcut,
            "{offcut:?}"
        );
        assert!(offcut.confidence > 0.0 && offcut.confidence < 1.0);
        assert_eq!(offcut.confidence, offcut.diagnostics.evidence_product);
    }

    #[test]
    fn resolution_limited_offcut_abstains_without_changing_spread_results() {
        let diagnostics = SplitDiagnostics {
            evidence_product: 0.7,
            offcut_boundary_score: 1.0,
            offcut_empty_score: 1.0,
            offcut_width_score: 1.0,
            offcut_no_text_rows_score: 0.7,
            ..SplitDiagnostics::default()
        };
        let mut offcut = split_at(
            660,
            936,
            570.0,
            LayoutClassification::PageWithOffcut,
            0.7,
            diagnostics,
        );
        offcut.abstain_from_resolution_limited_offcut();
        assert_eq!(offcut.classification, LayoutClassification::SingleUncutPage);
        assert_eq!(offcut.cutter_x, None);
        assert_eq!(offcut.pages, vec![page_polygon(0.0, 660.0, 936)]);
        assert!(offcut.diagnostics.abstained);

        let mut spread = split_at(
            660,
            420,
            330.0,
            LayoutClassification::TwoPageSpread,
            0.8,
            SplitDiagnostics::default(),
        );
        let expected = spread.clone();
        spread.abstain_from_resolution_limited_offcut();
        assert_eq!(spread.classification, expected.classification);
        assert_eq!(spread.cutter_x, expected.cutter_x);
        assert_eq!(spread.pages, expected.pages);
    }

    #[test]
    fn document_agreement_boosts_matching_pages_and_promotes_only_matching_candidates() {
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.53),
            cluster_dims: ClusterDimensions {
                width: 1200.0,
                height: 870.0,
            },
            agreement_strength: 0.85,
        };
        let matching = reconcile_layout_decision(
            LayoutClassification::TwoPageSpread,
            0.62,
            Some(636.0),
            Some(0.53),
            0.7,
            1200,
            870,
            prior,
        );
        assert_eq!(matching.classification, LayoutClassification::TwoPageSpread);
        assert!(matching.confidence > 0.9, "{matching:?}");
        assert!(!matching.reconciliation.reconciled);
        assert_eq!(matching.reconciliation.cluster_agreement, 0.85);

        let promoted = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.05,
            None,
            Some(0.535),
            0.3,
            1200,
            870,
            prior,
        );
        assert_eq!(promoted.classification, LayoutClassification::TwoPageSpread);
        assert!(promoted.reconciliation.reconciled);
        assert_eq!(promoted.cutter_x, Some(642.0));
        assert!(promoted.confidence >= 0.85, "{promoted:?}");

        let rejected = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.2,
            None,
            Some(0.44),
            0.5,
            1200,
            870,
            prior,
        );
        assert_eq!(
            rejected.classification,
            LayoutClassification::SingleUncutPage
        );
        assert!(!rejected.reconciliation.reconciled);
        assert_eq!(rejected.reconciliation.cluster_agreement, -0.85);
        assert!(rejected.confidence < 0.2);
    }
}
