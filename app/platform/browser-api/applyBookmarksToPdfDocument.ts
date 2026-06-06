import type { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';

export function applyBookmarksToPdfDocument(
    document: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    if (bookmarks.length === 0) {
        return;
    }

    writePdfBookmarkOutlines(document, bookmarks);
}
