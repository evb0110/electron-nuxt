import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';
import { markerRectIoU } from '@app/utils/pdf-viewer/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import type { IAnnotationDeleteResolverIdentity } from '@app/utils/pdf-viewer/annotations/annotation-delete-resolver/annotationDeleteResolverIdentity';

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
