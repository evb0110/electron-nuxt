import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { reconcileTextMarkupVisualOverlays } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/reconcileTextMarkupVisualOverlays';

export function syncAnnotationCommentTextMarkupVisualOverlays(
    container: HTMLElement,
    comments: readonly IAnnotationCommentSummary[],
    options: {
        pageNumber?: number | undefined;
        resolveColor: (comment: IAnnotationCommentSummary) => string | null;
        resolveHighlightOpacity?: (comment: IAnnotationCommentSummary) => number | null | undefined;
    },
) {
    return reconcileTextMarkupVisualOverlays(
        container,
        {
            comments,
            pageNumber: options.pageNumber,
            removeSameKeyOnLiveHighlight: false,
            removeStaleVisuals: true,
            requireColorEdited: true,
            resolveColor: options.resolveColor,
            resolveHighlightOpacity: options.resolveHighlightOpacity,
        },
    );
}
