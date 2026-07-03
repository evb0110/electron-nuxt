import {isFinitePositive} from '@contracts/runtimeGuards';
import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import {
    clamp,
    sumBy,
} from 'es-toolkit/math';


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

export function resolveCurrentSpreadBaseWidth(
    pageMetrics: IPdfPageMetric[],
    viewMode: TPdfViewMode,
    totalPages: number,
    currentPage: number,
) {
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
