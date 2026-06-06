

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
