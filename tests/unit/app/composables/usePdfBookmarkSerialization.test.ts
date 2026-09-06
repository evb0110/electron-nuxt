import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { normalizeBookmarkEntries } from '@app/modules/pdf-viewer/engine/pdf-bookmark-serialization/normalizeBookmarkEntries';
import { rewriteBookmarks } from '@app/modules/pdf-viewer/engine/pdf-bookmark-serialization/rewriteBookmarks';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import {requirePageIndex} from '@contracts/pageNumbers';
import {isRecord} from '@contracts/runtimeGuards';

interface IBookmarkFixtureOverrides extends Omit<Partial<IPdfBookmarkEntry>, 'items' | 'pageIndex'> {
    items?: readonly IPdfBookmarkEntry[];
    pageIndex?: number | null;
}

function isBookmarkEntryFixture(value: unknown): value is IPdfBookmarkEntry {
    return isRecord(value)
        && typeof value.title === 'string'
        && (value.pageIndex === null || typeof value.pageIndex === 'number')
        && (value.pageYRatio === undefined || value.pageYRatio === null || typeof value.pageYRatio === 'number')
        && (value.namedDest === null || typeof value.namedDest === 'string')
        && typeof value.bold === 'boolean'
        && typeof value.italic === 'boolean'
        && (value.color === null || typeof value.color === 'string')
        && Array.isArray(value.items)
        && value.items.every(item => isBookmarkEntryFixture(item));
}

function createBookmark(overrides: IBookmarkFixtureOverrides = {}): IPdfBookmarkEntry {
    const fixture = {
        title: 'Bookmark',
        pageIndex: requirePageIndex(0),
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
    // Page-index branding disappears at runtime. The guard keeps this fixture
    // able to exercise malformed numeric data without an unchecked cast.
    if (!isBookmarkEntryFixture(fixture)) {
        throw new TypeError('Invalid PDF bookmark fixture');
    }
    return fixture;
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
                pageIndex: -3,
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
