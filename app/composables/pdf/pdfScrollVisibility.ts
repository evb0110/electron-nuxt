import { clamp } from 'es-toolkit/math';

export interface IVisiblePageRange {
    start: number;
    end: number;
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
    if (totalPages <= 0) {
        return null;
    }

    const visible = collectVisiblePageMetrics(container).range;
    if (!visible) {
        return null;
    }

    return {
        start: clamp(visible.start, 1, totalPages),
        end: clamp(visible.end, 1, totalPages),
    };
}

export function getMostVisiblePageFromDom(
    container: HTMLElement,
    totalPages: number,
) {
    if (totalPages <= 0) {
        return null;
    }

    const metrics = collectVisiblePageMetrics(container);
    if (metrics.maxVisibleArea <= 0 || metrics.mostVisiblePage === null) {
        return null;
    }

    return clamp(metrics.mostVisiblePage, 1, totalPages);
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
