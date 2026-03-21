import { clamp } from 'es-toolkit/math';
import { measureDevPerf } from '@app/utils/dev-perf';

export interface IVisiblePageRange {
    start: number;
    end: number;
}

export interface IViewportVisibilityResult {
    range: IVisiblePageRange | null;
    mostVisiblePage: number | null;
}

export interface IPageScrollBounds {
    min: number;
    max: number;
}

interface IVisiblePageMetrics {
    range: IVisiblePageRange | null;
    mostVisiblePage: number | null;
    maxVisibleArea: number;
}

export interface IVisiblePageDebugEntry {
    pageNumber: number;
    pageTop: number;
    pageBottom: number;
    pageHeight: number;
    visibleTop: number;
    visibleBottom: number;
    visibleHeight: number;
}

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

function collectVisiblePageMetrics(container: HTMLElement): IVisiblePageMetrics {
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');

    let firstVisiblePage: number | null = null;
    let lastVisiblePage: number | null = null;
    let mostVisiblePage: number | null = null;
    let maxVisibleArea = 0;

    for (const pageElement of pageContainers) {
        const pageNumber = getPageNumberFromElement(pageElement);
        if (!pageNumber) {
            continue;
        }

        const pageTop = pageElement.offsetTop;
        const pageBottom = pageTop + pageElement.offsetHeight;
        const visibleTop = Math.max(pageTop, viewportTop);
        const visibleBottom = Math.min(pageBottom, viewportBottom);
        const visibleArea = Math.max(0, visibleBottom - visibleTop);

        if (visibleArea > 0) {
            if (firstVisiblePage === null) {
                firstVisiblePage = pageNumber;
            }
            lastVisiblePage = pageNumber;

            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                mostVisiblePage = pageNumber;
            }
        }

        if (pageTop > viewportBottom) {
            break;
        }
    }

    return {
        range:
            firstVisiblePage !== null && lastVisiblePage !== null
                ? {
                    start: firstVisiblePage,
                    end: lastVisiblePage,
                }
                : null,
        mostVisiblePage,
        maxVisibleArea,
    };
}

export function getViewportVisibilityFromDom(
    container: HTMLElement,
    totalPages: number,
): IViewportVisibilityResult {
    return measureDevPerf('pdf:scroll-visibility', () => {
        if (totalPages <= 0) {
            return {
                range: null,
                mostVisiblePage: null,
            };
        }

        const visible = collectVisiblePageMetrics(container);
        return {
            range: visible.range
                ? {
                    start: clamp(visible.range.start, 1, totalPages),
                    end: clamp(visible.range.end, 1, totalPages),
                }
                : null,
            mostVisiblePage:
                visible.maxVisibleArea > 0 && visible.mostVisiblePage !== null
                    ? clamp(visible.mostVisiblePage, 1, totalPages)
                    : null,
        };
    }, {
        thresholdMs: 8,
        details: { totalPages },
    });
}

export function getPageContainerByNumber(
    container: HTMLElement,
    pageNumber: number,
) {
    if (!Number.isFinite(pageNumber)) {
        return null;
    }

    const normalizedPageNumber = Math.max(1, Math.floor(pageNumber));
    return container.querySelector<HTMLElement>(
        `.page_container[data-page="${normalizedPageNumber}"]`,
    );
}

export function getVisiblePageRangeFromDom(
    container: HTMLElement,
    totalPages: number,
): IVisiblePageRange | null {
    return getViewportVisibilityFromDom(container, totalPages).range;
}

export function getMostVisiblePageFromDom(
    container: HTMLElement,
    totalPages: number,
) {
    return getViewportVisibilityFromDom(container, totalPages).mostVisiblePage;
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

export function getPageScrollBounds(
    container: HTMLElement,
    pageNumber: number,
    margin: number,
): IPageScrollBounds | null {
    const pageElement = getPageContainerByNumber(container, pageNumber);
    if (!pageElement) {
        return null;
    }

    const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
    );
    const unclampedMin = Math.max(0, pageElement.offsetTop - margin);
    const unclampedMax = unclampedMin + Math.max(
        0,
        pageElement.offsetHeight - container.clientHeight,
    );
    const min = Math.min(maxScrollTop, unclampedMin);
    const max = Math.min(maxScrollTop, Math.max(min, unclampedMax));

    return {
        min,
        max,
    };
}
