import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { normalizeBookmarkEntries } from '@app/modules/pdf-viewer/engine/pdf-bookmark-serialization/normalizeBookmarkEntries';
import { rewriteBookmarks } from '@app/modules/pdf-viewer/engine/pdf-bookmark-serialization/rewriteBookmarks';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type {TPageIndex} from '@contracts/pageNumbers';
import {requirePageIndex} from '@contracts/pageNumbers';
import {cast} from '@tests/helpers/cast';

function createBookmark(overrides: Partial<IPdfBookmarkEntry> = {}): IPdfBookmarkEntry {
    return {
        title: 'Bookmark',
        pageIndex: requirePageIndex(0),
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
}

describe('normalizeBookmarkEntries', () => {
    it('normalizes titles, page bounds, colors, and nested items', () => {
        const entries = normalizeBookmarkEntries([createBookmark({
            title: '   ',
            pageIndex: requirePageIndex(99),
            namedDest: '   ',
            bold: true,
            color: '#abc',
            items: [createBookmark({
                title: ' Child ',
                pageIndex: cast<TPageIndex>(-3),
                namedDest: 'DestA',
                italic: true,
                color: '#xyz123',
            })],
        })], 5, 'Untitled');

        expect(entries).toEqual([{
            title: 'Untitled',
            pageIndex: 4,
            pageYRatio: null,
            namedDest: null,
            bold: true,
            italic: false,
            color: '#aabbcc',
            items: [{
                title: 'Child',
                pageIndex: 0,
                pageYRatio: null,
                namedDest: 'DestA',
                bold: false,
                italic: true,
                color: null,
                items: [],
            }],
        }]);
    });

    it('returns empty array when no pages exist', () => {
        const entries = normalizeBookmarkEntries([createBookmark()], 0, 'Untitled');
        expect(entries).toEqual([]);
    });
});

describe('rewriteBookmarks', () => {
    it('returns input data on invalid PDF payload', async () => {
        const source = Uint8Array.from([
            1,
            2,
            3,
            4,
        ]);

        const result = await rewriteBookmarks(source, {
            bookmarksDirty: ref(true),
            bookmarkItems: ref([createBookmark()]),
            totalPages: ref(1),
            untitledLabel: 'Untitled',
        });

        expect(result).toBe(source);
    });
});
