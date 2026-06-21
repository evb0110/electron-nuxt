import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';

interface IPdfSearchTestExcerpt {
    after: string;
    before: string;
    match: string;
}

interface IPdfSearchBackendMatch {
    endOffset: number;
    excerpt?: IPdfSearchTestExcerpt;
    matchIndex: number;
    pageMatchIndex: number;
    pageNumber: number;
    startOffset: number;
}

interface IPdfSearchTestProgress {
    processed: number;
    requestId: string;
    results?: IPdfSearchBackendMatch[];
    total: number;
    truncated?: boolean;
}

interface IPdfSearchRunOptions { requestId: string }

interface IPdfSearchRunResult {
    results: unknown[];
    truncated: boolean;
}

interface IPdfSearchTestResult {
    endOffset: number;
    matchIndex: number;
    pageIndex: number;
    pageMatchIndex: number;
    startOffset: number;
}

interface IPdfSearchPageMatches {
    matches: Array<{
        end: number;
        matchIndex: number;
        start: number;
    }>;
    searchQuery: string;
}

interface IPdfSearchTestApi {
    clearSearch: () => void;
    currentMatch: Ref<number>;
    currentResult: Ref<IPdfSearchTestResult | null>;
    currentResultIndex: Ref<number>;
    currentResultNavigationId: Ref<number>;
    getMatchesForPage: (pageIndex: number) => IPdfSearchPageMatches | null;
    goToResult: (direction: 'next' | 'previous' | 1 | -1) => void;
    isSearching: Ref<boolean>;
    isTruncated: Ref<boolean>;
    resetSearchCache: (pdfPath?: string) => void;
    results: Ref<IPdfSearchTestResult[]>;
    search: (query: string, pdfPath: string, totalPages?: number) => Promise<boolean>;
    searchError: Ref<string | null>;
    searchProgress: Ref<IPdfSearchTestProgress | undefined>;
    searchQuery: Ref<string>;
    submittedSearchQuery: Ref<string>;
    setResultIndex: (index: number) => void;
    totalMatches: Ref<number>;
}

const mockSearch = {
    onProgress: vi.fn<(listener: (progress: IPdfSearchTestProgress) => void) => () => void>(),
    run: vi.fn<(pdfPath: string, query: string, options: IPdfSearchRunOptions) => Promise<IPdfSearchRunResult>>(),
    cancel: vi.fn<() => void>(),
    resetCache: vi.fn<() => void>(),
};
vi.mock('@app/utils/getSearchCapability', () => ({ getSearchCapability: () => mockSearch }));
vi.mock('#imports', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));

async function createPdfSearch(): Promise<IPdfSearchTestApi> {
    const { usePdfSearch } = await import('@app/composables/usePdfSearch');
    return usePdfSearch() as IPdfSearchTestApi;
}

describe('usePdfSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockSearch.onProgress.mockReturnValue(vi.fn());
        mockSearch.run.mockResolvedValue({
            results: [],
            truncated: false,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects too-short queries without calling backend search', async () => {
        const search = await createPdfSearch();

        const applied = await search.search('a', '/tmp/work.pdf');

        expect(applied).toBe(false);
        expect(search.results.value).toEqual([]);
        expect(search.currentResultIndex.value).toBe(-1);
        expect(search.isSearching.value).toBe(false);
        expect(search.submittedSearchQuery.value).toBe('a');
        expect(mockSearch.run).not.toHaveBeenCalled();
    });

    it('replaces the previous submitted query when the next submitted query is too short', async () => {
        mockSearch.run.mockResolvedValue({
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
        });
        const search = await createPdfSearch();

        const firstSearch = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await firstSearch;

        expect(search.submittedSearchQuery.value).toBe('alpha');
        expect(search.results.value).toHaveLength(1);

        const applied = await search.search('a', '/tmp/work.pdf');

        expect(applied).toBe(false);
        expect(search.submittedSearchQuery.value).toBe('a');
        expect(search.results.value).toEqual([]);
    });

    it('maps backend matches to result and page match state', async () => {
        const progressUnsubscribe = vi.fn();
        let progressListener: ((progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void) | null = null;

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return progressUnsubscribe;
        });

        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            progressListener?.({
                requestId: options.requestId,
                processed: 3,
                total: 10,
            });

            return {
                results: [
                    {
                        pageNumber: 2,
                        pageMatchIndex: 1,
                        matchIndex: 11,
                        startOffset: 20,
                        endOffset: 24,
                        excerpt: {
                            before: 'before',
                            match: 'term',
                            after: 'after',
                        },
                    },
                    {
                        pageNumber: 2,
                        pageMatchIndex: 2,
                        matchIndex: 12,
                        startOffset: 30,
                        endOffset: 35,
                        excerpt: {
                            before: 'before2',
                            match: 'term',
                            after: 'after2',
                        },
                    },
                ],
                truncated: true,
            };
        });
        const search = await createPdfSearch();

        const promise = search.search('term', '/tmp/work.pdf', 10);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(true);
        expect(search.isSearching.value).toBe(false);
        expect(search.totalMatches.value).toBe(2);
        expect(search.currentMatch.value).toBe(1);
        expect(search.currentResultNavigationId.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 1,
            pageMatchIndex: 1,
            matchIndex: 11,
            startOffset: 20,
            endOffset: 24,
        }));
        expect(search.isTruncated.value).toBe(true);
        expect(search.searchProgress.value).toBeUndefined();
        expect(progressUnsubscribe).toHaveBeenCalledOnce();

        const matchesForPage = search.getMatchesForPage(1);
        expect(matchesForPage).not.toBeNull();
        expect(matchesForPage?.searchQuery).toBe('term');
        expect(matchesForPage?.matches).toEqual([
            {
                matchIndex: 11,
                start: 20,
                end: 24,
            },
            {
                matchIndex: 12,
                start: 30,
                end: 35,
            },
        ]);
    });

    it('shows streamed matches before the backend finishes the full document search', async () => {
        let progressListener: ((progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void) | null = null;
        let resolveSearch: (value: {
            results: unknown[];
            truncated: boolean;
        }) => void = () => {};

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => new Promise((resolve) => {
            progressListener?.({
                requestId: options.requestId,
                processed: 3,
                total: 928,
                results: [{
                    pageNumber: 3,
                    pageMatchIndex: 0,
                    matchIndex: 0,
                    startOffset: 8,
                    endOffset: 12,
                }],
                truncated: false,
            });
            resolveSearch = resolve;
        }));
        const search = await createPdfSearch();

        const promise = search.search('араб', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(search.isSearching.value).toBe(false);
        expect(search.totalMatches.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 2,
            startOffset: 8,
            endOffset: 12,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [],
            truncated: false,
        });
        await promise;
    });

    it('keeps match navigation stable while streamed result batches grow', async () => {
        let requestId = '';
        let progressListener: (progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};

        const firstResult = {
            pageNumber: 3,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 8,
            endOffset: 12,
        };
        const secondResult = {
            pageNumber: 9,
            pageMatchIndex: 0,
            matchIndex: 1,
            startOffset: 18,
            endOffset: 22,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        progressListener({
            requestId,
            processed: 3,
            total: 928,
            results: [firstResult],
            truncated: false,
        });

        expect(search.totalMatches.value).toBe(1);
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        progressListener({
            requestId,
            processed: 6,
            total: 928,
            results: [
                firstResult,
                secondResult,
            ],
            truncated: false,
        });

        expect(search.totalMatches.value).toBe(2);
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [
                firstResult,
                secondResult,
            ],
            truncated: false,
        });
        await promise;

        expect(search.currentResultNavigationId.value).toBe(1);
    });

    it('preserves the active match target when streamed batches insert earlier results', async () => {
        let requestId = '';
        let progressListener: (progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};

        const initiallyVisibleResult = {
            pageNumber: 8,
            pageMatchIndex: 0,
            matchIndex: 3,
            startOffset: 40,
            endOffset: 45,
        };
        const earlierDiscoveredResult = {
            pageNumber: 6,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 12,
            endOffset: 17,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        progressListener({
            requestId,
            processed: 8,
            total: 928,
            results: [initiallyVisibleResult],
            truncated: false,
        });

        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 7,
            matchIndex: 3,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        progressListener({
            requestId,
            processed: 12,
            total: 928,
            results: [
                earlierDiscoveredResult,
                initiallyVisibleResult,
            ],
            truncated: false,
        });

        expect(search.currentResultIndex.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 7,
            matchIndex: 3,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [
                earlierDiscoveredResult,
                initiallyVisibleResult,
            ],
            truncated: false,
        });
        await promise;

        expect(search.currentResultIndex.value).toBe(1);
        expect(search.currentResultNavigationId.value).toBe(1);
    });

    it('advances match navigation only for explicit result commands after initial selection', async () => {
        mockSearch.run.mockResolvedValue({
            results: [
                {
                    pageNumber: 2,
                    pageMatchIndex: 0,
                    matchIndex: 4,
                    startOffset: 10,
                    endOffset: 15,
                    excerpt: {
                        before: '',
                        match: 'alpha',
                        after: '',
                    },
                },
                {
                    pageNumber: 7,
                    pageMatchIndex: 0,
                    matchIndex: 9,
                    startOffset: 20,
                    endOffset: 25,
                    excerpt: {
                        before: '',
                        match: 'alpha',
                        after: '',
                    },
                },
            ],
            truncated: false,
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await promise;

        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        search.setResultIndex(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 6,
            matchIndex: 9,
        }));
        expect(search.currentResultNavigationId.value).toBe(2);

        search.setResultIndex(1);
        expect(search.currentResultNavigationId.value).toBe(3);

        search.goToResult('next');
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(4);
    });

    it('cancels active searches on clear and resets backend cache explicitly', async () => {
        let requestId = '';
        let resolveSearch: (value: {
            results: unknown[];
            truncated: boolean;
        }) => void = () => {};

        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise<{
                results: unknown[];
                truncated: boolean;
            }>((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const searchPromise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(mockSearch.run).toHaveBeenCalledOnce();
        expect(requestId).toContain('search-');

        search.clearSearch();

        expect(mockSearch.cancel).toHaveBeenCalledWith(requestId);
        expect(search.searchQuery.value).toBe('');
        expect(search.results.value).toEqual([]);

        resolveSearch({
            results: [],
            truncated: false,
        });
        await searchPromise;

        search.resetSearchCache();
        expect(mockSearch.resetCache).toHaveBeenCalledOnce();
    });

    it('invalidates the active run before awaiting backend cancellation', async () => {
        let firstRequestId = '';
        let resolveFirstSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};
        let resolveCancel: () => void = () => {};

        mockSearch.run.mockImplementation(async (_pdfPath, query, options) => {
            if (query === 'beta') {
                return {
                    results: [],
                    truncated: false,
                };
            }

            firstRequestId = options.requestId;
            return new Promise((resolve) => {
                resolveFirstSearch = resolve;
            });
        });
        mockSearch.cancel.mockImplementation(async () => new Promise<void>((resolve) => {
            resolveCancel = resolve;
        }));
        const search = await createPdfSearch();

        const firstSearch = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(mockSearch.run).toHaveBeenCalledOnce();

        const secondSearch = search.search('beta', '/tmp/work.pdf');
        await vi.waitFor(() => {
            expect(mockSearch.cancel).toHaveBeenCalledWith(firstRequestId);
        });

        resolveFirstSearch({
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 1,
                endOffset: 6,
            }],
            truncated: false,
        });
        await firstSearch;

        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(true);

        resolveCancel();
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await secondSearch;
    });

    it('surfaces a localized search error when backend search fails', async () => {
        mockSearch.run.mockRejectedValue(new Error('ERR_BROWSER_SEARCH_TOO_LARGE'));
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(false);
        expect(search.searchError.value).toBe('errors.search.browserTooLarge');
        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(false);
    });
});
