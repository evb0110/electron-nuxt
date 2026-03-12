import type {
    IPdfPageMetric,
    TPdfViewMode,
} from '@app/types/pdf';
import { isStandaloneSpreadPage } from '@app/utils/pdf-view-mode';

export interface IPdfPageLayoutMetrics {
    totalPages: number;
    gap: number;
    paddingTop: number;
    paddingBottom: number;
    pageWidths: number[];
    pageHeights: number[];
    pageTops: number[];
}

function isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
        if (isStandaloneSpreadPage(pageNumber, viewMode, totalPages)) {
            const singleWidth = pageMetrics[pageNumber - 1]?.width;
            if (isFinitePositive(singleWidth)) {
                maxWidth = Math.max(maxWidth, singleWidth);
            }
            pageNumber += 1;
            continue;
        }

        const leftWidth = pageMetrics[pageNumber - 1]?.width;
        const rightWidth = pageMetrics[pageNumber]?.width;
        const spreadWidth = (isFinitePositive(leftWidth) ? leftWidth : 0)
            + (isFinitePositive(rightWidth) ? rightWidth : 0);
        maxWidth = Math.max(maxWidth, spreadWidth);
        pageNumber += 2;
    }

    return maxWidth > 0 ? maxWidth : null;
}

export function buildPageLayoutMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}): IPdfPageLayoutMetrics | null {
    const {
        totalPages,
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
    const pageTops: number[] = [];

    let offset = safePaddingTop;
    for (const pageHeight of pageHeights) {
        pageTops.push(offset);
        offset += pageHeight + safeGap;
    }

    if (pageHeights.length > 0) {
        offset -= safeGap;
    }
    offset += safePaddingBottom;

    return {
        totalPages,
        gap: safeGap,
        paddingTop: safePaddingTop,
        paddingBottom: safePaddingBottom,
        pageWidths,
        pageHeights,
        pageTops,
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

    return layout.pageHeights
        .slice(0, clampedHiddenPages)
        .reduce((sum, height) => sum + height, 0)
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}

export function getTrailingSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    hiddenPages: number,
) {
    const clampedHiddenPages = Math.max(0, Math.min(hiddenPages, layout.totalPages));
    if (clampedHiddenPages === 0) {
        return 0;
    }

    return layout.pageHeights
        .slice(layout.totalPages - clampedHiddenPages)
        .reduce((sum, height) => sum + height, 0)
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}
