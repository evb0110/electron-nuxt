import type { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { normalizeBookmarkEntries } from '@app/utils/pdf-viewer/pdf-bookmark-serialization/normalizeBookmarkEntries';
import { writeBookmarkOutlines } from '@app/utils/pdf-viewer/pdf-bookmark-outline-writer/writeBookmarkOutlines';

export function applyBookmarks(
    doc: PDFDocument,
    bookmarksDirty: boolean,
    bookmarkItems: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
) {
    if (!bookmarksDirty) {
        return false;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(bookmarkItems, totalPages, untitledLabel);
    return writeBookmarkOutlines(doc, normalizedBookmarks);
}
