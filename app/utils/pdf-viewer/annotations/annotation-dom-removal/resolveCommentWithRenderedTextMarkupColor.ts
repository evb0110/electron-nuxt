import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { resolveAnnotationCommentTextMarkupColor } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

export function resolveCommentWithRenderedTextMarkupColor(
    container: HTMLElement | null,
    comment: IAnnotationCommentSummary | null,
) {
    if (!container || !comment || !isTextMarkupSubtype(comment.subtype)) {
        return comment;
    }
    if (normalizeTextMarkupSubtype(comment.subtype) === 'highlight' && comment.color?.trim()) {
        return comment;
    }
    const renderedColor = resolveAnnotationCommentTextMarkupColor(container, comment);
    return renderedColor
        ? {
            ...comment,
            color: renderedColor,
        }
        : comment;
}
