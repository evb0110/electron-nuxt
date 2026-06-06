import { clamp } from 'es-toolkit/math';
import { measureDevPerf } from '@app/utils/devPerf';
import type {
    IViewportVisibilityResult,
    IVisiblePageRange,
} from '@app/utils/pdf-viewer/pdf-scroll-visibility/pdfScrollVisibilityTypes';

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

function isBufferedPageElement(element: HTMLElement) {
    return element.classList?.contains('page_container--buffered') === true;
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
        if (isBufferedPageElement(pageElement)) {
            continue;
        }

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
