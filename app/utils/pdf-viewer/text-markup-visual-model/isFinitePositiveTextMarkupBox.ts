import type { IPdfjsHighlightBox } from '@app/types/pdfjs';

export function isFinitePositiveTextMarkupBox(box: IPdfjsHighlightBox) {
    return Number.isFinite(box.x)
        && Number.isFinite(box.y)
        && Number.isFinite(box.width)
        && Number.isFinite(box.height)
        && box.width > 0
        && box.height > 0;
}
