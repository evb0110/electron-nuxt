import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';

function createBookmark(title: string, pageIndex: number): IPdfBookmarkEntry {
    return {
        title,
        pageIndex,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

describe('writePdfBookmarkOutlines', () => {
    it('writes a nested outlines tree', async () => {
        const document = await PDFDocument.create();
        document.addPage();
        document.addPage();

        const result = writePdfBookmarkOutlines(document, [{
            ...createBookmark('Chapter 1', 0),
            items: [createBookmark('Section 1.1', 1)],
        }]);

        expect(result).toBe(true);
        expect(document.catalog.get(PDFName.of('Outlines'))).toBeTruthy();

        const serialized = await document.save();
        const reloadedDocument = await PDFDocument.load(serialized, { updateMetadata: false });
        expect(reloadedDocument.catalog.get(PDFName.of('Outlines'))).toBeTruthy();
    });

    it('removes stale outlines when the bookmark list is empty', async () => {
        const document = await PDFDocument.create();
        document.addPage();

        writePdfBookmarkOutlines(document, [createBookmark('Chapter 1', 0)]);
        expect(document.catalog.get(PDFName.of('Outlines'))).toBeTruthy();

        const result = writePdfBookmarkOutlines(document, []);

        expect(result).toBe(false);
        expect(document.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
    });

    it('keeps bookmark entries with invalid page indexes without throwing', async () => {
        const document = await PDFDocument.create();
        document.addPage();

        const result = writePdfBookmarkOutlines(document, [{
            ...createBookmark('Out of range', 99),
            items: [createBookmark('Negative', -1)],
        }]);

        expect(result).toBe(true);
        expect(document.catalog.get(PDFName.of('Outlines'))).toBeTruthy();
    });
});
