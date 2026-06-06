import type { IAnnotationCommentSummary } from '@app/types/annotations';

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
