import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

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
