import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyCombinedPdfPageLabels,
    inspectPdfCombineCatalog,
    offsetPdfCombineBookmarks,
    PDF_COMBINE_CATALOG_POLICY,
    writePdfBookmarkOutlines,
} from '@pdf-core';

describe('PDF combine catalog policy', () => {
    it('preserves and offsets page-label ranges and outline destinations', async () => {
        const source = await PDFDocument.create();
        source.addPage();
        source.addPage();
        applyCombinedPdfPageLabels(source, [{
            pageIndex: 0,
            style: 'r',
            prefix: 'A-',
            start: 3,
        }]);
        writePdfBookmarkOutlines(source, [{
            title: 'Chapter',
            pageIndex: 1,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);

        const reloaded = await PDFDocument.load(await source.save());
        const metadata = inspectPdfCombineCatalog(reloaded);
        expect(metadata.pageLabels).toEqual([{
            pageIndex: 0,
            style: 'r',
            prefix: 'A-',
            start: 3,
        }]);
        expect(offsetPdfCombineBookmarks(metadata.bookmarks, 4)[0]).toMatchObject({
            title: 'Chapter',
            pageIndex: 5,
            namedDest: null,
        });
    });

    it.each([
        [
            'forms',
            'AcroForm',
        ],
        [
            'associated attachments',
            'AF',
        ],
    ])('rejects source %s instead of silently dropping them', async (_label, key) => {
        const source = await PDFDocument.create();
        source.addPage();
        source.catalog.set(PDFName.of(key), source.context.obj({}));
        expect(() => inspectPdfCombineCatalog(source)).toThrow(/does not support source/u);
    });

    it('declares every document-catalog semantic used by the planner', () => {
        expect(PDF_COMBINE_CATALOG_POLICY).toEqual(expect.objectContaining({
            pages: 'preserve',
            outlines: 'preserve-and-remap-destinations',
            pageLabels: 'preserve-and-offset-number-tree',
            forms: 'reject',
            attachments: 'reject',
            javascript: 'reject',
        }));
    });
});
