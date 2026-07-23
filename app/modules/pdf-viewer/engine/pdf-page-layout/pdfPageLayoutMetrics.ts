export interface IPdfPageLayoutBase {
    totalPages: number;
    maxPageHeight: number;
    pageWidths: readonly number[];
    pageHeights: readonly number[];
    pageHeightPrefixSums: readonly number[];
    pageRowIndices: readonly number[];
    rowStartPages: readonly number[];
    rowEndPages: readonly number[];
    rowHeights: readonly number[];
    rowHeightPrefixSums: readonly number[];
}

export interface IPdfPageLayoutMetrics {
    base: IPdfPageLayoutBase;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom: number;
}

export function getLayoutPageWidth(layout: IPdfPageLayoutMetrics, pageIndex: number) {
    return (layout.base.pageWidths[pageIndex] ?? 0) * layout.scale;
}

export function getLayoutPageHeight(layout: IPdfPageLayoutMetrics, pageIndex: number) {
    return (layout.base.pageHeights[pageIndex] ?? 0) * layout.scale;
}

export function getLayoutRowHeight(layout: IPdfPageLayoutMetrics, rowIndex: number) {
    return (layout.base.rowHeights[rowIndex] ?? 0) * layout.scale;
}

export function getLayoutRowTop(layout: IPdfPageLayoutMetrics, rowIndex: number) {
    return layout.paddingTop
        + (layout.base.rowHeightPrefixSums[rowIndex - 1] ?? 0) * layout.scale
        + rowIndex * layout.gap;
}

export function getLayoutPageTop(layout: IPdfPageLayoutMetrics, pageIndex: number) {
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    return rowIndex < 0 ? null : getLayoutRowTop(layout, rowIndex);
}

export function getLayoutContentHeight(layout: IPdfPageLayoutMetrics) {
    const rowCount = layout.base.rowHeights.length;
    return layout.paddingTop
        + layout.paddingBottom
        + (layout.base.rowHeightPrefixSums[rowCount - 1] ?? 0) * layout.scale
        + Math.max(0, rowCount - 1) * layout.gap;
}
