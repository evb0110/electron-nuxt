import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';
import { normalizeBookmarkColor } from '@app/utils/pdf-outline-helpers';
import { writeBookmarkOutlines } from '@app/composables/pdf/pdfBookmarkOutlineWriter';

const BOOKMARK_SERIALIZATION_LOG_SECTION = 'pdf-bookmarks';

export function normalizeBookmarkEntries(
    entries: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
): IPdfBookmarkEntry[] {
    if (totalPages <= 0) {
        return [];
    }

    const maxPageIndex = totalPages - 1;

    function normalizeItem(item: IPdfBookmarkEntry): IPdfBookmarkEntry {
        const title = item.title.trim();
        const pageIndex = typeof item.pageIndex === 'number'
            ? Math.max(0, Math.min(maxPageIndex, Math.trunc(item.pageIndex)))
            : null;
        const namedDest = typeof item.namedDest === 'string' && item.namedDest.trim().length > 0
            ? item.namedDest
            : null;
        const bold = item.bold === true;
        const italic = item.italic === true;
        const color = normalizeBookmarkColor(item.color);

        return {
            title: title.length > 0 ? title : untitledLabel,
            pageIndex,
            namedDest,
            bold,
            italic,
            color,
            items: item.items.map(normalizeItem),
        };
    }

    return entries.map(normalizeItem);
}

export async function rewriteBookmarks(
    data: Uint8Array,
    deps: {
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        totalPages: Ref<number>;
        untitledLabel: string;
    },
): Promise<Uint8Array> {
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
