import type { IAnnotationCommentSummary } from '@app/types/annotations';

type TAnnotationCommentMatchInput = Pick<
    IAnnotationCommentSummary,
    'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'
>;

export function annotationCommentsMatch(
    left: TAnnotationCommentMatchInput,
    right: TAnnotationCommentMatchInput,
) {
    if (left.stableKey && right.stableKey) {
        return left.stableKey === right.stableKey;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId && left.pageIndex === right.pageIndex;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid && left.pageIndex === right.pageIndex;
    }

    return (
        left.id === right.id
        && left.pageIndex === right.pageIndex
        && left.source === right.source
    );
}

export function annotationCommentEditScore(comment: IAnnotationCommentSummary) {
    let score = 0;
    if (comment.source === 'editor') {
        score += 8;
    }
    if (comment.uid) {
        score += 6;
    }
    if (comment.annotationId) {
        score += 4;
    }
    if (comment.id) {
        score += 2;
    }
    if (comment.markerRect) {
        score += 1;
    }
    return score;
}

function hasStablePdfAnnotationKey(comment: IAnnotationCommentSummary) {
    return /^ann:\d+:\d+R(?:\d+)?$/u.test(comment.stableKey);
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
