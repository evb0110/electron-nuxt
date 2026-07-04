import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const messageHandlers = new Map<string, (message: unknown) => void>();

    return {
        postedMessages,
        messageHandlers,
        parentPort: {
            postMessage: vi.fn((message: Record<string, unknown>) => {
                postedMessages.push(message);
            }),
            on: vi.fn((event: string, handler: (message: unknown) => void) => {
                messageHandlers.set(event, handler);
            }),
        },
        stat: vi.fn(),
        loadSearchIndex: vi.fn(),
        buildSearchIndex: vi.fn(),
        tryRunNativeSearch: vi.fn(),
    };
});

vi.mock('worker_threads', () => ({parentPort: mocks.parentPort}));
vi.mock('fs/promises', () => ({stat: mocks.stat}));
vi.mock('@electron/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    loadSearchIndex: mocks.loadSearchIndex,
    buildSearchIndex: mocks.buildSearchIndex,
}));
vi.mock('@electron/search/nativeSearch', () => ({tryRunNativeSearch: mocks.tryRunNativeSearch}));
vi.mock('@electron/config/constants', () => ({
    EXCERPT_CONTEXT_CHARS: 32,
    SEARCH_RESULT_LIMIT: 100,
}));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
}) }));

const TEST_PDF_PATH = '/tmp/test-search.pdf';
const DOCUMENT_REVISION = 'revision-token';
const PAGE_TEXT = 'XxUniquePageTextxX';

interface IIndexedSearchPageForTest {
    pageNumber: number;
    text: string;
}

interface IBuildSearchIndexOptionsForTest {onPageIndexed?: (page: IIndexedSearchPageForTest) => void;}

describe('search worker warmup and cache behavior', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.postedMessages.length = 0;
        mocks.messageHandlers.clear();
        delete process.env.EVB_PDF_SEARCH_ENABLE;
        delete process.env.EVB_PDF_SEARCH_DISABLE;

        mocks.stat.mockImplementation(async (path: string) => {
            if (path.endsWith('.pdf')) {
                return { mtimeMs: 10 };
            }
            if (path.endsWith('.index.json')) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });

        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.tryRunNativeSearch.mockResolvedValue(null);
        mocks.buildSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });
    });

    it('uses native sidecar search before loading the JS search index when available', async () => {
        process.env.EVB_PDF_SEARCH_ENABLE = '1';
        const nativeResponse = {
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 2,
                endOffset: 8,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: 'xx',
                    match: 'needle',
                    after: 'yy',
                },
            }],
            truncated: false,
        };
        mocks.tryRunNativeSearch.mockResolvedValue({
            response: nativeResponse,
            totalPages: 3,
        });

        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'native-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: ' needle ',
                pageCount: 3,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'native-1',
                response: nativeResponse,
            });
        });
        expect(mocks.tryRunNativeSearch).toHaveBeenCalledWith(expect.objectContaining({
            matchCase: false,
            pageCount: 3,
            pdfPath: TEST_PDF_PATH,
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            useRegex: false,
            wholeWord: false,
        }));
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
    });

    it('builds and warms index on explicit warmup requests', async () => {
        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-1',
                response: {
                    results: [],
                    truncated: false,
                },
            });
        });
    });

    it('singleflights concurrent warmup index builds for the same document revision', async () => {
        let resolveBuild!: () => void;
        mocks.buildSearchIndex.mockImplementation(async () => new Promise((resolve) => {
            resolveBuild = () => resolve({
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pageCount: 1,
                pages: [{
                    pageNumber: 1,
                    text: PAGE_TEXT,
                }],
            });
        }));

        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-singleflight-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-singleflight-2',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });

        resolveBuild();

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-singleflight-1',
                response: {
                    results: [],
                    truncated: false,
                },
            });
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-singleflight-2',
                response: {
                    results: [],
                    truncated: false,
                },
            });
        });
        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
    });

    it('evicts the oldest cached index once the default cache budget is exceeded', async () => {
        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        const pdfPaths = [
            '/tmp/search-a.pdf',
            '/tmp/search-b.pdf',
            '/tmp/search-c.pdf',
            '/tmp/search-a.pdf',
        ];

        for (let index = 0; index < pdfPaths.length; index += 1) {
            const pdfPath = pdfPaths[index];
            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: `warm-${index}`,
                    pdfPath,
                    documentRevision: DOCUMENT_REVISION,
                    query: '',
                    pageCount: 1,
                    warmup: true,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: `warm-${index}`,
                }));
            });
        }

        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(4);
    });

    it('does not materialize lowercase page copies across repeated searches', async () => {
        const originalToLowerCase = String.prototype.toLowerCase;
        let pageTextLowerCalls = 0;
        const toLowerSpy = vi
            .spyOn(String.prototype, 'toLowerCase')
            .mockImplementation(function toLowerCasePatched(this: string) {
                if (String(this) === PAGE_TEXT) {
                    pageTextLowerCalls += 1;
                }
                return originalToLowerCase.call(String(this));
            });

        try {
            await import('@electron/search/worker');
            const handleMessage = mocks.messageHandlers.get('message');
            expect(handleMessage).toBeTypeOf('function');

            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: 'search-1',
                    pdfPath: TEST_PDF_PATH,
                    documentRevision: DOCUMENT_REVISION,
                    query: 'unique',
                    pageCount: 1,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: 'search-1',
                }));
            });

            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: 'search-2',
                    pdfPath: TEST_PDF_PATH,
                    documentRevision: DOCUMENT_REVISION,
                    query: 'text',
                    pageCount: 1,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: 'search-2',
                }));
            });

            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
            expect(pageTextLowerCalls).toBe(0);
        } finally {
            toLowerSpy.mockRestore();
        }
    });

    it('rebuilds stale on-disk indexes from the previous schema', async () => {
        mocks.loadSearchIndex.mockResolvedValue({
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });

        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-stale',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
    });

    it('rebuilds current-schema on-disk indexes when the PDF is newer', async () => {
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });

        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-source-newer',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('streams matches while a stale index is being rebuilt', async () => {
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            options.onPageIndexed?.({
                pageNumber: 1,
                text: 'needle on the first page',
            });
            return {
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pageCount: 2,
                pages: [
                    {
                        pageNumber: 1,
                        text: 'needle on the first page',
                    },
                    {
                        pageNumber: 2,
                        text: 'second page',
                    },
                ],
            };
        });

        await import('@electron/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'search-stream',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 2,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'progress',
                requestId: 'search-stream',
                results: [expect.objectContaining({
                    pageNumber: 1,
                    startOffset: 0,
                    endOffset: 6,
                })],
                truncated: false,
            }));
        });
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'search-stream',
            }));
        });
    });
});
