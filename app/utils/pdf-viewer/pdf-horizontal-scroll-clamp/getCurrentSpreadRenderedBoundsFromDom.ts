import { getPageRowBoundsForViewMode } from '@app/utils/pdf-viewer/pdf-page-layout/getPageRowBoundsForViewMode';
import type { IRenderedSpreadHorizontalBounds } from '@app/utils/pdf-viewer/pdf-horizontal-scroll-clamp/pdfHorizontalScrollClampTypes';

export function getCurrentSpreadRenderedBoundsFromDom(options: {
    container: HTMLElement;
    pageNumber: number;
    viewMode: 'single' | 'facing' | 'facing-first-single';
    totalPages: number;
}): IRenderedSpreadHorizontalBounds | null {
    const bounds = getPageRowBoundsForViewMode({
        pageNumber: options.pageNumber,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    const containerRect = options.container.getBoundingClientRect();
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;

    for (let pageNumber = bounds.start; pageNumber <= bounds.end; pageNumber += 1) {
        const pageElement = options.container.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (!pageElement) {
            return null;
        }

        const pageRect = pageElement.getBoundingClientRect();
        const pageWidth = pageRect.width || pageElement.offsetWidth || pageElement.clientWidth;
        if (!Number.isFinite(pageWidth) || pageWidth <= 0) {
            return null;
        }

        const pageLeft = Number.isFinite(pageRect.left)
            ? pageRect.left - containerRect.left + options.container.scrollLeft
            : pageElement.offsetLeft;
        if (!Number.isFinite(pageLeft)) {
            return null;
        }

        left = Math.min(left, pageLeft);
        right = Math.max(right, pageLeft + pageWidth);
    }

    const width = right - left;
    return Number.isFinite(width) && width > 0
        ? {
            left: Math.max(0, left),
            width,
        }
        : null;
}
