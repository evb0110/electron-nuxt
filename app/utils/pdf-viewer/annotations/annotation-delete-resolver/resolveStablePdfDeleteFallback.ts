import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';
import { markerRectIoU } from '@app/utils/pdf-viewer/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import type { IAnnotationDeleteResolverIdentity } from '@app/utils/pdf-viewer/annotations/annotation-delete-resolver/annotationDeleteResolverTypes';

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
