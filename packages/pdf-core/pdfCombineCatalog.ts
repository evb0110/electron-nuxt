import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export const PDF_COMBINE_CATALOG_POLICY = Object.freeze({
    pages: 'preserve',
    outlines: 'preserve-and-remap-destinations',
    pageLabels: 'preserve-and-offset-number-tree',
    forms: 'reject',
    attachments: 'reject',
    javascript: 'reject',
    documentMetadata: 'source-specific-metadata-is-not-promoted-to-output-catalog',
    viewerPreferences: 'source-specific-preferences-are-not-promoted-to-output-catalog',
} as const);

export interface IPdfCombinePageLabelRange {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

export function offsetPdfCombineBookmarks(
    bookmarks: readonly IPdfBookmarkEntry[],
    pageOffset: number,
): IPdfBookmarkEntry[] {
    return bookmarks.map(bookmark => ({
        ...bookmark,
        pageIndex: bookmark.pageIndex === null ? null : bookmark.pageIndex + pageOffset,
        namedDest: null,
        items: offsetPdfCombineBookmarks(bookmark.items, pageOffset),
    }));
}
