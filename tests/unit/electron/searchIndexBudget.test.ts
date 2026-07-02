import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    rm: vi.fn(),
    stat: vi.fn(),
    buildSearchIndex: vi.fn(),
    loadSearchIndex: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    rm: mocks.rm,
    stat: mocks.stat,
}));

vi.mock('@electron/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 6,
    buildSearchIndex: mocks.buildSearchIndex,
    loadSearchIndex: mocks.loadSearchIndex,
}));

const PDF_PATH = '/tmp/poisoned.pdf';

interface IIndexPageForTest {
    pageNumber: number;
    text: string;
}

interface IIndexForTest { pages: IIndexPageForTest[]; }

interface IBuildSearchIndexOptionsForTest { validateBeforePersist?: (index: IIndexForTest) => void; }

describe('ensureSearchIndex text budget handling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.EVB_PDF_SEARCH_ENABLE;

        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            if (path === `${PDF_PATH}.index.json`) {
                return { mtimeMs: 10 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 6,
            pdfPath: PDF_PATH,
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'x'.repeat(128),
            }],
        });
        mocks.buildSearchIndex.mockResolvedValue({
            schemaVersion: 6,
            pdfPath: PDF_PATH,
            createdAt: 2,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'healed',
            }],
        });
    });

    it('deletes an over-budget cached JSON index and rebuilds it once', async () => {
        const { ensureSearchIndex } = await import('@electron/search/worker/ensureSearchIndex');

        const entry = await ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 64,
            maxTotalTextBytes: 1024,
        }, {
            pageCount: 1,
            throwIfCancelled: () => undefined,
        });

        expect(mocks.rm).toHaveBeenCalledWith(`${PDF_PATH}.index.json`, { force: true });
        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        expect(entry.index.pages).toEqual([{
            pageNumber: 1,
            text: 'healed',
        }]);
    });

    it('passes the text budget validator into index builds before persistence', async () => {
        const { ensureSearchIndex } = await import('@electron/search/worker/ensureSearchIndex');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Missing ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            const overBudgetIndex: IIndexForTest = { pages: [] };
            overBudgetIndex.pages.push({
                pageNumber: 1,
                text: 'x'.repeat(128),
            });
            options.validateBeforePersist?.(overBudgetIndex);
            throw new Error('validator should have rejected');
        });

        await expect(ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 64,
            maxTotalTextBytes: 1024,
        }, {
            pageCount: 1,
            throwIfCancelled: () => undefined,
        })).rejects.toThrow('Search index page 1 is too large');
    });
});
