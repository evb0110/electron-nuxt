use super::*;

#[derive(Clone)]
pub(crate) struct TextMarkupQuad {
    pub(crate) bottom: f64,
    pub(crate) center_y: f64,
    pub(crate) index: usize,
    pub(crate) left: f64,
    pub(crate) right: f64,
    pub(crate) top: f64,
}

pub(crate) struct TextMarkupQuadLineGroup {
    pub(crate) average_height: f64,
    pub(crate) bottom: f64,
    pub(crate) center_y: f64,
    pub(crate) quads: Vec<TextMarkupQuad>,
    pub(crate) top: f64,
}

pub(crate) fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let mut total = 0.0;
    let mut count = 0.0;
    for value in values {
        total += value;
        count += 1.0;
    }
    if count == 0.0 {
        0.0
    } else {
        total / count
    }
}

pub(crate) fn to_text_markup_quads(values: &[f64]) -> Option<Vec<TextMarkupQuad>> {
    let mut quads = Vec::new();
    for (index, chunk) in values.chunks_exact(8).enumerate() {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        if xs.iter().chain(ys.iter()).any(|value| !value.is_finite()) {
            return None;
        }
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if right <= left || top <= bottom {
            return None;
        }
        quads.push(TextMarkupQuad {
            bottom,
            center_y: (top + bottom) / 2.0,
            index,
            left,
            right,
            top,
        });
    }
    Some(quads)
}

pub(crate) fn add_quad_to_line_group(group: &mut TextMarkupQuadLineGroup, quad: TextMarkupQuad) {
    group.quads.push(quad);
    group.bottom = group
        .quads
        .iter()
        .map(|item| item.bottom)
        .fold(f64::INFINITY, f64::min);
    group.top = group
        .quads
        .iter()
        .map(|item| item.top)
        .fold(f64::NEG_INFINITY, f64::max);
    group.center_y = mean(group.quads.iter().map(|item| item.center_y));
    group.average_height = mean(group.quads.iter().map(|item| item.top - item.bottom));
}

pub(crate) fn normalize_markup_quad_points(values: &[f64]) -> Option<Vec<f64>> {
    let mut quads = to_text_markup_quads(values)?;
    if quads.is_empty() {
        return None;
    }
    quads.sort_by(|left, right| {
        right
            .center_y
            .total_cmp(&left.center_y)
            .then_with(|| left.left.total_cmp(&right.left))
    });
    let mut groups: Vec<TextMarkupQuadLineGroup> = Vec::new();
    for quad in quads {
        let belongs_to_previous = groups.last().is_some_and(|group| {
            let tolerance = group.average_height.max(quad.top - quad.bottom)
                * SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
            (quad.center_y - group.center_y).abs() <= tolerance
        });
        if belongs_to_previous {
            let group = groups.last_mut().expect("line group exists");
            add_quad_to_line_group(group, quad);
        } else {
            groups.push(TextMarkupQuadLineGroup {
                average_height: quad.top - quad.bottom,
                bottom: quad.bottom,
                center_y: quad.center_y,
                quads: vec![quad.clone()],
                top: quad.top,
            });
        }
    }
    if groups.len() <= 1 {
        return Some(values.to_vec());
    }
    let mut normalized = values.to_vec();
    for group_index in 0..groups.len() {
        let mut line_top = groups[group_index].top;
        let mut line_bottom = groups[group_index].bottom;
        if let Some(previous_group) = group_index
            .checked_sub(1)
            .and_then(|index| groups.get(index))
        {
            line_top = line_top.min((previous_group.center_y + groups[group_index].center_y) / 2.0);
        }
        if let Some(next_group) = groups.get(group_index + 1) {
            line_bottom =
                line_bottom.max((groups[group_index].center_y + next_group.center_y) / 2.0);
        }
        if line_top - line_bottom < MIN_TEXT_MARKUP_QUAD_HEIGHT {
            line_top = groups[group_index].top;
            line_bottom = groups[group_index].bottom;
        }
        for quad in &groups[group_index].quads {
            let offset = quad.index * 8;
            normalized[offset] = quad.left;
            normalized[offset + 1] = line_top;
            normalized[offset + 2] = quad.right;
            normalized[offset + 3] = line_top;
            normalized[offset + 4] = quad.left;
            normalized[offset + 5] = line_bottom;
            normalized[offset + 6] = quad.right;
            normalized[offset + 7] = line_bottom;
        }
    }
    Some(normalized)
}

pub(crate) fn ensure_markup_quad_points(
    candidate: &MarkupAnnotationCandidate,
) -> Option<(Vec<f64>, bool)> {
    if let Some(values) = &candidate.quad_points {
        let normalized = normalize_markup_quad_points(values)?;
        let changed = normalized
            .iter()
            .zip(values.iter())
            .any(|(left, right)| (left - right).abs() > f64::EPSILON);
        return Some((normalized, changed));
    }
    let rect = candidate.rect?;
    Some((rect_to_fallback_quad_points(rect), true))
}

pub(crate) fn number_to_content(value: f64) -> String {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001 {
        return format!("{rounded:.0}");
    }
    let formatted = format!("{value:.4}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

pub(crate) fn build_squiggly_appearance_stream(
    values: &[f64],
    rect: PdfRect,
    color: RgbColor,
) -> Option<Stream> {
    // Quartz/Preview does not synthesize Squiggly appearances from QuadPoints,
    // so native rewrites must append a small Form XObject for visibility.
    let mut content = String::new();
    content.push_str("q\n");
    content.push_str(&format!(
        "{} {} {} RG\n",
        number_to_content(f64::from(color.r) / 255.0),
        number_to_content(f64::from(color.g) / 255.0),
        number_to_content(f64::from(color.b) / 255.0)
    ));
    content.push_str(&format!(
        "{} w\n1 J\n",
        number_to_content(SQUIGGLY_APPEARANCE_STROKE_WIDTH)
    ));
    let mut has_path = false;
    for chunk in values.chunks_exact(8) {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let height = top - bottom;
        if right - left <= 0.0 || height <= 0.0 {
            continue;
        }
        let amplitude = SQUIGGLY_APPEARANCE_MAX_AMPLITUDE.min(
            SQUIGGLY_APPEARANCE_MIN_AMPLITUDE.max(height * SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO),
        );
        let center = bottom + amplitude;
        let half_step = 1.5_f64.max(amplitude * 1.5);
        content.push_str(&format!(
            "{} {} m\n",
            number_to_content(left),
            number_to_content(center - amplitude)
        ));
        let mut x = left;
        let mut up = true;
        while x < right {
            x = right.min(x + half_step);
            content.push_str(&format!(
                "{} {} l\n",
                number_to_content(x),
                number_to_content(if up {
                    center + amplitude
                } else {
                    center - amplitude
                })
            ));
            up = !up;
        }
        has_path = true;
    }
    if !has_path {
        return None;
    }
    content.push_str("S\nQ\n");
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set("BBox", rect_object(rect));
    dict.set(
        "Matrix",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
        ]),
    );
    Some(Stream::new(dict, content.into_bytes()))
}

pub(crate) fn quad_points_object(values: &[f64]) -> Object {
    Object::Array(values.iter().map(|value| number_object(*value)).collect())
}

pub(crate) fn apply_markup_rewrite_to_object(
    document: &mut Document,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<bool> {
    let target_color = resolve_hint_target_color(target_subtype, color);
    let mut modified = false;
    let mut ensured_quad_points: Option<(Vec<f64>, bool)> = None;
    let mut squiggly_ap_ref: Option<ObjectId> = None;

    if target_subtype != "Highlight" {
        ensured_quad_points = ensure_markup_quad_points(candidate);
        let subtype_already_applied = candidate.subtype == target_subtype;
        if !subtype_already_applied {
            modified = true;
        }
        if ensured_quad_points
            .as_ref()
            .is_some_and(|(_, changed)| *changed)
        {
            modified = true;
        }
        if target_subtype == "Squiggly" {
            if let (Some((values, _)), Some(rect), Some(color)) = (
                &ensured_quad_points,
                candidate.rect,
                target_color.or(candidate.color),
            ) {
                if let Some(stream) = build_squiggly_appearance_stream(values, rect, color) {
                    squiggly_ap_ref = Some(document.add_object(stream));
                    modified = true;
                }
            }
        }
    }
    if target_color.is_some() {
        modified = true;
    }
    if !modified {
        return Ok(false);
    }

    let dict = document.get_dictionary_mut(candidate.object_id)?;
    if let Some(color) = target_color {
        write_markup_color(dict, color);
        if target_subtype == "Highlight" {
            dict.set("CA", Object::Integer(1));
        }
        dict.remove(b"AP");
    }
    if target_subtype != "Highlight" {
        if let Some((values, _)) = ensured_quad_points {
            dict.set("QuadPoints", quad_points_object(&values));
        }
        if candidate.subtype != target_subtype {
            let pdf_name =
                markup_subtype_pdf_name(target_subtype).ok_or("Invalid text-markup subtype")?;
            dict.set("Subtype", Object::Name(pdf_name.as_bytes().to_vec()));
            dict.remove(b"AP");
        }
        if let Some(ap_ref) = squiggly_ap_ref {
            let mut ap = Dictionary::new();
            ap.set("N", Object::Reference(ap_ref));
            dict.set("AP", Object::Dictionary(ap));
        }
    }
    Ok(true)
}

pub(crate) fn create_markup_candidate(
    document: &Document,
    page_view: PdfRect,
    page_rotation: i64,
    object_id: ObjectId,
    page_markup_index: u32,
) -> Option<MarkupAnnotationCandidate> {
    let dict = document.get_dictionary(object_id).ok()?;
    let subtype = canonical_markup_subtype(dict)?;
    let rect = read_pdf_rect_from_dict(document, dict);
    Some(MarkupAnnotationCandidate {
        color: read_markup_color(document, dict),
        marker_rect: rect
            .and_then(|rect| marker_rect_from_pdf_rect(rect, page_view, page_rotation)),
        object_id,
        page_markup_index,
        quad_points: read_markup_quad_points(document, dict),
        rect,
        ref_tag: format_pdfjs_annotation_ref(object_id),
        subtype,
    })
}

pub(crate) type MarkupInputs = (HashMap<String, String>, HashMap<u32, Vec<MarkupHintState>>);

pub(crate) fn build_markup_inputs(markup: &MarkupMutation) -> Result<MarkupInputs> {
    let overrides = markup
        .overrides
        .iter()
        .map(|(annotation_id, subtype)| (annotation_id.clone(), subtype.clone()))
        .collect();
    let mut hints_by_page: HashMap<u32, Vec<MarkupHintState>> = HashMap::new();
    for hint_state in dedupe_markup_subtype_hints(&markup.hints)? {
        hints_by_page
            .entry(hint_state.hint.page_index)
            .or_default()
            .push(hint_state);
    }
    Ok((overrides, hints_by_page))
}

pub(crate) fn rewrite_page_markup_subtypes(
    document: &mut Document,
    candidates: &[MarkupAnnotationCandidate],
    overrides: &HashMap<String, String>,
    page_hints: &mut [MarkupHintState],
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();
    let hints_by_ref = index_markup_hints_by_ref(page_hints);

    for candidate in candidates {
        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten =
                apply_markup_rewrite_to_object(document, candidate, override_subtype, None)?
                    || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)?
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_object(
            document,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
        )? || rewritten;
    }
    Ok(rewritten)
}

pub(crate) fn apply_markup_rewrite_to_incremental_object(
    incremental: &mut IncrementalDocument,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
) -> Result<bool> {
    incremental.opt_clone_object_to_new_document(candidate.object_id)?;
    apply_markup_rewrite_to_object(
        &mut incremental.new_document,
        candidate,
        target_subtype,
        color,
    )
}

pub(crate) fn rewrite_page_markup_subtypes_incremental(
    incremental: &mut IncrementalDocument,
    candidates: &[MarkupAnnotationCandidate],
    overrides: &HashMap<String, String>,
    page_hints: &mut [MarkupHintState],
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();
    let hints_by_ref = index_markup_hints_by_ref(page_hints);

    for candidate in candidates {
        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                override_subtype,
                None,
            )? || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)?
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_incremental_object(
            incremental,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
        )? || rewritten;
    }
    Ok(rewritten)
}

pub(crate) fn apply_markup_mutations(
    document: &mut Document,
    markup: &MarkupMutation,
) -> Result<()> {
    let (overrides, mut hints_by_page) = build_markup_inputs(markup)?;
    let page_map = document.get_pages();
    let mut modified = false;

    for (page_index, page_id) in page_map.values().copied().enumerate() {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let annots = get_page_annots(document, page_id)?;
        let mut candidates = Vec::new();
        let mut page_markup_index = 0_u32;
        for object_id in annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            if let Some(candidate) = create_markup_candidate(
                document,
                page_view,
                page_rotation,
                object_id,
                page_markup_index,
            ) {
                candidates.push(candidate);
                page_markup_index += 1;
            }
        }
        let page_hints = hints_by_page.entry(page_index as u32).or_default();
        modified = rewrite_page_markup_subtypes(document, &candidates, &overrides, page_hints)?
            || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}

pub(crate) fn apply_markup_mutations_incremental(
    incremental: &mut IncrementalDocument,
    markup: &MarkupMutation,
) -> Result<()> {
    let (overrides, mut hints_by_page) = build_markup_inputs(markup)?;
    let page_map = incremental.get_prev_documents().get_pages();
    let mut modified = false;

    for (page_index, page_id) in page_map.values().copied().enumerate() {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let annots = get_page_annots(incremental.get_prev_documents(), page_id)?;
        let mut candidates = Vec::new();
        let mut page_markup_index = 0_u32;
        for object_id in annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            if let Some(candidate) = create_markup_candidate(
                incremental.get_prev_documents(),
                page_view,
                page_rotation,
                object_id,
                page_markup_index,
            ) {
                candidates.push(candidate);
                page_markup_index += 1;
            }
        }
        let page_hints = hints_by_page.entry(page_index as u32).or_default();
        modified = rewrite_page_markup_subtypes_incremental(
            incremental,
            &candidates,
            &overrides,
            page_hints,
        )? || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}
