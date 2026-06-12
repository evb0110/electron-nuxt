import type { TPdfViewMode } from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';

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

export function getPageRowBoundsForViewMode(options: {
    pageNumber: number;
    viewMode: TPdfViewMode;
    totalPages: number;
}) {
    return resolveSpreadRowBounds(options.pageNumber, options.viewMode, options.totalPages);
}
