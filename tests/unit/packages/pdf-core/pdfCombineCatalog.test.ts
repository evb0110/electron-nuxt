import {
    PDFDocument,
    PDFName,
    PDFString,
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

    it('stops when inline outline dictionaries form a cycle', async () => {
        const source = await PDFDocument.create();
        source.addPage();
        const item = source.context.obj({Title: PDFString.of('Loop')});
        item.set(PDFName.of('Next'), item);
        source.catalog.set(PDFName.of('Outlines'), source.context.obj({First: item}));

        expect(inspectPdfCombineCatalog(source).bookmarks).toEqual([expect.objectContaining({
            title: 'Loop',
            items: [],
        })]);
    });

    it('stops when page-label number-tree kids form a cycle', async () => {
        const source = await PDFDocument.create();
        source.addPage();
        const labels = source.context.obj({});
        labels.set(PDFName.of('Kids'), source.context.obj([labels]));
        source.catalog.set(PDFName.of('PageLabels'), labels);

        expect(inspectPdfCombineCatalog(source).pageLabels).toEqual([]);
    });

    it('stops when named-destination tree kids form a cycle', async () => {
        const source = await PDFDocument.create();
        source.addPage();
        const destinations = source.context.obj({});
        destinations.set(PDFName.of('Kids'), source.context.obj([destinations]));
        source.catalog.set(PDFName.of('Names'), source.context.obj({Dests: destinations}));
        const item = source.context.obj({
            Dest: PDFString.of('Missing'),
            Title: PDFString.of('Named destination'),
        });
        source.catalog.set(PDFName.of('Outlines'), source.context.obj({First: item}));

        expect(inspectPdfCombineCatalog(source).bookmarks).toEqual([expect.objectContaining({
            pageIndex: null,
            title: 'Named destination',
        })]);
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
