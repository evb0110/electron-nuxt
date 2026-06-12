import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browserLogger';
import { writeBookmarkOutlines } from '@app/modules/pdf-viewer/engine/pdf-bookmark-outline-writer/writeBookmarkOutlines';
import { normalizeBookmarkEntries } from '@app/modules/pdf-viewer/engine/pdf-bookmark-serialization/normalizeBookmarkEntries';

const BOOKMARK_SERIALIZATION_LOG_SECTION = 'pdfBookmarks';

export async function rewriteBookmarks(
    data: Uint8Array,
    deps: {
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        totalPages: Ref<number>;
        untitledLabel: string;
    },
) {
    if (!deps.bookmarksDirty.value) {
        return data;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(
        deps.bookmarkItems.value,
        deps.totalPages.value,
        deps.untitledLabel,
    );

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (error) {
        BrowserLogger.warn(BOOKMARK_SERIALIZATION_LOG_SECTION, 'Failed to load PDF for bookmark rewrite', error);
        return data;
    }

    const outlinesName = PDFName.of('Outlines');
    if (normalizedBookmarks.length === 0) {
        doc.catalog.delete(outlinesName);
        return new Uint8Array(await doc.save());
    }

    writeBookmarkOutlines(doc, normalizedBookmarks);
    return new Uint8Array(await doc.save());
}
