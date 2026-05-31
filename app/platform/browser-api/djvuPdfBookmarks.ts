import type { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import { writePdfBookmarkOutlines } from '@pdf-core/pdfBookmarks';

export function applyBookmarksToPdfDocument(
    document: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    if (bookmarks.length === 0) {
        return;
    }

    writePdfBookmarkOutlines(document, bookmarks);
}
