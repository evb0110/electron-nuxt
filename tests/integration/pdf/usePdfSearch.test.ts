import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfSearch } from '@app/composables/usePdfSearch';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';

interface IProgressPayload {
    requestId: string;
    processed: number;
    total: number;
}

const mocks = vi.hoisted(() => {
    let progressHandler: ((payload: IProgressPayload) => void) | null = null;

    const api = {search: {
        run: vi.fn(),
        warmIndex: vi.fn(async () => true),
        cancel: vi.fn(async () => ({ canceled: true })),
        resetCache: vi.fn(async () => true),
        onProgress: vi.fn((handler: (payload: IProgressPayload) => void) => {
            progressHandler = handler;
            return () => {
                progressHandler = null;
            };
        }),
    }};

    return {
        api,
        hasElectronAPI: vi.fn(() => true),
        emitProgress: (payload: IProgressPayload) => {
            progressHandler?.(payload);
        },
    };
});

vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => mocks.api,
    hasElectronAPI: () => mocks.hasElectronAPI(),
    getElectronAPI: () => mocks.api,
}));

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
}}));
vi.mock('#imports', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));

describe('usePdfSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();

        mocks.api.search.run.mockResolvedValue({
            truncated: false,
            results: [
                {
                    pageNumber: 2,
                    matchIndex: 0,
                    startOffset: 10,
                    endOffset: 20,
                    excerpt: {
                        before: 'prefix ',
                        match: 'term',
                        after: ' suffix',
                        prefix: false,
                        suffix: false,
                    },
                },
                {
                    pageNumber: 2,
                    matchIndex: 1,
                    startOffset: 40,
                    endOffset: 50,
                    excerpt: {
                        before: 'a ',
                        match: 'term',
                        after: ' b',
                        prefix: false,
                        suffix: false,
                    },
                },
            ],
        });
    });

    it('returns false and clears state for short queries', async () => {
        const search = usePdfSearch();

        const applied = await search.search('a', '/tmp/doc.pdf', 20);

        expect(applied).toBe(false);
        expect(search.results.value).toEqual([]);
        expect(search.currentResultIndex.value).toBe(-1);
        expect(mocks.api.search.run).not.toHaveBeenCalled();
    });

    it('runs debounced backend search and builds page matches', async () => {
        const search = usePdfSearch();

        const promise = search.search('term', '/tmp/doc.pdf', 20);
        await vi.advanceTimersByTimeAsync(0);
        expect(search.isSearching.value).toBe(true);

        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(true);
        expect(mocks.api.search.run).toHaveBeenCalledWith('/tmp/doc.pdf', 'term', expect.objectContaining({
            requestId: expect.stringContaining('search-'),
            pageCount: 20,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        }));
        expect(search.results.value).toHaveLength(2);
        expect(search.totalMatches.value).toBe(2);
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.getMatchesForPage(1)?.matches).toHaveLength(2);

        mocks.emitProgress({
            requestId: 'other-request',
            processed: 1,
            total: 10,
        });
        expect(search.searchProgress.value).toBeUndefined();
    });

    it('navigates matches and resets backend cache', async () => {
        const search = usePdfSearch();

        const promise = search.search('term', '/tmp/doc.pdf', 20);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await promise;

        search.goToResult('next');
        expect(search.currentResultIndex.value).toBe(1);

        search.goToResult('next');
        expect(search.currentResultIndex.value).toBe(0);

        search.goToResult('previous');
        expect(search.currentResultIndex.value).toBe(1);

        search.resetSearchCache();
        expect(search.results.value).toEqual([]);
        expect(mocks.api.search.resetCache).toHaveBeenCalledOnce();
    });

    it('stores a user-facing search error when backend search is unavailable', async () => {
        mocks.api.search.run.mockRejectedValue(new Error('ERR_BROWSER_SEARCH_TOO_LARGE'));
        const search = usePdfSearch();

        const promise = search.search('term', '/tmp/doc.pdf', 20);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(false);
        expect(search.searchError.value).toBe('errors.search.browserTooLarge');
        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(false);
    });
});
