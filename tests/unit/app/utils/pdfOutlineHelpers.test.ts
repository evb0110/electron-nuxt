import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import {
    buildOutlineFromBookmarkEntries,
    buildResolvedOutline,
    convertOutlineColorToHex,
    normalizeBookmarkColor,
    parseOutlineItems,
    resolveActiveBookmarkForPage,
    resolveBookmarkDestinationPage,
    resolveBookmarkDestinationTarget,
    resolveImmediateBookmarkDestinationTarget,
    resolvePageIndex,
    shouldEmitResolvedBookmarkDestinationTarget,
} from '@app/utils/pdfOutlineHelpers';
import { cast } from '@tests/helpers/cast';

type TOutlinePdfDocumentStub = Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex' | 'getPage'>;
type TPdfPageView = [number, number, number, number];

function createPdfPageStub(view: TPdfPageView = [
    0,
    0,
    612,
    792,
]): PDFPageProxy {
    return cast<PDFPageProxy>({
        view,
        getViewport: vi.fn(() => ({ height: view[3] - view[1] })),
    });
}

function createPdfDocumentStub(overrides: Partial<TOutlinePdfDocumentStub> = {}): PDFDocumentProxy {
    const base: TOutlinePdfDocumentStub = {
        numPages: 10,
        getDestination: vi.fn(async (_name: string) => null),
        getPageIndex: vi.fn(async (_ref: unknown) => 0),
        getPage: vi.fn(async (_pageNumber: number): Promise<PDFPageProxy> => createPdfPageStub()),
    };
    return {
        ...base,
        ...overrides,
    } as PDFDocumentProxy;
}

function createBookmark(id: string, pageIndex: number | null): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepRawOutline(depth: number) {
    const root: {
        title: string;
        items?: unknown[];
    } = { title: 'root' };
    let cursor = root;
    for (let index = 1; index < depth; index += 1) {
        const child = { title: `child-${index}` };
        cursor.items = [child];
        cursor = child;
    }
    return root;
}

function countOutlineDepth(items: Array<{ items?: readonly unknown[] | undefined }>) {
    let depth = 0;
    let current = items[0] ?? null;
    while (current) {
        depth += 1;
        current = Array.isArray(current.items)
            ? current.items[0] as { items?: unknown[] } | undefined ?? null
            : null;
    }
    return depth;
}

describe('pdfOutlineHelpers', () => {
    it('converts outline color arrays to hex', () => {
        expect(convertOutlineColorToHex([
            255,
            128.2,
            0,
        ])).toBe('#ff8000');
        expect(convertOutlineColorToHex(null)).toBeNull();
        expect(convertOutlineColorToHex([
            1,
            2,
        ])).toBeNull();
    });

    it('normalizes bookmark color values', () => {
        expect(normalizeBookmarkColor('#abc')).toBe('#aabbcc');
        expect(normalizeBookmarkColor('  #A1b2C3  ')).toBe('#a1b2c3');
        expect(normalizeBookmarkColor('blue')).toBeNull();
    });

    it('parses deeply nested outlines with bounded depth while preserving siblings', () => {
        const items = parseOutlineItems([
            createDeepRawOutline(320),
            { title: 'sibling' },
        ]);

        expect(items.map(item => item.title)).toEqual([
            'root',
            'sibling',
        ]);
        expect(countOutlineDepth(items)).toBeLessThanOrEqual(256);
    });

    it('resolves deeply nested outlines without recursive stack growth', async () => {
        const pdfDoc = createPdfDocumentStub();
        const rawItems = parseOutlineItems([createDeepRawOutline(320)]);

        const resolved = await buildResolvedOutline(
            rawItems,
            pdfDoc,
            new Map(),
            new Map(),
            () => 'bookmark-id',
        );

        expect(resolved[0]?.title).toBe('root');
        expect(countOutlineDepth(resolved)).toBeLessThanOrEqual(256);
    });

    it('projects pending bookmark entries into visible outline items without PDF.js', () => {
        let bookmarkId = 0;

        const resolved = buildOutlineFromBookmarkEntries([{
            title: 'Contents',
            pageIndex: 4,
            namedDest: 'page-5',
            bold: true,
            italic: false,
            color: '#ABC',
            items: [{
                title: 'Chapter',
                pageIndex: 10.8,
                namedDest: null,
                bold: false,
                italic: true,
                color: '#123456',
                items: [],
            }],
        }], () => {
            const id = `bookmark-${bookmarkId}`;
            bookmarkId += 1;
            return id;
        });

        expect(resolved).toEqual([{
            id: 'bookmark-0',
            title: 'Contents',
            dest: 'page-5',
            pageIndex: 4,
            bold: true,
            italic: false,
            color: '#aabbcc',
            items: [{
                id: 'bookmark-1',
                title: 'Chapter',
                dest: null,
                pageIndex: 10,
                bold: false,
                italic: true,
                color: '#123456',
                items: [],
            }],
        }]);
    });

    it('resolves named destination and caches destination + ref index', async () => {
        const getDestination = vi.fn(async (_name: string) => [{
            num: 4,
            gen: 0, 
        }]);
        const getPageIndex = vi.fn(async (_ref: unknown) => 3);
        const pdfDoc = createPdfDocumentStub({
            getDestination,
            getPageIndex,
        });

        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        const first = await resolvePageIndex(pdfDoc, 'chapter-1', destinationCache, refIndexCache);
        const second = await resolvePageIndex(pdfDoc, 'chapter-1', destinationCache, refIndexCache);

        expect(first).toBe(3);
        expect(second).toBe(3);
        expect(getDestination).toHaveBeenCalledTimes(1);
        expect(getPageIndex).toHaveBeenCalledTimes(1);
    });

    it('handles numeric destinations in both 0-based and 1-based forms', async () => {
        const pdfDoc = createPdfDocumentStub({ numPages: 5 });
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        await expect(resolvePageIndex(pdfDoc, [2], destinationCache, refIndexCache)).resolves.toBe(2);
        await expect(resolvePageIndex(pdfDoc, [5], destinationCache, refIndexCache)).resolves.toBe(4);
        await expect(resolvePageIndex(pdfDoc, [99], destinationCache, refIndexCache)).resolves.toBeNull();
    });

    it('returns null when destination lookup fails', async () => {
        const pdfDoc = createPdfDocumentStub({getDestination: vi.fn(async () => {
            throw new Error('lookup failed');
        })});
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        await expect(resolvePageIndex(pdfDoc, 'missing', destinationCache, refIndexCache)).resolves.toBeNull();
        expect(destinationCache.get('missing')).toBeNull();
    });

    it('resolves bookmark destination page as 1-based number', async () => {
        const pdfDoc = createPdfDocumentStub({
            numPages: 6,
            getDestination: vi.fn(async () => [3]),
        });

        await expect(resolveBookmarkDestinationPage(pdfDoc, 'toc')).resolves.toBe(4);
        await expect(resolveBookmarkDestinationPage(pdfDoc, [6])).resolves.toBe(6);
    });

    it('resolves /XYZ bookmark top coordinates into normalized page y targets', async () => {
        const getPage = vi.fn(async (_pageNumber: number) => createPdfPageStub([
            0,
            100,
            612,
            900,
        ]));
        const pdfDoc = createPdfDocumentStub({
            numPages: 6,
            getPage,
        });

        await expect(resolveBookmarkDestinationTarget(pdfDoc, [
            2,
            { name: 'XYZ' },
            null,
            500,
            null,
        ])).resolves.toEqual({
            page: 3,
            pageYRatio: 0.5,
        });
        expect(getPage).toHaveBeenCalledWith(3);
    });

    it('treats /XYZ destinations without an explicit top as top-of-page bookmarks', async () => {
        const getPage = vi.fn(async (_pageNumber: number) => createPdfPageStub());
        const pdfDoc = createPdfDocumentStub({
            numPages: 6,
            getPage,
        });

        await expect(resolveBookmarkDestinationTarget(pdfDoc, [
            1,
            { name: 'XYZ' },
            null,
            null,
            null,
        ])).resolves.toEqual({
            page: 2,
            pageYRatio: 0,
        });
        expect(getPage).not.toHaveBeenCalled();
    });

    it('resolves an already indexed bookmark into an immediate page navigation target', () => {
        expect(resolveImmediateBookmarkDestinationTarget(createBookmark('indexed', 278))).toEqual({
            page: 279,
            pageYRatio: 0,
        });
        expect(resolveImmediateBookmarkDestinationTarget(createBookmark('missing', null))).toBeNull();
    });

    it('emits late same-page bookmark destination refinement when the resolved y target differs', () => {
        expect(shouldEmitResolvedBookmarkDestinationTarget({
            page: 279,
            pageYRatio: 0.35,
        }, {
            page: 279,
            pageYRatio: 0,
        })).toBe(true);
        expect(shouldEmitResolvedBookmarkDestinationTarget({
            page: 279,
            pageYRatio: 0,
        }, {
            page: 279,
            pageYRatio: 0,
        })).toBe(false);
        expect(shouldEmitResolvedBookmarkDestinationTarget({
            page: 328,
            pageYRatio: 0.35,
        }, {
            page: 279,
            pageYRatio: 0,
        })).toBe(true);
        expect(shouldEmitResolvedBookmarkDestinationTarget({
            page: 279,
            pageYRatio: 0.35,
        }, null)).toBe(true);
    });

    it('preserves an explicitly active bookmark when multiple entries share the current page', () => {
        const bookmarks = [
            createBookmark('first-on-page', 4),
            createBookmark('last-on-page', 4),
            createBookmark('next-page', 5),
        ];

        expect(resolveActiveBookmarkForPage(bookmarks, 5, 'first-on-page')?.id).toBe('first-on-page');
    });

    it('uses the last bookmark at or before the page when the active bookmark is elsewhere', () => {
        const bookmarks = [
            createBookmark('intro', 0),
            createBookmark('first-on-page', 4),
            createBookmark('last-on-page', 4),
            createBookmark('next-page', 5),
        ];

        expect(resolveActiveBookmarkForPage(bookmarks, 5, 'intro')?.id).toBe('last-on-page');
    });
});
