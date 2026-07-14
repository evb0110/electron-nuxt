/**
 * @deprecated Import neutral page-label helpers from
 * `@app/utils/document-viewer/pageLabels` in shared code.
 */
export {
    buildPageLabelsFromRanges,
    buildWholeDocumentPageLabelRanges,
    derivePageLabelRangesFromLabels,
    findPageByPageLabelInput,
    formatPageIndicatorWithOptions,
    formatPageRange,
    getMaxPageIndicatorLength,
    getPageIndicatorLayoutMetrics,
    getVisiblePageLabel,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
    parsePageRangeInput,
} from '@app/utils/document-viewer/pageLabels';
export type {
    IDocumentPageLabelRange as IPdfPageLabelRange,
    IDocumentPageRange as IPdfPageRange,
    IPageIndicatorFormatOptions,
    TDocumentPageLabelStyle as TPageLabelStyle,
} from '@app/utils/document-viewer/pageLabels';
