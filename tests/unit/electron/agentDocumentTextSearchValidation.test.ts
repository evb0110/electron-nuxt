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
});
