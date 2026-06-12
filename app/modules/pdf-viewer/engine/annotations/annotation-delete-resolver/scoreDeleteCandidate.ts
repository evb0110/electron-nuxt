import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';

const DELETE_FALLBACK_MIN_IOU = 0.01;

const DELETE_FALLBACK_MAX_CENTER_DISTANCE = 0.16;

function hasComparableDeleteGeometry(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
) {
    return Boolean(normalizeMarkerRect(comment.markerRect) && normalizeMarkerRect(candidate.markerRect));
}

function hasSupportedDeleteGeometry(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
    iou: number,
    distance: number,
) {
    if (!hasComparableDeleteGeometry(comment, candidate)) {
        return true;
    }
    return iou >= DELETE_FALLBACK_MIN_IOU || distance <= DELETE_FALLBACK_MAX_CENTER_DISTANCE;
}

function scoreDeleteCandidateText(targetText: string, candidateText: string) {
    const textExact = targetText.length > 0 && candidateText.length > 0 && targetText === candidateText;
    let score = 0;

    if (textExact) {
        score += 6;
    }
    else if (
        targetText.length > 0
        && candidateText.length > 0
        && (candidateText.includes(targetText) || targetText.includes(candidateText))
    ) {
        score += 2;
    }
    else if (targetText.length > 0 && candidateText.length > 0) {
        score -= 1;
    }
    else if (targetText.length === 0 && candidateText.length === 0) {
        score += 0.5;
    }

    return {
        score,
        textExact,
    };
}

function scoreDeleteCandidateSubtype(
    targetSubtype: string,
    candidateSubtype: string,
) {
    return targetSubtype && candidateSubtype && targetSubtype === candidateSubtype ? 1.5 : 0;
}

function scoreDeleteCandidateSource(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
) {
    let score = 0;
    if (comment.hasNote === candidate.hasNote) score += 0.5;
    if (candidate.source === comment.source) score += 0.5;
    if (comment.source === 'editor' && candidate.source === 'pdf' && Boolean(candidate.annotationId || candidate.uid)) {
        score += 0.75;
    }
    return score;
}

function scoreDeleteCandidateRef(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
    textExact: boolean,
) {
    let score = 0;
    if (!comment.annotationId && candidate.annotationId) score += 2.1;
    if (!comment.uid && candidate.uid) score += 1.4;
    if (textExact && Boolean(candidate.annotationId || candidate.uid)) score += 0.9;
    return score;
}

function scoreDeleteCandidateGeometry(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
    textExact: boolean,
) {
    const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
    const distance = markerRectCenterDistance(comment.markerRect, candidate.markerRect);
    let score = 0;
    if (iou > 0) {
        score += iou * 6;
    }
    else if (normalizeMarkerRect(comment.markerRect) && normalizeMarkerRect(candidate.markerRect) && !textExact) {
        score -= 0.5;
    }
    return {
        score,
        iou,
        distance,
    };
}

export function scoreDeleteCandidate(
    comment: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
    targetText: string,
    targetSubtype: string,
) {
    const ct = candidate.text.trim().toLowerCase();
    const cs = (candidate.subtype ?? '').trim().toLowerCase();
    const textScore = scoreDeleteCandidateText(targetText, ct);
    const geometryScore = scoreDeleteCandidateGeometry(comment, candidate, textScore.textExact);
    const score = textScore.score
        + scoreDeleteCandidateSubtype(targetSubtype, cs)
        + scoreDeleteCandidateSource(comment, candidate)
        + scoreDeleteCandidateRef(comment, candidate, textScore.textExact)
        + geometryScore.score;

    return {
        candidate,
        score,
        textExact: textScore.textExact,
        iou: geometryScore.iou,
        distance: geometryScore.distance,
        geometrySupported: hasSupportedDeleteGeometry(comment, candidate, geometryScore.iou, geometryScore.distance),
    };
}
