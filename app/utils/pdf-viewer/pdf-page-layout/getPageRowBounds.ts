import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutMetrics';

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
