import type { IEditedTextMarkupVisualOptions } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { reconcileTextMarkupVisualOverlays } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/reconcileTextMarkupVisualOverlays';

export function applyAnnotationCommentTextMarkupVisualOverlay(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    color: string,
    options: IEditedTextMarkupVisualOptions = {},
) {
    return reconcileTextMarkupVisualOverlays(
        container,
        {
            comments: [comment],
            removeSameKeyOnLiveHighlight: true,
            removeStaleVisuals: false,
            requireColorEdited: false,
            resolveColor: () => color,
            resolveHighlightOpacity: () => options.highlightOpacity,
        },
    ) > 0;
}
