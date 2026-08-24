import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfjsHighlightBox } from '@app/types/pdfjs';

/**
 * PDF.js describes a text-markup quad as `{x, y, width, height}`; the canonical
 * annotation store uses `{left, top, width, height}`. Both are page-normalized,
 * so the translation is a rename in each direction.
 */
export function markerRectsFromHighlightBoxes(boxes: readonly IPdfjsHighlightBox[]): IAnnotationMarkerRect[] {
    return boxes.map(box => ({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
    }));
}

export function highlightBoxesFromMarkerRects(rects: readonly IAnnotationMarkerRect[]): IPdfjsHighlightBox[] {
    return rects.map(rect => ({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
    }));
}

export function cloneHighlightBoxes(boxes: readonly IPdfjsHighlightBox[]) {
    return boxes.map(box => ({ ...box }));
}
