import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import {
    markerRectIoU,
    normalizeMarkerRect,
} from '@app/composables/pdf/annotationGeometry';

export interface IAnnotationDeleteResolverIdentity {
    resolveCommentFromCache: (comment: IAnnotationCommentSummary) => IAnnotationCommentSummary | null;
    commentMergePriority: (comment: IAnnotationCommentSummary) => number;
}

interface IResolveCommentForDeleteOptions {
    comment: IAnnotationCommentSummary;
    candidates: IAnnotationCommentSummary[];
    identity: IAnnotationDeleteResolverIdentity;
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null;
}

interface IResolveStablePdfDeleteFallbackOptions {
    comment: IAnnotationCommentSummary;
    candidates: IAnnotationCommentSummary[];
    identity: IAnnotationDeleteResolverIdentity;
}

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

export function findStrictDeleteTarget(
    comment: IAnnotationCommentSummary,
    identity: IAnnotationDeleteResolverIdentity,
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null,
) {
    const strictResolved = identity.resolveCommentFromCache(comment);
    if (!strictResolved) {
        return null;
    }

    const hasStablePdfRef = Boolean(strictResolved.annotationId);
    const strictEditor = findEditorForComment(strictResolved);
    return hasStablePdfRef || strictEditor ? strictResolved : null;
}

export function findDirectStableRefDeleteTarget(
    comment: IAnnotationCommentSummary,
    candidates: IAnnotationCommentSummary[],
    targetText: string,
    identity: IAnnotationDeleteResolverIdentity,
) {
    if (!targetText) {
        return null;
    }

    return candidates
        .map((candidate) => {
            const candidateText = candidate.text.trim().toLowerCase();
            if (candidateText.length === 0 || candidateText !== targetText || !(candidate.annotationId || candidate.uid)) {
                return null;
            }
            const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
            const distance = markerRectCenterDistance(comment.markerRect, candidate.markerRect);
            if (!hasSupportedDeleteGeometry(comment, candidate, iou, distance)) {
                return null;
            }
            return {
                candidate,
                iou,
                distance,
            };
        })
        .filter((match): match is NonNullable<typeof match> => Boolean(match))
        .sort((l, r) => {
            if (l.iou !== r.iou) {
                return r.iou - l.iou;
            }
            if (l.distance !== r.distance) {
                return l.distance - r.distance;
            }
            return identity.commentMergePriority(r.candidate) - identity.commentMergePriority(l.candidate);
        })[0]?.candidate ?? null;
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

export function pickScoredDeleteTarget(
    scored: Array<ReturnType<typeof scoreDeleteCandidate>>,
) {
    const best = scored[0];
    if (!best) {
        return null;
    }

    const second = scored[1];
    const isClearlyBetter = !second
        || (best.score - second.score >= 0.6)
        || (best.textExact && !second.textExact)
        || ((best.iou - (second.iou ?? 0)) >= 0.08);
    const acceptable = best.geometrySupported && (best.score >= 2.5 || best.textExact || best.iou >= 0.12);
    return acceptable && isClearlyBetter ? best.candidate : null;
}

export function resolveCommentForDelete(options: IResolveCommentForDeleteOptions) {
    const {
        comment,
        candidates,
        identity,
        findEditorForComment,
    } = options;
    const strictResolved = findStrictDeleteTarget(comment, identity, findEditorForComment);
    if (strictResolved) {
        return strictResolved;
    }

    const pageCandidates = candidates.filter(c => c.pageIndex === comment.pageIndex);
    if (pageCandidates.length === 0) {
        return null;
    }

    const targetText = comment.text.trim().toLowerCase();
    const directStableRefMatch = findDirectStableRefDeleteTarget(comment, pageCandidates, targetText, identity);
    if (directStableRefMatch) {
        return directStableRefMatch;
    }

    const targetSubtype = (comment.subtype ?? '').trim().toLowerCase();
    const scored = pageCandidates
        .map(candidate => scoreDeleteCandidate(comment, candidate, targetText, targetSubtype))
        .sort((l, r) => r.score - l.score);

    return pickScoredDeleteTarget(scored);
}

export function resolveStablePdfDeleteFallback(options: IResolveStablePdfDeleteFallbackOptions) {
    const {
        comment,
        candidates,
        identity,
    } = options;
    const targetText = comment.text.trim().toLowerCase();

    const scoredCandidates = candidates
        .filter(c => c.pageIndex === comment.pageIndex && Boolean(c.annotationId))
        .map((candidate) => {
            const ct = candidate.text.trim().toLowerCase();
            if (targetText.length > 0 && ct.length > 0 && targetText !== ct) {
                return null;
            }
            const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
            const distance = markerRectCenterDistance(comment.markerRect, candidate.markerRect);
            if (!hasSupportedDeleteGeometry(comment, candidate, iou, distance)) {
                return null;
            }
            return {
                candidate,
                iou,
                distance,
                score: (
                    (ct && targetText && ct === targetText ? 8 : 0)
                    + (iou * 10)
                    + Math.max(0, 3 - (distance * 8))
                    + identity.commentMergePriority(candidate)
                ),
            };
        })
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
        .sort((l, r) => {
            if (l.score !== r.score) {
                return r.score - l.score;
            }
            if (l.iou !== r.iou) {
                return r.iou - l.iou;
            }
            if (l.distance !== r.distance) {
                return l.distance - r.distance;
            }
            return r.candidate.stableKey.localeCompare(l.candidate.stableKey);
        });

    const best = scoredCandidates[0] ?? null;
    if (!best) {
        return null;
    }
    const second = scoredCandidates[1] ?? null;
    const clearlyBetter = !second || (best.score - second.score >= 0.9) || ((best.iou - second.iou) >= 0.1);
    const acceptable = best.iou >= DELETE_FALLBACK_MIN_IOU || best.distance <= DELETE_FALLBACK_MAX_CENTER_DISTANCE
        || (targetText.length > 0 && best.candidate.text.trim().toLowerCase() === targetText);
    if (!clearlyBetter || !acceptable) {
        return null;
    }
    return best.candidate;
}
