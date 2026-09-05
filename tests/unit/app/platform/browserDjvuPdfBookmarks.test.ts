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
import {requirePageIndex} from '@contracts/pageNumbers';
import { applyBookmarksToPdfDocument } from '@app/platform/browser-api/applyBookmarksToPdfDocument';

function createBookmark(title: string, pageIndex: number): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: requirePageIndex(pageIndex),
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

describe('applyBookmarksToPdfDocument', () => {
    it('adds an outlines tree before the first save', async () => {
        const document = await PDFDocument.create();
        document.addPage();
        document.addPage();

        applyBookmarksToPdfDocument(document, [{
            ...createBookmark('Chapter 1', requirePageIndex(0)),
            items: [createBookmark('Section 1.1', requirePageIndex(1))],
        }]);

        expect(document.catalog.get(PDFName.of('Outlines'))).toBeTruthy();

        const serialized = await document.save();
        const reloadedDocument = await PDFDocument.load(serialized, { updateMetadata: false });
        expect(reloadedDocument.catalog.get(PDFName.of('Outlines'))).toBeTruthy();
    });
});
