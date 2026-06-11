import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationCommentEditScore } from '@app/utils/pdf-viewer/annotation-comment-matching/annotationCommentEditScore';

function hasStablePdfAnnotationKey(comment: IAnnotationCommentSummary) {
    return /^nm:.+$/u.test(comment.stableKey)
        || /^ann:\d+:\d+R(?:\d+)?$/u.test(comment.stableKey);
}

export function selectPreferredAnnotationComment(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    const leftHasStablePdfKey = hasStablePdfAnnotationKey(left);
    const rightHasStablePdfKey = hasStablePdfAnnotationKey(right);
    if (leftHasStablePdfKey !== rightHasStablePdfKey) {
        return leftHasStablePdfKey ? left : right;
    }

    if (left.annotationName && !right.annotationName) {
        return left;
    }
    if (right.annotationName && !left.annotationName) {
        return right;
    }

    // When one side has a stable PDF annotation reference and the other does not,
    // always prefer the stable reference to avoid keeping stale editor-only ids.
    if (left.annotationId && !right.annotationId) {
        return left;
    }
    if (right.annotationId && !left.annotationId) {
        return right;
    }

    const leftScore = annotationCommentEditScore(left);
    const rightScore = annotationCommentEditScore(right);
    if (leftScore !== rightScore) {
        return leftScore > rightScore ? left : right;
    }

    const leftTextLength = left.text.trim().length;
    const rightTextLength = right.text.trim().length;
    if (leftTextLength !== rightTextLength) {
        return leftTextLength > rightTextLength ? left : right;
    }

    const leftModified = left.modifiedAt ?? 0;
    const rightModified = right.modifiedAt ?? 0;
    if (leftModified !== rightModified) {
        return leftModified > rightModified ? left : right;
    }

    return left;
}
