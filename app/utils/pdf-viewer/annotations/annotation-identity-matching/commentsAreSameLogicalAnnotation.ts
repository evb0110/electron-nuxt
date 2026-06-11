import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { areTextMarkupCommentsLikelySame } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/areTextMarkupCommentsLikelySame';
import { likelyEditorPdfMirror } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/likelyEditorPdfMirror';

export function commentsAreSameLogicalAnnotation(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }

    if (left.annotationName && right.annotationName) {
        return left.annotationName === right.annotationName;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid;
    }

    if (left.id === right.id && left.source === right.source) {
        return true;
    }

    if (likelyEditorPdfMirror(left, right)) {
        return true;
    }

    if (
        !left.hasNote
        && !right.hasNote
        && areTextMarkupCommentsLikelySame(left, right)
    ) {
        return true;
    }

    return false;
}
