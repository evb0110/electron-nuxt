import type { IVisiblePageDebugEntry } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import {
    getPageNumberFromElement,
    isBufferedPageElement,
} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';

export function getVisiblePageDebugSnapshot(
    container: HTMLElement,
    totalPages: number,
    limit = 8,
) {
    if (totalPages <= 0 || limit <= 0) {
        return [] as IVisiblePageDebugEntry[];
    }

    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const entries: IVisiblePageDebugEntry[] = [];
    const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');

    for (const pageElement of pageContainers) {
        if (isBufferedPageElement(pageElement)) {
            continue;
        }

        const pageNumber = getPageNumberFromElement(pageElement);
        if (!pageNumber || pageNumber > totalPages) {
            continue;
        }

        const pageTop = pageElement.offsetTop;
        const pageBottom = pageTop + pageElement.offsetHeight;
        const visibleTop = Math.max(pageTop, viewportTop);
        const visibleBottom = Math.min(pageBottom, viewportBottom);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);

        entries.push({
            pageNumber,
            pageTop,
            pageBottom,
            pageHeight: pageElement.offsetHeight,
            visibleTop,
            visibleBottom,
            visibleHeight,
        });
    }

    return entries
        .sort((left, right) => right.visibleHeight - left.visibleHeight)
        .slice(0, limit);
}
