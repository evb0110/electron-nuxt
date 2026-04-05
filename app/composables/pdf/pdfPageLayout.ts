import type {
    IPdfPageMetric,
    TPdfViewMode,
} from '@app/types/pdf';

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

function getSpreadRowPages(
    pageNumber: number,
    viewMode: TPdfViewMode,
    totalPages: number,
) {
    if (viewMode === 'single' || totalPages <= 1) {
        return [pageNumber];
    }

    if (viewMode === 'facing-first-single' && pageNumber === 1) {
        return [pageNumber];
    }

    if (
        pageNumber === totalPages
        && (
            (viewMode === 'facing' && totalPages % 2 === 1)
            || (viewMode === 'facing-first-single' && totalPages % 2 === 0)
        )
    ) {
        return [pageNumber];
    }

    return [
        pageNumber,
        Math.min(pageNumber + 1, totalPages),
    ];
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

    return Array.from({ length: totalPages }, (_, index) => {
        const metric = pageMetrics[index];
        const width = metric?.width;
        const height = metric?.height;
        return {
            width: isFinitePositive(width) ? width : safeFallbackWidth,
            height: isFinitePositive(height) ? height : safeFallbackHeight,
        };
    });
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
        const rowWidth = rowPages.reduce((sum, rowPage) => {
            const pageWidth = pageMetrics[rowPage - 1]?.width;
            return sum + (isFinitePositive(pageWidth) ? pageWidth : 0);
        }, 0);
        maxWidth = Math.max(maxWidth, rowWidth);
        pageNumber = rowPages[rowPages.length - 1] ?? pageNumber;
        pageNumber += 1;
    }

    return maxWidth > 0 ? maxWidth : null;
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

    const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
    const safePaddingTop = Number.isFinite(paddingTop) ? Math.max(0, paddingTop) : 0;
    const safePaddingBottom = typeof paddingBottom === 'number' && Number.isFinite(paddingBottom)
        ? Math.max(0, paddingBottom)
        : safePaddingTop;
    const pageWidths = metrics.map(metric => metric.width * scale);
    const pageHeights = metrics.map(metric => metric.height * scale);
    const pageHeightPrefixSums: number[] = Array.from({ length: totalPages }, () => 0);
    const pageTops: number[] = [];
    const pageRowIndices: number[] = Array.from({ length: totalPages }, () => 0);
    const rowStartPages: number[] = [];
    const rowEndPages: number[] = [];
    const rowHeights: number[] = [];
    const rowHeightPrefixSums: number[] = [];
    let maxPageHeight = 0;

    for (let index = 0; index < pageHeights.length; index += 1) {
        const height = pageHeights[index] ?? 0;
        pageHeightPrefixSums[index] = height + (pageHeightPrefixSums[index - 1] ?? 0);
        maxPageHeight = Math.max(maxPageHeight, height);
    }

    let offset = safePaddingTop;
    let rowIndex = 0;
    for (let pageNumber = 1; pageNumber <= totalPages;) {
        const rowStartPage = pageNumber;
        const rowPages = getSpreadRowPages(pageNumber, viewMode, totalPages);
        let rowHeight = 0;
        for (const rowPage of rowPages) {
            rowHeight = Math.max(rowHeight, pageHeights[rowPage - 1] ?? 0);
        }

        rowStartPages.push(rowStartPage);
        rowEndPages.push(rowPages[rowPages.length - 1] ?? rowStartPage);
        rowHeights.push(rowHeight);
        rowHeightPrefixSums.push(
            rowHeight + (rowHeightPrefixSums[rowHeightPrefixSums.length - 1] ?? 0),
        );

        for (const rowPage of rowPages) {
            pageTops[rowPage - 1] = offset;
            pageRowIndices[rowPage - 1] = rowIndex;
        }

        pageNumber = rowPages[rowPages.length - 1] ?? rowStartPage;
        pageNumber += 1;
        offset += rowHeight;
        if (pageNumber <= totalPages) {
            offset += safeGap;
        }
        rowIndex += 1;
    }

    offset += safePaddingBottom;

    return {
        totalPages,
        gap: safeGap,
        paddingTop: safePaddingTop,
        paddingBottom: safePaddingBottom,
        maxPageHeight,
        pageWidths,
        pageHeights,
        pageHeightPrefixSums,
        pageTops,
        pageRowIndices,
        rowStartPages,
        rowEndPages,
        rowHeights,
        rowHeightPrefixSums,
        contentHeight: offset,
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
    const clampedHiddenPages = Math.max(0, Math.min(hiddenPages, layout.totalPages));
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
    const clampedHiddenPages = Math.max(0, Math.min(hiddenPages, layout.totalPages));
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
