import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function commentsShareStableIdentifier(
    left: Pick<IAnnotationCommentSummary, 'annotationId' | 'annotationName' | 'uid'>,
    right: Pick<IAnnotationCommentSummary, 'annotationId' | 'annotationName' | 'uid'>,
) {
    if (left.annotationName && right.annotationName && left.annotationName === right.annotationName) {
        return true;
    }
    if (left.annotationId && right.annotationId && left.annotationId === right.annotationId) {
        return true;
    }
    if (left.uid && right.uid && left.uid === right.uid) {
        return true;
    }
    return false;
}
