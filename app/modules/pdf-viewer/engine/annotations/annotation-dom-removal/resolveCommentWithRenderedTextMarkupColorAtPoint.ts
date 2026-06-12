import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resolveAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

export function resolveCommentWithRenderedTextMarkupColorAtPoint(
    container: HTMLElement | null,
    comment: IAnnotationCommentSummary | null,
    clientX: number,
    clientY: number,
) {
    if (!container || !comment || !isTextMarkupSubtype(comment.subtype)) {
        return comment;
    }
    if (normalizeTextMarkupSubtype(comment.subtype) === 'highlight' && comment.color?.trim()) {
        return comment;
    }
    const diagnostics = resolveAnnotationCommentTextMarkupColor(
        container,
        comment,
        {atPoint: {
            pageX: clientX,
            pageY: clientY,
        }},
    );
    BrowserLogger.debug('annotations', 'Resolved text markup context-menu color', () => ({
        annotationId: diagnostics.annotationId,
        originalColor: comment.color ?? null,
        renderedColor: diagnostics.color,
        source: diagnostics.source,
        fallbackSource: diagnostics.fallbackSource ?? null,
        element: diagnostics.element,
        subtype: diagnostics.subtype,
        pageNumber: diagnostics.pageNumber,
        pointElementCount: diagnostics.pointElementCount ?? null,
    }));
    return diagnostics.color
        ? {
            ...comment,
            color: diagnostics.color,
        }
        : comment;
}
