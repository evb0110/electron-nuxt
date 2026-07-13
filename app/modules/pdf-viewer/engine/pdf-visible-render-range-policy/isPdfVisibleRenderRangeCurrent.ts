import type {TPdfViewMode} from '@contracts/shared';
import type {IPageRange} from '@app/types/pdfUi';
import {getPageRowBoundsForViewMode} from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';

function isFinitePageRange(range: IPageRange) {
    return Number.isFinite(range.start)
        && Number.isFinite(range.end)
        && range.start <= range.end;
}

function pageRangeContainsPage(range: IPageRange, pageNumber: number) {
    return isFinitePageRange(range)
        && pageNumber >= range.start
        && pageNumber <= range.end;
}

function pageRangesIntersect(left: IPageRange, right: IPageRange) {
    return isFinitePageRange(left)
        && isFinitePageRange(right)
        && left.start <= right.end
        && right.start <= left.end;
}

interface IIsPdfVisibleRenderRangeCurrentOptions {
    range: IPageRange;
    visibleRange: IPageRange;
    navigationTargetPage: number | null;
    viewMode: TPdfViewMode;
    totalPages: number;
}

interface IResolvePdfProtectedVisibleRangeOptions {
    visibleRange: IPageRange;
    navigationTargetPage: number | null;
    viewMode: TPdfViewMode;
    totalPages: number;
}

export function resolvePdfProtectedVisibleRange(
    options: IResolvePdfProtectedVisibleRangeOptions,
) {
    if (options.navigationTargetPage !== null && options.totalPages > 0) {
        return getPageRowBoundsForViewMode({
            pageNumber: options.navigationTargetPage,
            viewMode: options.viewMode,
            totalPages: options.totalPages,
        });
    }
    return options.visibleRange;
}

export function isPdfVisibleRenderRangeCurrent(
    options: IIsPdfVisibleRenderRangeCurrentOptions,
) {
    if (options.navigationTargetPage !== null && options.totalPages > 0) {
        const targetRowBounds = resolvePdfProtectedVisibleRange(options);
        return pageRangesIntersect(options.range, targetRowBounds)
            || pageRangeContainsPage(options.range, options.navigationTargetPage);
    }

    return pageRangesIntersect(options.range, options.visibleRange);
}
