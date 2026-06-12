import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { IAnnotationDeleteResolverIdentity } from '@app/modules/pdf-viewer/engine/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';

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

export function findDirectStableRefDeleteTarget(
    comment: IAnnotationCommentSummary,
    candidates: IAnnotationCommentSummary[],
    targetText: string,
    identity: IAnnotationDeleteResolverIdentity,
) {
    if (!targetText) {
        return null;
    }

    const matches: Array<{
        candidate: IAnnotationCommentSummary;
        iou: number;
        distance: number;
    }> = [];
    for (const candidate of candidates) {
        const candidateText = candidate.text.trim().toLowerCase();
        if (candidateText.length === 0 || candidateText !== targetText || !(candidate.annotationId || candidate.uid)) {
            continue;
        }
        const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
        const distance = markerRectCenterDistance(comment.markerRect, candidate.markerRect);
        if (hasSupportedDeleteGeometry(comment, candidate, iou, distance)) {
            matches.push({
                candidate,
                iou,
                distance,
            });
        }
    }

    return matches
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
