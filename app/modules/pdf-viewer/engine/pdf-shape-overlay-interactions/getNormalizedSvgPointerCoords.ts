import { resolveSvgPointerTarget } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/resolveSvgPointerTarget';
import type { IPointerEventLike } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/pdfShapeOverlayInteractionTypes';

export function getNormalizedSvgPointerCoords(event: IPointerEventLike) {
    const svg = resolveSvgPointerTarget(event);
    if (!svg) {
        return null;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }

    return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
    };
}
