import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';

const mockSearch = {
    onProgress: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    resetCache: vi.fn(),
};
vi.mock('@app/utils/platform-search', () => ({ getSearchCapability: () => mockSearch }));
vi.mock('#imports', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));

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
        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

        const applied = await search.search('a', '/tmp/work.pdf');

        expect(applied).toBe(false);
        expect(search.results.value).toEqual([]);
        expect(search.currentResultIndex.value).toBe(-1);
        expect(search.isSearching.value).toBe(false);
        expect(mockSearch.run).not.toHaveBeenCalled();
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

        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

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

        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

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

        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

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

        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

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

    it('surfaces a localized search error when backend search fails', async () => {
        mockSearch.run.mockRejectedValue(new Error('ERR_BROWSER_SEARCH_TOO_LARGE'));

        const { usePdfSearch } = await import('@app/composables/usePdfSearch');
        const search = usePdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(false);
        expect(search.searchError.value).toBe('errors.search.browserTooLarge');
        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(false);
    });
});
