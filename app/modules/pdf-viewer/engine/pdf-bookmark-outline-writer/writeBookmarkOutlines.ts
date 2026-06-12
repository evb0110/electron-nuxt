import type { PDFDocument } from 'pdf-lib';
import { PDFName } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { writePdfBookmarkOutlines } from '@pdf-core';

export function writeBookmarkOutlines(
    doc: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    const outlinesName = PDFName.of('Outlines');
    if (bookmarks.length === 0) {
        const hadOutlines = doc.catalog.has(outlinesName);
        doc.catalog.delete(outlinesName);
        return hadOutlines;
    }

    return writePdfBookmarkOutlines(doc, bookmarks);
}
