import type { IVisiblePageDebugEntry } from '@app/utils/pdf-viewer/pdf-scroll-visibility/pdfScrollVisibilityTypes';

function normalizePageNumber(value: unknown) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }

    const pageNumber = Number.parseInt(value, 10);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return null;
    }

    return pageNumber;
}

function getPageNumberFromElement(element: HTMLElement) {
    return normalizePageNumber(element.dataset.page);
}

function isBufferedPageElement(element: HTMLElement) {
    return element.classList?.contains('page_container--buffered') === true;
}

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
