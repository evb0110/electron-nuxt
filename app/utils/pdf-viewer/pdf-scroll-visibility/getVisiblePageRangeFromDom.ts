import { getViewportVisibilityFromDom } from '@app/utils/pdf-viewer/pdf-scroll-visibility/getViewportVisibilityFromDom';
import type { IVisiblePageRange } from '@app/utils/pdf-viewer/pdf-scroll-visibility/pdfScrollVisibilityTypes';

export function getVisiblePageRangeFromDom(
    container: HTMLElement,
    totalPages: number,
): IVisiblePageRange | null {
    return getViewportVisibilityFromDom(container, totalPages).range;
}
