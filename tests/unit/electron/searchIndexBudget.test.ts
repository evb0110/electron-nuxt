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
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    buildSearchIndex: mocks.buildSearchIndex,
    loadSearchIndex: mocks.loadSearchIndex,
}));

const PDF_PATH = '/tmp/poisoned.pdf';
const DOCUMENT_REVISION = 'revision-token';

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

interface IIndexPageForTest {
    pageNumber: number;
    text: string;
}

interface IIndexForTest { pages: IIndexPageForTest[]; }

interface IBuildSearchIndexOptionsForTest {
    signal?: AbortSignal;
    onPageIndexed?: (page: IIndexPageForTest) => void;
    validateBeforePersist?: (index: IIndexForTest) => void;
}

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
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: PDF_PATH,
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'x'.repeat(128),
            }],
        });
        mocks.buildSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
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
            documentRevision: DOCUMENT_REVISION,
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
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            throwIfCancelled: () => undefined,
        })).rejects.toThrow('Search index page 1 is too large');
    });

    it('keeps a shared index build alive when one waiter stream callback aborts', async () => {
        const { ensureSearchIndex } = await import('@electron/search/worker/ensureSearchIndex');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Missing ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue(null);

        let emitIndexedPage: () => void = () => {
            throw new Error('Build has not started');
        };
        let resolveBuild: () => void = () => {
            throw new Error('Build has not started');
        };
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
            emitIndexedPage = () => {
                options.onPageIndexed?.({
                    pageNumber: 1,
                    text: 'needle',
                });
            };
            resolveBuild = () => resolve({
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: PDF_PATH,
                createdAt: 2,
                pageCount: 1,
                pages: [{
                    pageNumber: 1,
                    text: 'needle',
                }],
            });
        }));

        const firstController = new AbortController();
        const firstStream = vi.fn(() => {
            throw createAbortError();
        });
        const secondStream = vi.fn();

        const firstWaiter = ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            signal: firstController.signal,
            throwIfCancelled: signal => {
                if (signal?.aborted) {
                    throw createAbortError();
                }
            },
            onPageIndexed: firstStream,
        });
        const secondWaiter = ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            throwIfCancelled: () => undefined,
            onPageIndexed: secondStream,
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledOnce();
        });

        emitIndexedPage();
        firstController.abort(createAbortError());
        resolveBuild();

        await expect(firstWaiter).rejects.toMatchObject({ name: 'AbortError' });
        const secondEntry = await secondWaiter;
        expect(secondEntry.index.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'needle',
        })]);
        expect(firstStream).toHaveBeenCalledOnce();
        expect(secondStream).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 1,
            text: 'needle',
        }));
        expect(mocks.buildSearchIndex).toHaveBeenCalledOnce();
    });
});
