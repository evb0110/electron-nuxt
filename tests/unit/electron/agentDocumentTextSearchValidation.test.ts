import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentTabSnapshot } from '@contracts/agent';
import type * as SearchRequestValidation from '@electron/features/search/main/searchRequestValidation';

const mocks = vi.hoisted(() => ({
    dispatchSearchRequest: vi.fn(),
    resolveSearchablePdfPath: vi.fn(),
    resolveSearchWorkerPath: vi.fn(() => '/tmp/search-worker.js'),
    loadSearchIndex: vi.fn(),
    extractTextWithPdfjs: vi.fn(),
    extractTextFromPdf: vi.fn(),
    loggerDebug: vi.fn(),
}));

vi.mock('@electron/features/search/public', async () => {
    const validation = await vi.importActual<typeof SearchRequestValidation>(
        '@electron/features/search/main/searchRequestValidation',
    );
    return {
        parseOptionalSearchPageCount: validation.parseOptionalSearchPageCount,
        validateSearchQuery: validation.validateSearchQuery,
        resolveSearchablePdfPath: mocks.resolveSearchablePdfPath,
        resolveSearchWorkerPath: mocks.resolveSearchWorkerPath,
        SearchWorkerService: class {
            dispatchSearchRequest = mocks.dispatchSearchRequest;
        },
    };
});

vi.mock('@electron/search/indexBuilder', () => ({ loadSearchIndex: mocks.loadSearchIndex }));

vi.mock('@electron/search/extractTextWithPdfjs', () => ({ extractTextWithPdfjs: mocks.extractTextWithPdfjs }));

vi.mock('@electron/search/extractTextFromPdf', () => ({ extractTextFromPdf: mocks.extractTextFromPdf }));

vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: vi.fn(async () => ({
    token: 'revision-token',
    contentRevision: 1,
}))}));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({debug: mocks.loggerDebug}) }));

const pdfTab: IAgentTabSnapshot = {
    tabId: 'tab-1',
    paneId: 'pane-1',
    fileName: 'Grammar.pdf',
    originalPath: '/tmp/Grammar.pdf',
    isDirty: false,
    kind: 'pdf',
    workspaceAttached: true,
    hasPdf: true,
    isDjvu: false,
    isOpeningDocument: false,
    hasOpenError: false,
    currentPage: 1,
    totalPages: 10,
    readiness: {
        status: 'ready',
        reasons: [],
        recommendations: [],
    },
};

function createWindow() {
    return {webContents: {id: 42}};
}

describe('agent document search validation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.resolveSearchablePdfPath.mockResolvedValue('/tmp/Grammar.pdf');
        mocks.dispatchSearchRequest.mockResolvedValue({
            results: [],
            truncated: false,
        });
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 10,
            pages: [],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([]);
        mocks.extractTextFromPdf.mockResolvedValue([]);
    });

    it('rejects unsafe regex before resolving paths or dispatching worker search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');

        await expect(searchAgentDocument(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {
                    query: '(a+)+$',
                    useRegex: true,
                },
            },
        )).rejects.toThrow('pattern is too complex for document search');

        expect(mocks.resolveSearchablePdfPath).not.toHaveBeenCalled();
        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
    });

    it('applies the renderer search query length limit to agent search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');

        await expect(searchAgentDocument(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {query: 'x'.repeat(2_049)},
            },
        )).rejects.toThrow('maximum length is 2048 characters');

        expect(mocks.resolveSearchablePdfPath).not.toHaveBeenCalled();
        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
    });

    it('searches bounded page ranges without dispatching a global worker search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 2136,
            pages: [
                {
                    pageNumber: 7,
                    text: 'Kurdish introduction',
                },
                {
                    pageNumber: 8,
                    text: '',
                },
            ],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([{
            pageNumber: 8,
            text: 'Kurdan front matter Kurdan',
        }]);

        const result = await searchAgentDocument(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: 2136,
                },
                options: {
                    query: 'Kurdan',
                    pages: [
                        7,
                        8,
                    ],
                    maxResults: 1,
                },
            },
        );

        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            bounded: true,
            returnedResults: 1,
            totalAvailableResults: 2,
            truncated: true,
            options: { pages: [
                7,
                8,
            ] },
            textStatus: {
                coverageScope: 'requested-pages',
                inspectedPages: [
                    7,
                    8,
                ],
            },
        });
        expect(result.results[0]).toMatchObject({
            pageNumber: 8,
            excerpt: { match: 'Kurdan' },
        });
    });

    it('uses a bounded direct page probe when no cached search index is available', async () => {
        const { readAgentDocumentPages } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockRejectedValue(new Error('missing index'));
        mocks.extractTextWithPdfjs.mockResolvedValue([
            {
                pageNumber: 2,
                text: 'Second page text',
            },
            {
                pageNumber: 4,
                text: '',
            },
        ]);

        const result = await readAgentDocumentPages(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {
                    pages: [
                        4,
                        2,
                    ],
                    maxCharsPerPage: 20,
                },
            },
        );

        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/Grammar.pdf', {pages: [
            2,
            4,
        ]});
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            source: 'direct-pdfjs',
            usedCachedSearchIndex: false,
            pages: [
                {
                    page: 2,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'Second page text',
                },
                {
                    page: 4,
                    source: 'direct-pdfjs',
                    hasText: false,
                    text: '',
                },
            ],
            textStatus: {
                status: 'partial',
                coverageScope: 'requested-pages',
                globalCoverageKnown: false,
                inspectedPages: [
                    2,
                    4,
                ],
                missingTextPages: [4],
            },
        });
    });

    it('direct-probes cached blank pages and reports requested-page coverage', async () => {
        const { readAgentDocumentPages } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 2136,
            pages: [
                {
                    pageNumber: 1,
                    text: '',
                },
                {
                    pageNumber: 3,
                    text: '',
                },
                {
                    pageNumber: 5,
                    text: '',
                },
                {
                    pageNumber: 25,
                    text: 'cached dictionary text',
                },
            ],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([
            {
                pageNumber: 1,
                text: '',
            },
            {
                pageNumber: 3,
                text: 'title page text',
            },
            {
                pageNumber: 5,
                text: 'front matter text',
            },
        ]);

        const result = await readAgentDocumentPages(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: 2136,
                },
                options: {pages: [
                    1,
                    3,
                    5,
                    25,
                ]},
            },
        );

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/Grammar.pdf', {pages: [
            1,
            3,
            5,
        ]});
        expect(result).toMatchObject({
            usedCachedSearchIndex: true,
            pages: [
                {
                    page: 1,
                    source: 'direct-pdfjs',
                    hasText: false,
                },
                {
                    page: 3,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'title page text',
                },
                {
                    page: 5,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'front matter text',
                },
                {
                    page: 25,
                    source: 'search-index',
                    hasText: true,
                    text: 'cached dictionary text',
                },
            ],
            textStatus: {
                status: 'partial',
                coverageScope: 'requested-pages',
                globalCoverageKnown: false,
                inspectedPages: [
                    1,
                    3,
                    5,
                    25,
                ],
                coverage: 0.75,
                missingTextPages: [1],
            },
            globalTextStatus: {
                status: 'partial',
                pageCount: 2136,
            },
        });
    });

    it('does not recommend OCR from unknown text coverage alone', async () => {
        const { inspectAgentDocumentText } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue(null);

        const result = await inspectAgentDocumentText(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {},
            },
        );

        expect(result.textStatus.status).toBe('unknown');
        expect(result.recommendations).toEqual([]);
    });
});
