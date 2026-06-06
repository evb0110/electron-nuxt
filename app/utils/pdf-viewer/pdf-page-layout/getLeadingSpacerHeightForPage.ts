import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutMetrics';

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
