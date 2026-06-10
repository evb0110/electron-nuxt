#[derive(Clone, Copy, Debug, PartialEq)]
struct RgbColor {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Clone)]
struct MarkupHintState {
    hint: MarkupSubtypeHint,
    consumed: bool,
}

#[derive(Clone)]
struct MarkupAnnotationCandidate {
    color: Option<RgbColor>,
    marker_rect: Option<MarkerRect>,
    object_id: ObjectId,
    page_markup_index: u32,
    quad_points: Option<Vec<f64>>,
    rect: Option<PdfRect>,
    ref_tag: String,
    subtype: String,
}

const MIN_MARKUP_SUBTYPE_HINT_IOU: f64 = 0.45;
const DUPLICATE_MARKUP_SUBTYPE_HINT_IOU: f64 = 0.92;
const EXPLICIT_REF_MATCH_SCORE: f64 = 100.0;
const GEOMETRY_MATCH_WEIGHT: f64 = 10.0;
const COLOR_MATCH_WEIGHT: f64 = 1.5;
const PAGE_MARKUP_INDEX_MATCH_BONUS: f64 = 0.25;
const PAGE_MARKUP_INDEX_MISMATCH_PENALTY: f64 = 0.08;
const MAX_RGB_DISTANCE: f64 = 441.6729559300637;
const HIGHLIGHT_DISPLAY_OPACITY: f64 = 0.35;
const SQUIGGLY_APPEARANCE_STROKE_WIDTH: f64 = 1.0;
const SQUIGGLY_APPEARANCE_MAX_AMPLITUDE: f64 = 2.0;
const SQUIGGLY_APPEARANCE_MIN_AMPLITUDE: f64 = 0.6;
const SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO: f64 = 0.07;
const MIN_POINT_MARKER_SIZE: f64 = 0.0016;
const SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO: f64 = 0.35;
const MIN_TEXT_MARKUP_QUAD_HEIGHT: f64 = 0.01;

fn markup_subtype_pdf_name(subtype: &str) -> Option<&'static str> {
    match subtype {
        "Highlight" => Some("Highlight"),
        "Underline" => Some("Underline"),
        "StrikeOut" => Some("StrikeOut"),
        "Squiggly" => Some("Squiggly"),
        _ => None,
    }
}

fn canonical_markup_subtype(dict: &Dictionary) -> Option<String> {
    match annotation_subtype(dict).as_str() {
        "highlight" => Some("Highlight".to_string()),
        "underline" => Some("Underline".to_string()),
        "strikeout" => Some("StrikeOut".to_string()),
        "squiggly" => Some("Squiggly".to_string()),
        _ => None,
    }
}

fn resolve_object<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document
        .dereference(object)
        .ok()
        .map(|(_, resolved)| resolved)
}

fn object_to_markup_color_channel(value: f64, all_channels_are_unit_range: bool) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    let scaled = if all_channels_are_unit_range {
        value * 255.0
    } else {
        value
    };
    Some(scaled.round().clamp(0.0, 255.0) as u8)
}

fn read_markup_color(document: &Document, dict: &Dictionary) -> Option<RgbColor> {
    let object = dict.get(b"C").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.len() < 3 {
        return None;
    }
    let channels = [
        object_to_f64(&values[0]).ok()?,
        object_to_f64(&values[1]).ok()?,
        object_to_f64(&values[2]).ok()?,
    ];
    let all_channels_are_unit_range = channels.iter().all(|channel| (0.0..=1.0).contains(channel));
    Some(RgbColor {
        r: object_to_markup_color_channel(channels[0], all_channels_are_unit_range)?,
        g: object_to_markup_color_channel(channels[1], all_channels_are_unit_range)?,
        b: object_to_markup_color_channel(channels[2], all_channels_are_unit_range)?,
    })
}

fn read_pdf_rect_from_dict(document: &Document, dict: &Dictionary) -> Option<PdfRect> {
    let object = dict.get(b"Rect").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.len() < 4 {
        return None;
    }
    let x1 = object_to_f64(&values[0]).ok()?;
    let y1 = object_to_f64(&values[1]).ok()?;
    let x2 = object_to_f64(&values[2]).ok()?;
    let y2 = object_to_f64(&values[3]).ok()?;
    let rect = PdfRect {
        x1: x1.min(x2),
        y1: y1.min(y2),
        x2: x1.max(x2),
        y2: y1.max(y2),
    };
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return None;
    }
    Some(rect)
}

fn read_markup_quad_points(document: &Document, dict: &Dictionary) -> Option<Vec<f64>> {
    let object = dict.get(b"QuadPoints").ok()?;
    let resolved = resolve_object(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.is_empty() || values.len() % 8 != 0 {
        return None;
    }
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let parsed = object_to_f64(value).ok()?;
        if !parsed.is_finite() {
            return None;
        }
        result.push(parsed);
    }
    Some(result)
}

fn marker_point_from_pdf_point(
    x: f64,
    y: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    let norm_x = (x - page_view.x1) / page_view.width();
    let norm_y = (y - page_view.y1) / page_view.height();
    match page_rotation {
        90 => (norm_y, norm_x),
        180 => (1.0 - norm_x, norm_y),
        270 => (1.0 - norm_y, 1.0 - norm_x),
        _ => (norm_x, 1.0 - norm_y),
    }
}

fn normalize_marker_rect_bounds(
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Option<MarkerRect> {
    let width = right - left;
    let height = bottom - top;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let clamped_left = left.clamp(0.0, 1.0);
    let clamped_top = top.clamp(0.0, 1.0);
    let clamped_width = width.clamp(0.0, 1.0 - clamped_left);
    let clamped_height = height.clamp(0.0, 1.0 - clamped_top);
    if clamped_width <= 0.0 || clamped_height <= 0.0 {
        return None;
    }
    Some(MarkerRect {
        left: clamped_left,
        top: clamped_top,
        width: clamped_width,
        height: clamped_height,
    })
}

fn marker_rect_from_pdf_rect(
    rect: PdfRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Option<MarkerRect> {
    let corners = [
        marker_point_from_pdf_point(rect.x1, rect.y1, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x1, rect.y2, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x2, rect.y1, page_view, page_rotation),
        marker_point_from_pdf_point(rect.x2, rect.y2, page_view, page_rotation),
    ];
    let mut left = corners
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min);
    let mut top = corners
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let mut right = corners
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut bottom = corners
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    if right - left < MIN_POINT_MARKER_SIZE {
        let center = left + (right - left) / 2.0;
        left = center - MIN_POINT_MARKER_SIZE / 2.0;
        right = left + MIN_POINT_MARKER_SIZE;
    }
    if bottom - top < MIN_POINT_MARKER_SIZE {
        let center = top + (bottom - top) / 2.0;
        top = center - MIN_POINT_MARKER_SIZE / 2.0;
        bottom = top + MIN_POINT_MARKER_SIZE;
    }
    normalize_marker_rect_bounds(left, top, right, bottom)
}

fn marker_rect_iou(left: Option<MarkerRect>, right: Option<MarkerRect>) -> f64 {
    let (Some(left), Some(right)) = (left, right) else {
        return 0.0;
    };
    let intersection_left = left.left.max(right.left);
    let intersection_top = left.top.max(right.top);
    let intersection_right = (left.left + left.width).min(right.left + right.width);
    let intersection_bottom = (left.top + left.height).min(right.top + right.height);
    let intersection_width = (intersection_right - intersection_left).max(0.0);
    let intersection_height = (intersection_bottom - intersection_top).max(0.0);
    let intersection_area = intersection_width * intersection_height;
    if intersection_area <= 0.0 {
        return 0.0;
    }
    let union_area = (left.width * left.height) + (right.width * right.height) - intersection_area;
    if union_area <= 0.0 {
        return 0.0;
    }
    intersection_area / union_area
}

fn parse_rgb_channel_token(token: &str) -> Option<u8> {
    let trimmed = token.trim();
    if let Some(percent) = trimmed.strip_suffix('%') {
        let parsed = percent.trim().parse::<f64>().ok()?;
        if !parsed.is_finite() {
            return None;
        }
        return Some(((parsed / 100.0) * 255.0).round().clamp(0.0, 255.0) as u8);
    }
    let parsed = trimmed.parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.round().clamp(0.0, 255.0) as u8)
}

fn parse_css_rgb_color(value: Option<&str>) -> Option<RgbColor> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix('#') {
        if hex.len() == 3 {
            let mut expanded = String::with_capacity(6);
            for character in hex.chars() {
                expanded.push(character);
                expanded.push(character);
            }
            return parse_css_rgb_color(Some(&format!("#{expanded}")));
        }
        if hex.len() == 6 {
            return Some(RgbColor {
                r: u8::from_str_radix(&hex[0..2], 16).ok()?,
                g: u8::from_str_radix(&hex[2..4], 16).ok()?,
                b: u8::from_str_radix(&hex[4..6], 16).ok()?,
            });
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    let args = lower
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| {
            lower
                .strip_prefix("rgba(")
                .and_then(|value| value.strip_suffix(')'))
        })?;
    let channels: Vec<&str> = if args.contains(',') {
        args.split(',').collect()
    } else {
        args.split_whitespace().collect()
    };
    if channels.len() < 3 {
        return None;
    }
    Some(RgbColor {
        r: parse_rgb_channel_token(channels[0])?,
        g: parse_rgb_channel_token(channels[1])?,
        b: parse_rgb_channel_token(channels[2])?,
    })
}

fn resolve_hint_target_color(target_subtype: &str, color: Option<&str>) -> Option<RgbColor> {
    let parsed = parse_css_rgb_color(color)?;
    if target_subtype != "Highlight" {
        return Some(parsed);
    }
    let blend = |channel: u8| -> u8 {
        ((f64::from(channel) * HIGHLIGHT_DISPLAY_OPACITY)
            + (255.0 * (1.0 - HIGHLIGHT_DISPLAY_OPACITY)))
            .round()
            .clamp(0.0, 255.0) as u8
    };
    Some(RgbColor {
        r: blend(parsed.r),
        g: blend(parsed.g),
        b: blend(parsed.b),
    })
}

fn write_markup_color(dict: &mut Dictionary, color: RgbColor) {
    dict.set(
        "C",
        Object::Array(vec![
            number_object(f64::from(color.r) / 255.0),
            number_object(f64::from(color.g) / 255.0),
            number_object(f64::from(color.b) / 255.0),
        ]),
    );
}

fn color_similarity(left: Option<RgbColor>, right: Option<RgbColor>) -> Option<f64> {
    let (Some(left), Some(right)) = (left, right) else {
        return None;
    };
    let distance = ((f64::from(left.r) - f64::from(right.r)).powi(2)
        + (f64::from(left.g) - f64::from(right.g)).powi(2)
        + (f64::from(left.b) - f64::from(right.b)).powi(2))
    .sqrt();
    Some((1.0 - (distance / MAX_RGB_DISTANCE)).max(0.0))
}

fn hint_colors_conflict(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    match color_similarity(
        parse_css_rgb_color(left.color.as_deref()),
        parse_css_rgb_color(right.color.as_deref()),
    ) {
        Some(similarity) => similarity < 0.98,
        None => false,
    }
}

fn normalize_hint_annotation_ref(hint: &MarkupSubtypeHint) -> Option<String> {
    hint.annotation_id
        .as_deref()
        .and_then(normalize_pdfjs_annotation_id)
}

fn subtype_hints_share_identity(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    if left.subtype != right.subtype {
        return false;
    }
    (left
        .id
        .as_deref()
        .zip(right.id.as_deref())
        .is_some_and(|(left_id, right_id)| left_id == right_id))
        || normalize_hint_annotation_ref(left)
            .zip(normalize_hint_annotation_ref(right))
            .is_some_and(|(left_ref, right_ref)| left_ref == right_ref)
}

fn subtype_hints_share_geometry(left: &MarkupSubtypeHint, right: &MarkupSubtypeHint) -> bool {
    left.page_index == right.page_index
        && left.subtype == right.subtype
        && !hint_colors_conflict(left, right)
        && marker_rect_iou(Some(left.marker_rect), Some(right.marker_rect))
            >= DUPLICATE_MARKUP_SUBTYPE_HINT_IOU
}

fn merge_subtype_hints(
    existing: &MarkupSubtypeHint,
    incoming: &MarkupSubtypeHint,
) -> MarkupSubtypeHint {
    MarkupSubtypeHint {
        subtype: existing.subtype.clone(),
        page_index: existing.page_index,
        marker_rect: existing.marker_rect,
        annotation_id: existing
            .annotation_id
            .clone()
            .or_else(|| incoming.annotation_id.clone()),
        color: existing.color.clone().or_else(|| incoming.color.clone()),
        id: existing.id.clone().or_else(|| incoming.id.clone()),
        page_markup_index: existing.page_markup_index.or(incoming.page_markup_index),
        source: existing.source.clone().or_else(|| incoming.source.clone()),
    }
}

fn dedupe_markup_subtype_hints(hints: &[MarkupSubtypeHint]) -> Vec<MarkupHintState> {
    let mut deduped: Vec<MarkupSubtypeHint> = Vec::new();
    for hint in hints {
        let existing_index = deduped.iter().position(|existing| {
            subtype_hints_share_identity(existing, hint)
                || subtype_hints_share_geometry(existing, hint)
        });
        if let Some(index) = existing_index {
            deduped[index] = merge_subtype_hints(&deduped[index], hint);
        } else {
            deduped.push(hint.clone());
        }
    }
    deduped
        .into_iter()
        .map(|hint| MarkupHintState {
            hint,
            consumed: false,
        })
        .collect()
}

fn can_use_geometry_only_subtype_hint(hint: &MarkupSubtypeHint) -> bool {
    hint.subtype == "Highlight"
        || match hint.source.as_deref() {
            Some(source) => source == "editor-live",
            None => true,
        }
}

fn score_subtype_hint_for_candidate(
    hint_state: &MarkupHintState,
    candidate: &MarkupAnnotationCandidate,
) -> Option<f64> {
    if hint_state.consumed {
        return None;
    }
    let hint = &hint_state.hint;
    let hint_ref = normalize_hint_annotation_ref(hint);
    let ref_matched = hint_ref.as_deref() == Some(candidate.ref_tag.as_str());
    let geometry_score = marker_rect_iou(candidate.marker_rect, Some(hint.marker_rect));
    if !ref_matched
        && (hint_ref.is_some()
            || !can_use_geometry_only_subtype_hint(hint)
            || geometry_score < MIN_MARKUP_SUBTYPE_HINT_IOU)
    {
        return None;
    }
    let index_score = match hint.page_markup_index {
        Some(page_markup_index) if page_markup_index == candidate.page_markup_index => {
            PAGE_MARKUP_INDEX_MATCH_BONUS
        }
        Some(page_markup_index) => {
            let delta = page_markup_index
                .abs_diff(candidate.page_markup_index)
                .min(3);
            -(f64::from(delta) * PAGE_MARKUP_INDEX_MISMATCH_PENALTY)
        }
        None => 0.0,
    };
    let color_score = color_similarity(parse_css_rgb_color(hint.color.as_deref()), candidate.color)
        .unwrap_or(0.0);
    Some(
        (if ref_matched {
            EXPLICIT_REF_MATCH_SCORE
        } else {
            0.0
        }) + (geometry_score * GEOMETRY_MATCH_WEIGHT)
            + (color_score * COLOR_MATCH_WEIGHT)
            + index_score,
    )
}

fn find_exact_ref_highlight_preservation_hint(
    page_hints: &[MarkupHintState],
    candidate: &MarkupAnnotationCandidate,
) -> Option<usize> {
    page_hints.iter().position(|hint_state| {
        !hint_state.consumed
            && hint_state.hint.subtype == "Highlight"
            && normalize_hint_annotation_ref(&hint_state.hint).as_deref()
                == Some(candidate.ref_tag.as_str())
    })
}

fn find_best_exact_ref_hint_for_candidate(
    page_hints: &[MarkupHintState],
    candidate: &MarkupAnnotationCandidate,
) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (index, hint_state) in page_hints.iter().enumerate() {
        if normalize_hint_annotation_ref(&hint_state.hint).as_deref()
            != Some(candidate.ref_tag.as_str())
        {
            continue;
        }
        let Some(score) = score_subtype_hint_for_candidate(hint_state, candidate) else {
            continue;
        };
        if best.map_or(true, |(_, best_score)| score > best_score) {
            best = Some((index, score));
        }
    }
    best.map(|(index, _)| index)
}

fn consume_exact_ref_hints(
    page_hints: &mut [MarkupHintState],
    candidate: &MarkupAnnotationCandidate,
) {
    for hint_state in page_hints {
        if normalize_hint_annotation_ref(&hint_state.hint).as_deref()
            == Some(candidate.ref_tag.as_str())
        {
            hint_state.consumed = true;
        }
    }
}

fn assign_subtype_hints_to_candidates(
    page_hints: &[MarkupHintState],
    candidates: &[MarkupAnnotationCandidate],
) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        for (hint_index, hint_state) in page_hints.iter().enumerate() {
            if let Some(score) = score_subtype_hint_for_candidate(hint_state, candidate) {
                matches.push((candidate_index, hint_index, score));
            }
        }
    }
    matches.sort_by(|left, right| right.2.total_cmp(&left.2));
    let mut assigned_candidates = HashSet::new();
    let mut assigned_hints = HashSet::new();
    let mut assignments = Vec::new();
    for (candidate_index, hint_index, _score) in matches {
        if assigned_candidates.contains(&candidate_index) || assigned_hints.contains(&hint_index) {
            continue;
        }
        assigned_candidates.insert(candidate_index);
        assigned_hints.insert(hint_index);
        assignments.push((candidate_index, hint_index));
    }
    assignments
}

fn rect_to_fallback_quad_points(rect: PdfRect) -> Vec<f64> {
    vec![
        rect.x1, rect.y2, rect.x2, rect.y2, rect.x1, rect.y1, rect.x2, rect.y1,
    ]
}
