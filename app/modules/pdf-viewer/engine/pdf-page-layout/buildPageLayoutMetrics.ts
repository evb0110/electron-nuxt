import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import { clamp } from 'es-toolkit/math';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import type {
    IPdfPageLayoutBase,
    IPdfPageLayoutMetrics,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

const baseCache = new WeakMap<IPdfPageMetric[], Map<string, IPdfPageLayoutBase>>();

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

function buildPrefixSums(values: readonly number[]) {
    const prefixSums = Array.from({ length: values.length }, () => 0);
    for (let index = 0; index < values.length; index += 1) {
        prefixSums[index] = (values[index] ?? 0) + (prefixSums[index - 1] ?? 0);
    }
    return prefixSums;
}

function buildPageLayoutBase(options: {
    pageMetrics: IPdfPageMetric[];
    pageMetricsVersion: number;
    totalPages: number;
    viewMode: TPdfViewMode;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}) {
    const cacheKey = [
        options.pageMetricsVersion,
        options.totalPages,
        options.viewMode,
        options.fallbackWidth ?? 'null',
        options.fallbackHeight ?? 'null',
    ].join(':');
    const cached = baseCache.get(options.pageMetrics)?.get(cacheKey);
    if (cached) {
        return cached;
    }

    const metrics = normalizePageMetrics({
        pageMetrics: options.pageMetrics,
        totalPages: options.totalPages,
        fallbackWidth: options.fallbackWidth,
        fallbackHeight: options.fallbackHeight,
    });
    if (metrics.length === 0) {
        return null;
    }

    const pageWidths = metrics.map(metric => metric.width);
    const pageHeights = metrics.map(metric => metric.height);
    const pageRowIndices = Array.from({ length: options.totalPages }, () => 0);
    const rowStartPages: number[] = [];
    const rowEndPages: number[] = [];
    const rowHeights: number[] = [];
    let rowIndex = 0;

    for (let pageNumber = 1; pageNumber <= options.totalPages;) {
        const rowPages = getSpreadRowPages(pageNumber, options.viewMode, options.totalPages);
        const rowEndPage = rowPages[rowPages.length - 1] ?? pageNumber;
        rowStartPages.push(pageNumber);
        rowEndPages.push(rowEndPage);
        rowHeights.push(Math.max(...rowPages.map(rowPage => pageHeights[rowPage - 1] ?? 0)));
        for (const rowPage of rowPages) {
            pageRowIndices[rowPage - 1] = rowIndex;
        }
        pageNumber = rowEndPage + 1;
        rowIndex += 1;
    }

    const base = Object.freeze({
        totalPages: options.totalPages,
        maxPageHeight: pageHeights.reduce(
            (maxHeight, pageHeight) => pageHeight > maxHeight ? pageHeight : maxHeight,
            0,
        ),
        pageWidths: Object.freeze(pageWidths),
        pageHeights: Object.freeze(pageHeights),
        pageHeightPrefixSums: Object.freeze(buildPrefixSums(pageHeights)),
        pageRowIndices: Object.freeze(pageRowIndices),
        rowStartPages: Object.freeze(rowStartPages),
        rowEndPages: Object.freeze(rowEndPages),
        rowHeights: Object.freeze(rowHeights),
        rowHeightPrefixSums: Object.freeze(buildPrefixSums(rowHeights)),
    }) satisfies IPdfPageLayoutBase;
    const metricsCache = baseCache.get(options.pageMetrics) ?? new Map<string, IPdfPageLayoutBase>();
    metricsCache.set(cacheKey, base);
    baseCache.set(options.pageMetrics, metricsCache);
    return base;
}

export function buildPageLayoutMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    pageMetricsVersion?: number;
    totalPages: number;
    viewMode: TPdfViewMode;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}): IPdfPageLayoutMetrics | null {
    if (options.totalPages <= 0 || !Number.isFinite(options.scale) || options.scale <= 0) {
        return null;
    }

    const base = buildPageLayoutBase({
        pageMetrics: options.pageMetrics,
        pageMetricsVersion: options.pageMetricsVersion ?? 0,
        totalPages: options.totalPages,
        viewMode: options.viewMode,
        fallbackWidth: options.fallbackWidth,
        fallbackHeight: options.fallbackHeight,
    });
    if (!base) {
        return null;
    }

    const {
        gap,
        paddingTop,
        paddingBottom,
    } = resolveSafeLayoutSpacing({
        gap: options.gap,
        paddingTop: options.paddingTop,
        ...(options.paddingBottom !== undefined ? { paddingBottom: options.paddingBottom } : {}),
    });
    return {
        base,
        scale: options.scale,
        gap,
        paddingTop,
        paddingBottom,
    };
}
