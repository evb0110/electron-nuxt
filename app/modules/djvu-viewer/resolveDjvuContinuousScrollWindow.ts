import { clamp } from 'es-toolkit/math';
import {
    createAnchorPageWindow,
    createPageNumbersForWindow,
    EMPTY_DOCUMENT_VIEWER_PAGE_RANGE,
} from '@app/utils/document-viewer/virtualization/pageVirtualization';

export interface IDjvuContinuousScrollWindow {
    start: number;
    end: number;
    mostVisiblePage: number | null;
    pageNumbers: number[];
}

export interface IDjvuContinuousScrollGeometry {
    pageHeights: number[];
    pageTops: number[];
    totalHeight: number;
}

export interface IResolveDjvuContinuousScrollGeometryOptions {
    pageGapPx: number;
    pageHeights: readonly number[];
    totalPages: number;
}

export interface IResolveDjvuContinuousScrollWindowOptions {
    currentPage: number;
    geometry?: IDjvuContinuousScrollGeometry;
    pageGapPx: number;
    pageHeights: readonly number[];
    renderMarginPages: number;
    scrollTop: number;
    totalPages: number;
    viewportHeight: number;
    overscanViewports: number;
}

interface IContinuousScrollBoundsState {
    visibleStart: number | null;
    visibleEnd: number | null;
    overscanStart: number | null;
    overscanEnd: number | null;
    mostVisiblePage: number | null;
    maxVisibleHeight: number;
}

function createContinuousScrollWindow(
    start: number,
    end: number,
    mostVisiblePage: number | null,
) {
    return {
        start,
        end,
        mostVisiblePage,
        pageNumbers: createPageNumbersForWindow({
            start,
            end,
        }),
    };
}

function clampPageRange(pageNumber: number, totalPages: number) {
    return clamp(pageNumber, 1, totalPages);
}

function resolveFallbackContinuousScrollRange(
    anchorPage: number,
    totalPages: number,
    renderMarginPages: number,
) {
    return createAnchorPageWindow({
        anchorPage,
        totalPages,
        radiusPages: renderMarginPages,
    }) ?? EMPTY_DOCUMENT_VIEWER_PAGE_RANGE;
}

function expandContinuousScrollRange(
    state: IContinuousScrollBoundsState,
    anchorPage: number,
    totalPages: number,
    renderMarginPages: number,
) {
    const baseStart = state.visibleStart ?? state.overscanStart ?? anchorPage;
    const baseEnd = state.visibleEnd ?? state.overscanEnd ?? anchorPage;
    const minStart = Math.max(1, (state.visibleStart ?? anchorPage) - renderMarginPages);
    const minEnd = Math.min(totalPages, (state.visibleEnd ?? anchorPage) + renderMarginPages);

    return {
        start: clampPageRange(Math.min(baseStart, minStart), totalPages),
        end: clampPageRange(Math.max(baseEnd, minEnd), totalPages),
    };
}

function createContinuousScrollBoundsState(anchorPage: number): IContinuousScrollBoundsState {
    return {
        visibleStart: null,
        visibleEnd: null,
        overscanStart: null,
        overscanEnd: null,
        mostVisiblePage: anchorPage,
        maxVisibleHeight: -1,
    };
}

function measureIntersectionHeight(
    top: number,
    bottom: number,
    viewportTop: number,
    viewportBottom: number,
) {
    return Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop));
}

function applyPageIntersectionToContinuousBounds(
    state: IContinuousScrollBoundsState,
    pageNumber: number,
    visibleHeight: number,
    overscanHeight: number,
) {
    if (overscanHeight > 0) {
        state.overscanStart ??= pageNumber;
        state.overscanEnd = pageNumber;
    }

    if (visibleHeight <= 0) {
        return;
    }

    state.visibleStart ??= pageNumber;
    state.visibleEnd = pageNumber;
    if (visibleHeight > state.maxVisibleHeight) {
        state.maxVisibleHeight = visibleHeight;
        state.mostVisiblePage = pageNumber;
    }
}

function getPageHeight(pageHeights: readonly number[], pageNumber: number) {
    const pageHeight = pageHeights[pageNumber - 1] ?? 0;
    return Number.isFinite(pageHeight)
        ? Math.max(0, pageHeight)
        : 0;
}

function getGeometryPageTop(
    geometry: IDjvuContinuousScrollGeometry,
    pageGapPx: number,
    pageNumber: number,
) {
    return geometry.pageTops[pageNumber - 1] ?? normalizeGapPx(pageGapPx);
}

function normalizeGapPx(value: number) {
    return Number.isFinite(value)
        ? Math.max(0, value)
        : 0;
}

export function resolveDjvuContinuousScrollGeometry(
    options: IResolveDjvuContinuousScrollGeometryOptions,
): IDjvuContinuousScrollGeometry {
    if (options.totalPages <= 0) {
        return {
            pageHeights: [],
            pageTops: [],
            totalHeight: 0,
        };
    }

    const pageGapPx = normalizeGapPx(options.pageGapPx);
    const pageHeights: number[] = [];
    const pageTops: number[] = [];
    let nextPageTop = pageGapPx;

    for (let pageNumber = 1; pageNumber <= options.totalPages; pageNumber += 1) {
        const pageHeight = getPageHeight(options.pageHeights, pageNumber);
        pageHeights.push(pageHeight);
        pageTops.push(nextPageTop);
        nextPageTop += pageHeight;
        if (pageNumber < options.totalPages) {
            nextPageTop += pageGapPx;
        }
    }

    return {
        pageHeights,
        pageTops,
        totalHeight: nextPageTop + pageGapPx,
    };
}

function resolveContinuousScrollBounds(
    options: IResolveDjvuContinuousScrollWindowOptions,
    anchorPage: number,
    geometry: IDjvuContinuousScrollGeometry,
    viewportTop: number,
    viewportBottom: number,
    overscanTop: number,
    overscanBottom: number,
) {
    const state = createContinuousScrollBoundsState(anchorPage);
    const pageGapPx = normalizeGapPx(options.pageGapPx);
    const firstPage = findFirstPageWithBottomAfter(geometry, pageGapPx, overscanTop, options.totalPages);
    const lastPage = findLastPageWithTopBefore(geometry, overscanBottom, options.totalPages);

    if (firstPage > lastPage) {
        return state;
    }

    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        const pageTop = getGeometryPageTop(geometry, pageGapPx, pageNumber);
        const pageHeight = geometry.pageHeights[pageNumber - 1] ?? 0;
        const pageBottom = pageTop + pageHeight;
        const visibleHeight = measureIntersectionHeight(pageTop, pageBottom, viewportTop, viewportBottom);
        const overscanHeight = measureIntersectionHeight(pageTop, pageBottom, overscanTop, overscanBottom);

        applyPageIntersectionToContinuousBounds(
            state,
            pageNumber,
            visibleHeight,
            overscanHeight,
        );
    }

    return state;
}

function findFirstPageWithBottomAfter(
    geometry: IDjvuContinuousScrollGeometry,
    pageGapPx: number,
    boundary: number,
    totalPages: number,
) {
    let low = 1;
    let high = totalPages + 1;

    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const pageTop = getGeometryPageTop(geometry, pageGapPx, middle);
        const pageBottom = pageTop + (geometry.pageHeights[middle - 1] ?? 0);

        if (pageBottom > boundary) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    return low;
}

function findLastPageWithTopBefore(
    geometry: IDjvuContinuousScrollGeometry,
    boundary: number,
    totalPages: number,
) {
    let low = 1;
    let high = totalPages + 1;

    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const pageTop = geometry.pageTops[middle - 1] ?? 0;

        if (pageTop < boundary) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low - 1;
}

export function resolveDjvuContinuousScrollWindow(options: IResolveDjvuContinuousScrollWindowOptions): IDjvuContinuousScrollWindow | null {
    if (options.totalPages <= 0) {
        return null;
    }

    const anchorPage = clamp(options.currentPage, 1, options.totalPages);
    const geometry = options.geometry ?? resolveDjvuContinuousScrollGeometry(options);
    if (options.viewportHeight <= 0) {
        const {
            start,
            end,
        } = resolveFallbackContinuousScrollRange(
            anchorPage,
            options.totalPages,
            options.renderMarginPages,
        );
        return createContinuousScrollWindow(start, end, anchorPage);
    }

    const viewportTop = Math.max(0, options.scrollTop);
    const viewportBottom = viewportTop + options.viewportHeight;
    const overscanTop = Math.max(0, viewportTop - options.viewportHeight * options.overscanViewports);
    const overscanBottom = viewportBottom + options.viewportHeight * options.overscanViewports;
    const bounds = resolveContinuousScrollBounds(
        options,
        anchorPage,
        geometry,
        viewportTop,
        viewportBottom,
        overscanTop,
        overscanBottom,
    );
    const {
        start,
        end,
    } = expandContinuousScrollRange(
        bounds,
        anchorPage,
        options.totalPages,
        options.renderMarginPages,
    );

    return createContinuousScrollWindow(start, end, bounds.mostVisiblePage);
}
