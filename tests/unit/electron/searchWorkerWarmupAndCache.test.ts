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
    };
});

vi.mock('worker_threads', () => ({parentPort: mocks.parentPort}));
vi.mock('fs/promises', () => ({stat: mocks.stat}));
vi.mock('@electron/search/index-builder', () => ({
    loadSearchIndex: mocks.loadSearchIndex,
    buildSearchIndex: mocks.buildSearchIndex,
}));
vi.mock('@electron/config/constants', () => ({
    EXCERPT_CONTEXT_CHARS: 32,
    SEARCH_RESULT_LIMIT: 100,
}));
vi.mock('@electron/utils/logger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
}) }));

const TEST_PDF_PATH = '/tmp/test-search.pdf';
const TEST_INDEX_PATH = `${TEST_PDF_PATH}.index.json`;
const PAGE_TEXT = 'XxUniquePageTextxX';

describe('search worker warmup and prepared page caching', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.postedMessages.length = 0;
        mocks.messageHandlers.clear();

        mocks.stat.mockImplementation(async (path: string) => {
            if (path === TEST_PDF_PATH) {
                return { mtimeMs: 10 };
            }
            if (path === TEST_INDEX_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });

        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.buildSearchIndex.mockResolvedValue({
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });
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

    it('reuses pre-lowercased page text across repeated searches', async () => {
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
            expect(pageTextLowerCalls).toBe(1);
        } finally {
            toLowerSpy.mockRestore();
        }
    });
});
