/**
 * @deprecated Import neutral page-label helpers from
 * `@app/utils/document-viewer/pageLabels` in shared code.
 */
export {
    PAGE_LABEL_MAX_WINDOW_PAGES,
    PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES,
    applyPageLabelRange,
    applySparsePageLabelUpdates,
    buildPageLabelSegments,
    buildPageLabelsFromRanges,
    buildWholeDocumentPageLabelRanges,
    countPageLabelDifferences,
    createPageLabelModel,
    derivePageLabelRangesFromLabels,
    findPageByPageLabelInput,
    formatPageIndicatorWithOptions,
    formatPageRange,
    getPageLabelAt,
    getPageLabelWindow,
    getMaxPageIndicatorLength,
    getPageIndicatorLayoutMetrics,
    getVisiblePageLabel,
    isImplicitDefaultPageLabels,
    materializePageLabelsForCompatibility,
    normalizePageLabelRanges,
    parsePageRangeInput,
    replacePageLabelRange,
    readPageLabelWindow,
    setPageLabelAt,
} from '@app/utils/document-viewer/pageLabels';
export type {
    IDocumentPageLabelRange as IPdfPageLabelRange,
    IDocumentPageLabelModel,
    IDocumentPageLabelSegment,
    IDocumentPageLabelUpdate,
    IDocumentPageLabelWindow,
    IDocumentPageRange as IPdfPageRange,
    IPageIndicatorFormatOptions,
    TDocumentPageLabelLookup,
    TDocumentPageLabelStyle as TPageLabelStyle,
} from '@app/utils/document-viewer/pageLabels';
