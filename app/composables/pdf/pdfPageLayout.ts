import type {
    IPdfPageMetric,
    TPdfViewMode,
} from '@app/types/pdf';
import {
    clamp,
    sumBy,
} from 'es-toolkit/math';

export interface IPdfPageLayoutMetrics {
    totalPages: number;
    gap: number;
    paddingTop: number;
    paddingBottom: number;
    maxPageHeight: number;
    pageWidths: number[];
    pageHeights: number[];
    pageHeightPrefixSums: number[];
    pageTops: number[];
    pageRowIndices: number[];
    rowStartPages: number[];
    rowEndPages: number[];
    rowHeights: number[];
    rowHeightPrefixSums: number[];
    contentHeight: number;
}

function isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidPageMetric(metric: IPdfPageMetric | null | undefined): metric is IPdfPageMetric {
    return isFinitePositive(metric?.width) && isFinitePositive(metric?.height);
}

function clonePageMetric(metric: IPdfPageMetric): IPdfPageMetric {
    return {
        width: metric.width,
        height: metric.height,
    };
}

function resolveNearestMetricEstimate(
    before: {
        index: number;
        metric: IPdfPageMetric;
    } | null,
    after: {
        index: number;
        metric: IPdfPageMetric;
    } | null,
    targetIndex: number,
    fallbackMetric: IPdfPageMetric,
) {
    if (before && after) {
        const beforeDistance = targetIndex - before.index;
        const afterDistance = after.index - targetIndex;
        return beforeDistance <= afterDistance ? before.metric : after.metric;
    }

    return before?.metric ?? after?.metric ?? fallbackMetric;
}

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
    const pageHeightPrefixSums: number[] = Array.from({ length: pageHeights.length }, () => 0);
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
    const pageRowIndices: number[] = Array.from({ length: options.totalPages }, () => 0);
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

export function getPageRowBoundsForViewMode(options: {
    pageNumber: number;
    viewMode: TPdfViewMode;
    totalPages: number;
}) {
    return resolveSpreadRowBounds(options.pageNumber, options.viewMode, options.totalPages);
}

export function normalizePageMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}): IPdfPageMetric[] {
    const {
        pageMetrics,
        totalPages,
        fallbackWidth,
        fallbackHeight,
    } = options;

    if (totalPages <= 0) {
        return [];
    }

    const safeFallbackWidth = isFinitePositive(fallbackWidth) ? fallbackWidth : 1;
    const safeFallbackHeight = isFinitePositive(fallbackHeight) ? fallbackHeight : 1;
    const fallbackMetric = {
        width: safeFallbackWidth,
        height: safeFallbackHeight,
    } satisfies IPdfPageMetric;
    const nearestBefore: Array<{
        index: number;
        metric: IPdfPageMetric;
    } | null> = Array.from({ length: totalPages }, () => null);
    let previousKnownMetric: {
        index: number;
        metric: IPdfPageMetric;
    } | null = null;

    for (let index = 0; index < totalPages; index += 1) {
        nearestBefore[index] = previousKnownMetric;
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            previousKnownMetric = {
                index,
                metric,
            };
        }
    }

    const normalizedMetrics = new Array<IPdfPageMetric>(totalPages);
    let nextKnownMetric: {
        index: number;
        metric: IPdfPageMetric;
    } | null = null;

    for (let index = totalPages - 1; index >= 0; index -= 1) {
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            normalizedMetrics[index] = clonePageMetric(metric);
            nextKnownMetric = {
                index,
                metric,
            };
            continue;
        }

        normalizedMetrics[index] = clonePageMetric(resolveNearestMetricEstimate(
            nearestBefore[index] ?? null,
            nextKnownMetric,
            index,
            fallbackMetric,
        ));
    }

    return normalizedMetrics;
}

export function resolveDocumentBaseMetric(
    pageMetrics: IPdfPageMetric[],
    dimension: 'width' | 'height',
): number | null {
    let maxValue = 0;

    for (const metric of pageMetrics) {
        const value = metric?.[dimension];
        if (!isFinitePositive(value)) {
            continue;
        }
        maxValue = Math.max(maxValue, value);
    }

    return maxValue > 0 ? maxValue : null;
}

export function resolveSpreadBaseWidth(
    pageMetrics: IPdfPageMetric[],
    viewMode: TPdfViewMode,
    totalPages: number,
): number | null {
    if (totalPages <= 0) {
        return null;
    }

    if (viewMode === 'single' || totalPages === 1) {
        return resolveDocumentBaseMetric(pageMetrics, 'width');
    }

    let maxWidth = 0;
    let pageNumber = 1;

    while (pageNumber <= totalPages) {
        const rowPages = getSpreadRowPages(pageNumber, viewMode, totalPages);
        const rowWidth = sumBy(rowPages, (rowPage) => {
            const pageWidth = pageMetrics[rowPage - 1]?.width;
            return isFinitePositive(pageWidth) ? pageWidth : 0;
        });
        maxWidth = Math.max(maxWidth, rowWidth);
        pageNumber = rowPages[rowPages.length - 1] ?? pageNumber;
        pageNumber += 1;
    }

    return maxWidth > 0 ? maxWidth : null;
}

export function resolveCurrentSpreadBaseWidth(
    pageMetrics: IPdfPageMetric[],
    viewMode: TPdfViewMode,
    totalPages: number,
    currentPage: number,
): number | null {
    if (totalPages <= 0) {
        return null;
    }

    const rowPages = getSpreadRowPages(currentPage, viewMode, totalPages);
    const width = sumBy(rowPages, (rowPage) => {
        const pageWidth = pageMetrics[rowPage - 1]?.width;
        return isFinitePositive(pageWidth) ? pageWidth : 0;
    });

    return width > 0 ? width : null;
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

export function getPageTop(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    return layout.pageTops[Math.max(0, pageNumber - 1)] ?? null;
}

export function getPageHeight(layout: IPdfPageLayoutMetrics, pageNumber: number) {
    return layout.pageHeights[Math.max(0, pageNumber - 1)] ?? null;
}

export function getLeadingSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    hiddenPages: number,
) {
    const clampedHiddenPages = clamp(hiddenPages, 0, layout.totalPages);
    if (clampedHiddenPages === 0) {
        return 0;
    }

    return (layout.pageHeightPrefixSums[clampedHiddenPages - 1] ?? 0)
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}

export function getLeadingSpacerHeightForPage(
    layout: IPdfPageLayoutMetrics,
    firstVisiblePage: number,
) {
    if (!Number.isFinite(firstVisiblePage) || firstVisiblePage < 1) {
        return 0;
    }

    const pageIndex = Math.min(layout.totalPages, Math.floor(firstVisiblePage)) - 1;
    const rowIndex = layout.pageRowIndices[pageIndex] ?? -1;
    if (!Number.isFinite(rowIndex) || rowIndex <= 0) {
        return 0;
    }

    return (layout.rowHeightPrefixSums[rowIndex - 1] ?? 0)
        + Math.max(0, rowIndex - 1) * layout.gap;
}

export function getTrailingSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    hiddenPages: number,
) {
    const clampedHiddenPages = clamp(hiddenPages, 0, layout.totalPages);
    if (clampedHiddenPages === 0) {
        return 0;
    }

    return (
        (layout.pageHeightPrefixSums[layout.totalPages - 1] ?? 0)
        - (layout.pageHeightPrefixSums[layout.totalPages - clampedHiddenPages - 1] ?? 0)
    )
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}

export function getTrailingSpacerHeightForPage(
    layout: IPdfPageLayoutMetrics,
    lastVisiblePage: number,
) {
    if (!Number.isFinite(lastVisiblePage) || lastVisiblePage < 1) {
        return 0;
    }

    const pageIndex = Math.min(layout.totalPages, Math.floor(lastVisiblePage)) - 1;
    const rowIndex = layout.pageRowIndices[pageIndex] ?? -1;
    if (!Number.isFinite(rowIndex) || rowIndex < 0) {
        return 0;
    }

    const hiddenRows = Math.max(0, layout.rowHeights.length - rowIndex - 1);
    return (
        (layout.rowHeightPrefixSums[layout.rowHeightPrefixSums.length - 1] ?? 0)
        - (layout.rowHeightPrefixSums[rowIndex] ?? 0)
    )
        + Math.max(0, hiddenRows - 1) * layout.gap;
}

export function getPageRowBounds(
    layout: IPdfPageLayoutMetrics,
    pageNumber: number,
): {
    start: number;
    end: number;
} | null {
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return null;
    }

    const pageIndex = Math.min(layout.totalPages, Math.floor(pageNumber)) - 1;
    const rowIndex = layout.pageRowIndices[pageIndex] ?? -1;
    if (!Number.isFinite(rowIndex) || rowIndex < 0) {
        return null;
    }

    const fallbackPage = Math.max(1, pageIndex + 1);
    return {
        start: layout.rowStartPages[rowIndex] ?? fallbackPage,
        end: layout.rowEndPages[rowIndex] ?? fallbackPage,
    };
}
