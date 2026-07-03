import {
    createDocumentSinglePageRange,
    doDocumentPageRangesIntersect,
    normalizeDocumentPageRange,
    type IDocumentPageRange,
} from '@app/utils/document-viewer/documentPageRange';

export function normalizeDocumentViewportRange<TRange extends IDocumentPageRange>(
    range: TRange,
    totalPages: number,
): IDocumentPageRange {
    return normalizeDocumentPageRange(range, totalPages);
}

export function createDocumentViewportSinglePageRange(
    pageNumber: number,
    totalPages: number,
): IDocumentPageRange {
    return createDocumentSinglePageRange(pageNumber, totalPages);
}

export function doDocumentViewportRangesIntersect(
    left: IDocumentPageRange,
    right: IDocumentPageRange,
) {
    return doDocumentPageRangesIntersect(left, right);
}
