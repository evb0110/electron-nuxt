import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function commentsShareStableIdentifier(
    left: Pick<IAnnotationCommentSummary, 'annotationId' | 'uid'>,
    right: Pick<IAnnotationCommentSummary, 'annotationId' | 'uid'>,
) {
    if (left.annotationId && right.annotationId && left.annotationId === right.annotationId) {
        return true;
    }
    if (left.uid && right.uid && left.uid === right.uid) {
        return true;
    }
    return false;
}
