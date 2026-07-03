import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import { clamp } from 'es-toolkit/math';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

function clampPageNumber(pageNumber: number, totalPages: number) {
    return clamp(Math.floor(pageNumber), 1, totalPages);
}

function resolveSinglePageRowBounds(pageNumber: number) {
    return {
        start: pageNumber,
        end: pageNumber,
    };
}

function resolveFacingRowBounds(pageNumber: number, totalPages: number) {
    const rowStart = pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
    const rowEnd = rowStart === totalPages ? rowStart : Math.min(totalPages, rowStart + 1);
    return {
        start: rowStart,
        end: rowEnd,
    };
}

function resolveFacingFirstSingleRowBounds(pageNumber: number, totalPages: number) {
    if (pageNumber === 1 || (pageNumber === totalPages && totalPages % 2 === 0)) {
        return resolveSinglePageRowBounds(pageNumber);
    }

    const rowStart = pageNumber % 2 === 0 ? pageNumber : pageNumber - 1;
    return {
        start: rowStart,
        end: Math.min(totalPages, rowStart + 1),
    };
}

function resolveSpreadRowBounds(
    pageNumber: number,
    viewMode: TPdfViewMode,
    totalPages: number,
) {
    const clampedPageNumber = clampPageNumber(pageNumber, totalPages);
    if (viewMode === 'single' || totalPages <= 1) {
        return resolveSinglePageRowBounds(clampedPageNumber);
    }

    return viewMode === 'facing'
        ? resolveFacingRowBounds(clampedPageNumber, totalPages)
        : resolveFacingFirstSingleRowBounds(clampedPageNumber, totalPages);
}

function getPagesInRowBounds(bounds: {
    start: number;
    end: number
}) {
    return Array.from(
        { length: Math.max(0, bounds.end - bounds.start + 1) },
        (_, index) => bounds.start + index,
    );
}

function getSpreadRowPages(
    pageNumber: number,
    viewMode: TPdfViewMode,
    totalPages: number,
) {
    return getPagesInRowBounds(resolveSpreadRowBounds(pageNumber, viewMode, totalPages));
}

function normalizeSpacing(value: number, fallback = 0) {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function resolveSafeLayoutSpacing(options: {
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
}) {
    const paddingTop = normalizeSpacing(options.paddingTop);
    return {
        gap: normalizeSpacing(options.gap),
        paddingTop,
        paddingBottom: typeof options.paddingBottom === 'number'
            ? normalizeSpacing(options.paddingBottom, paddingTop)
            : paddingTop,
    };
}

function scalePageDimensions(metrics: IPdfPageMetric[], scale: number) {
    return {
        pageWidths: metrics.map(metric => metric.width * scale),
        pageHeights: metrics.map(metric => metric.height * scale),
    };
}

function buildPageHeightPrefixSums(pageHeights: number[]) {
    const pageHeightPrefixSums = Array.from({ length: pageHeights.length }, () => 0);
    let maxPageHeight = 0;

    for (let index = 0; index < pageHeights.length; index += 1) {
        const height = pageHeights[index] ?? 0;
        pageHeightPrefixSums[index] = height + (pageHeightPrefixSums[index - 1] ?? 0);
        maxPageHeight = Math.max(maxPageHeight, height);
    }

    return {
        pageHeightPrefixSums,
        maxPageHeight,
    };
}

function buildLayoutRows(options: {
    totalPages: number;
    viewMode: TPdfViewMode;
    pageHeights: number[];
    gap: number;
    paddingTop: number;
    paddingBottom: number;
}) {
    const pageTops: number[] = [];
    const pageRowIndices = Array.from({ length: options.totalPages }, () => 0);
    const rowStartPages: number[] = [];
    const rowEndPages: number[] = [];
    const rowHeights: number[] = [];
    const rowHeightPrefixSums: number[] = [];
    let offset = options.paddingTop;
    let rowIndex = 0;

    for (let pageNumber = 1; pageNumber <= options.totalPages;) {
        const rowStartPage = pageNumber;
        const rowPages = getSpreadRowPages(pageNumber, options.viewMode, options.totalPages);
        const rowHeight = Math.max(...rowPages.map(rowPage => options.pageHeights[rowPage - 1] ?? 0));

        rowStartPages.push(rowStartPage);
        rowEndPages.push(rowPages[rowPages.length - 1] ?? rowStartPage);
        rowHeights.push(rowHeight);
        rowHeightPrefixSums.push(rowHeight + (rowHeightPrefixSums[rowHeightPrefixSums.length - 1] ?? 0));

        for (const rowPage of rowPages) {
            pageTops[rowPage - 1] = offset;
            pageRowIndices[rowPage - 1] = rowIndex;
        }

        pageNumber = (rowPages[rowPages.length - 1] ?? rowStartPage) + 1;
        offset += rowHeight;
        if (pageNumber <= options.totalPages) {
            offset += options.gap;
        }
        rowIndex += 1;
    }

    return {
        pageTops,
        pageRowIndices,
        rowStartPages,
        rowEndPages,
        rowHeights,
        rowHeightPrefixSums,
        contentHeight: offset + options.paddingBottom,
    };
}

export function buildPageLayoutMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    viewMode: TPdfViewMode;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}): IPdfPageLayoutMetrics | null {
    const {
        totalPages,
        viewMode,
        scale,
        gap,
        paddingTop,
        paddingBottom,
    } = options;

    if (totalPages <= 0 || !Number.isFinite(scale) || scale <= 0) {
        return null;
    }

    const metrics = normalizePageMetrics({
        pageMetrics: options.pageMetrics,
        totalPages,
        fallbackWidth: options.fallbackWidth,
        fallbackHeight: options.fallbackHeight,
    });

    if (metrics.length === 0) {
        return null;
    }

    const {
        gap: safeGap,
        paddingTop: safePaddingTop,
        paddingBottom: safePaddingBottom,
    } = resolveSafeLayoutSpacing({
        gap,
        paddingTop,
        ...(paddingBottom !== undefined ? { paddingBottom } : {}),
    });
    const {
        pageWidths,
        pageHeights,
    } = scalePageDimensions(metrics, scale);
    const {
        pageHeightPrefixSums,
        maxPageHeight,
    } = buildPageHeightPrefixSums(pageHeights);
    const rows = buildLayoutRows({
        totalPages,
        viewMode,
        pageHeights,
        gap: safeGap,
        paddingTop: safePaddingTop,
        paddingBottom: safePaddingBottom,
    });

    return {
        totalPages,
        gap: safeGap,
        paddingTop: safePaddingTop,
        paddingBottom: safePaddingBottom,
        maxPageHeight,
        pageWidths,
        pageHeights,
        pageHeightPrefixSums,
        pageTops: rows.pageTops,
        pageRowIndices: rows.pageRowIndices,
        rowStartPages: rows.rowStartPages,
        rowEndPages: rows.rowEndPages,
        rowHeights: rows.rowHeights,
        rowHeightPrefixSums: rows.rowHeightPrefixSums,
        contentHeight: rows.contentHeight,
    };
}
