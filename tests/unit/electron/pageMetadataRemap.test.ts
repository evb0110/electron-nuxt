import {
    describe,
    expect,
    it,
} from 'vitest';
import {remapPageMetadata} from '@electron/features/page-ops/main/pageMetadataRemap';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

const bookmark = (title: string, pageIndex: number | null, items: IPdfBookmarkEntry[] = []): IPdfBookmarkEntry => ({
    title,
    pageIndex,
    namedDest: pageIndex === null ? 'named' : null,
    bold: false,
    italic: false,
    color: null,
    items,
});

describe('page metadata remap', () => {
    it('remaps exact labels and bookmark destinations through reorder/delete/insert', () => {
        const result = remapPageMetadata({
            pageLabels: [
                'i',
                'ii',
                '1',
                '2',
            ],
            bookmarks: [
                bookmark('deleted parent', 1, [bookmark('surviving child', 3)]),
                bookmark('first', 0),
                bookmark('named', null),
            ],
            untitledBookmarkLabel: 'Untitled',
        }, {
            previousPageCount: 4,
            pages: [
                {fromPageNumber: 4},
                {insertedId: 'inserted'},
                {fromPageNumber: 1},
                {fromPageNumber: 3},
            ],
        });

        expect(result.pageLabels.ranges.map(range => range.prefix)).toEqual([
            '2',
            '2',
            'i',
            '1',
        ]);
        expect(result.bookmarks.items).toEqual([
            expect.objectContaining({
                title: 'surviving child',
                pageIndex: 0,
            }),
            expect.objectContaining({
                title: 'first',
                pageIndex: 2,
            }),
            expect.objectContaining({
                title: 'named',
                pageIndex: null,
                namedDest: 'named',
            }),
        ]);
    });
});
