import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

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
        const leftAnnotationId = normalizePdfJsAnnotationId(left.annotationId);
        const rightAnnotationId = normalizePdfJsAnnotationId(right.annotationId);
        return Boolean(
            leftAnnotationId
            && rightAnnotationId
            && leftAnnotationId === rightAnnotationId
            && left.pageIndex === right.pageIndex,
        );
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
