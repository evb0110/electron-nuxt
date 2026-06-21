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
});
