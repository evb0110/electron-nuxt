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

export interface IResolveDjvuContinuousScrollWindowOptions {
    currentPage: number;
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

function resolveContinuousScrollBounds(
    options: IResolveDjvuContinuousScrollWindowOptions,
    anchorPage: number,
    viewportTop: number,
    viewportBottom: number,
    overscanTop: number,
    overscanBottom: number,
) {
    const state = createContinuousScrollBoundsState(anchorPage);
    let pageTop = options.pageGapPx;

    for (let pageNumber = 1; pageNumber <= options.totalPages; pageNumber += 1) {
        const pageHeight = getPageHeight(options.pageHeights, pageNumber);
        const pageBottom = pageTop + pageHeight;
        const visibleHeight = measureIntersectionHeight(pageTop, pageBottom, viewportTop, viewportBottom);
        const overscanHeight = measureIntersectionHeight(pageTop, pageBottom, overscanTop, overscanBottom);

        applyPageIntersectionToContinuousBounds(
            state,
            pageNumber,
            visibleHeight,
            overscanHeight,
        );

        pageTop = pageBottom + (pageNumber < options.totalPages ? options.pageGapPx : 0);
    }

    return state;
}

export function resolveDjvuContinuousScrollWindow(options: IResolveDjvuContinuousScrollWindowOptions): IDjvuContinuousScrollWindow | null {
    if (options.totalPages <= 0) {
        return null;
    }

    const anchorPage = clamp(options.currentPage, 1, options.totalPages);
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

