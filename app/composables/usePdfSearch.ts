import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
} from '@app/types/pdf';
import type {
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
} from '@contracts/search';
import {
    tryOnScopeDispose,
    useDebounceFn,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    bucketPageCount,
    bucketQueryLength,
} from '@app/utils/analytics';
import { groupBy } from 'es-toolkit/array';
import { getSearchCapability } from '@app/utils/getSearchCapability';

export type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
};

interface IResolvedSearchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

export const usePdfSearch = () => {
    const { t } = useTypedI18n();
    const analytics = useAnalytics();
    const searchQuery = ref('');
    const submittedSearchQuery = ref('');
    const searchOptions = ref<IResolvedSearchOptions>({
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    });
    const results = ref<IPdfSearchMatch[]>([]);
    const pageMatches = ref<Map<number, IPdfPageMatches>>(new Map());
    const currentResultIndex = ref(-1);
    const currentResultNavigationId = ref(0);
    const isSearching = ref(false);
    const searchError = ref<string | null>(null);
    const searchProgress = ref<{
        processed: number;
        total: number 
    } | undefined>(undefined);
    const isTruncated = ref(false);
    let searchRunId = 0;
    let scheduledResolve: ((applied: boolean) => void) | null = null;
    let progressCleanup: (() => void) | null = null;
    let activeRequestId: string | null = null;

    const MIN_QUERY_LENGTH = 2;

    const totalMatches = computed(() => results.value.length);
    const currentMatch = computed(() => results.value.length > 0 ? currentResultIndex.value + 1 : 0);
    const currentResult = computed(() => {
        if (currentResultIndex.value >= 0 && currentResultIndex.value < results.value.length) {
            return results.value[currentResultIndex.value];
        }
        return null;
    });

    function buildPageMatchSignatureToken(pageMatchData: IPdfPageMatches) {
        let hash = 2166136261;
        const mix = (value: number) => {
            hash ^= value >>> 0;
            hash = Math.imul(hash, 16777619);
        };

        mix(pageMatchData.pageIndex);
        mix(pageMatchData.searchQuery.length);
        mix(pageMatchData.searchOptions?.matchCase ? 1 : 0);
        mix(pageMatchData.searchOptions?.wholeWord ? 1 : 0);
        mix(pageMatchData.searchOptions?.useRegex ? 1 : 0);
        mix(pageMatchData.matches.length);

        pageMatchData.matches.forEach((match) => {
            mix(match.matchIndex);
            mix(match.start);
            mix(match.end);
            mix(Math.round(match.pageWidth ?? 0));
            mix(Math.round(match.pageHeight ?? 0));
            mix(match.words?.length ?? 0);
        });

        return `${pageMatchData.pageIndex}:${pageMatchData.matches.length}:${hash >>> 0}`;
    }

    function cleanupProgressListener() {
        if (progressCleanup) {
            progressCleanup();
            progressCleanup = null;
        }
        searchProgress.value = undefined;
    }

    function normalizeSearchError(error: unknown) {
        if (error instanceof Error && error.message === 'ERR_BROWSER_SEARCH_TOO_LARGE') {
            return t('errors.search.browserTooLarge');
        }
        return t('errors.search.unavailable');
    }

    function normalizeSearchResponse(
        response: IPdfSearchResponse,
        query: string,
        options: IResolvedSearchOptions,
        searchId: string,
    ) {
        const mergedResults = response.results.map((result, idx): IPdfSearchMatch => {
            if (idx < 3) {
                BrowserLogger.debug('pdf-search', `Result ${idx}`, {
                    searchId,
                    page: result.pageNumber,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                });
            }

            return {
                pageIndex: result.pageNumber - 1,
                matchIndex: result.matchIndex,
                startOffset: result.startOffset,
                endOffset: result.endOffset,
                ...(result.pageMatchIndex !== undefined ? { pageMatchIndex: result.pageMatchIndex } : {}),
                ...(result.excerpt !== undefined ? { excerpt: result.excerpt } : {}),
            };
        });

        const pageResults = new Map(Object.entries(groupBy(
            response.results,
            result => result.pageNumber - 1,
        )).map(([
            pageIndex,
            pageSearchResults,
        ]) => {
            const firstPageResult = pageSearchResults[0];
            if (firstPageResult) {
                BrowserLogger.debug('pdf-search', `Created pageMatches for page ${firstPageResult.pageNumber}`, { searchId });
            }
            return [
                Number(pageIndex),
                pageSearchResults,
            ];
        }));

        const matchesMap = new Map(Array.from(pageResults.entries()).map(([
            pageIndex,
            pageSearchResults,
        ]) => {
            const pageMatchData: IPdfPageMatches = {
                pageIndex,
                pageText: '',
                searchQuery: query,
                searchOptions: { ...options },
                matches: pageSearchResults.map(result => ({
                    matchIndex: result.matchIndex,
                    start: result.startOffset,
                    end: result.endOffset,
                })),
            };

            return [
                pageIndex,
                {
                    ...pageMatchData,
                    signatureToken: buildPageMatchSignatureToken(pageMatchData),
                },
            ];
        }));

        return {
            results: mergedResults,
            pageMatches: matchesMap,
        };
    }

    function applySearchResponse(
        response: IPdfSearchResponse,
        query: string,
        options: IResolvedSearchOptions,
        searchId: string,
    ) {
        const normalizedResponse = normalizeSearchResponse(response, query, options, searchId);

        results.value = normalizedResponse.results;
        pageMatches.value = normalizedResponse.pageMatches;
        isTruncated.value = response.truncated;

        if (normalizedResponse.results.length === 0) {
            currentResultIndex.value = -1;
            return;
        }

        if (currentResultIndex.value < 0) {
            currentResultIndex.value = 0;
            currentResultNavigationId.value += 1;
        } else if (currentResultIndex.value >= normalizedResponse.results.length) {
            currentResultIndex.value = normalizedResponse.results.length - 1;
            currentResultNavigationId.value += 1;
        }
    }

    const debouncedPerformSearch = useDebounceFn(async (payload: {
        runId: number;
        query: string;
        pdfPath: string;
        pageCount?: number;
        options: IResolvedSearchOptions;
        requestedAt: number;
    }) => {
        const resolver = scheduledResolve;
        scheduledResolve = null;

        try {
            await performSearch(
                payload.runId,
                payload.query,
                payload.pdfPath,
                payload.pageCount,
                payload.options,
                payload.requestedAt,
            );
        } catch (error) {
            if (payload.runId === searchRunId) {
                searchError.value = normalizeSearchError(error);
                results.value = [];
                pageMatches.value = new Map();
                currentResultIndex.value = -1;
                isTruncated.value = false;
            }
            BrowserLogger.warn('pdf-search', 'Search failed', {
                query: payload.query,
                error,
            });
        } finally {
            resolver?.(payload.runId === searchRunId && !searchError.value);
        }
    }, SEARCH_DEBOUNCE_MS);

    function cancelScheduledSearch() {
        if (scheduledResolve) {
            scheduledResolve(false);
            scheduledResolve = null;
        }
    }

    async function cancelActiveSearch() {
        if (!activeRequestId) {
            return;
        }

        const requestIdToCancel = activeRequestId;
        activeRequestId = null;

        try {
            await getSearchCapability().cancel(requestIdToCancel);
        } catch (error) {
            BrowserLogger.debug('pdf-search', 'Failed to cancel active search', {
                requestId: requestIdToCancel,
                error,
            });
        }
    }

    async function performSearch(
        runId: number,
        query: string,
        pdfPath: string,
        pageCount?: number,
        options: IResolvedSearchOptions = searchOptions.value,
        requestedAt = Date.now(),
    ) {
        if (!query.trim()) {
            return;
        }

        if (runId !== searchRunId) {
            return;
        }

        const requestId = `search-${crypto.randomUUID()}`;

        try {
            isSearching.value = true;
            isTruncated.value = false;
            searchError.value = null;
            submittedSearchQuery.value = query;
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            cleanupProgressListener();

            // Call backend search API
            const api = getSearchCapability();
            const searchId = requestId;
            activeRequestId = requestId;

            progressCleanup = api.onProgress((progress) => {
                if (runId !== searchRunId) {
                    return;
                }
                if (progress.requestId !== requestId) {
                    return;
                }
                searchProgress.value = {
                    processed: progress.processed,
                    total: progress.total,
                };
                if (progress.results) {
                    applySearchResponse({
                        results: progress.results,
                        truncated: Boolean(progress.truncated),
                    }, query, options, searchId);
                    if (progress.results.length > 0 || progress.truncated) {
                        isSearching.value = false;
                    }
                }
            });

            const requestOptions: IPdfSearchRequestOptions = {
                requestId,
                ...options,
            };
            if (pageCount !== undefined) {
                requestOptions.pageCount = pageCount;
            }

            const response = await api.run(pdfPath, query, requestOptions);

            if (runId !== searchRunId) {
                return;
            }

            BrowserLogger.info('pdf-search', `Processing ${response.results.length} results`, {
                searchId,
                query, 
            });
            applySearchResponse(response, query, options, searchId);
            isTruncated.value = response.truncated;
            analytics.track('search_executed', {
                durationMs: Math.max(0, Date.now() - requestedAt),
                matchCase: options.matchCase,
                pageCountBucket: bucketPageCount(pageCount),
                queryLengthBucket: bucketQueryLength(query.length),
                resultCount: response.results.length,
                truncated: response.truncated,
                useRegex: options.useRegex,
                wholeWord: options.wholeWord,
            });
        } finally {
            if (activeRequestId === requestId) {
                activeRequestId = null;
            }
            if (runId === searchRunId) {
                isSearching.value = false;
                cleanupProgressListener();
            }
        }
    }

    async function search(
        query: string,
        pdfPath: string,
        pageCount?: number,
        options: Partial<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>> = searchOptions.value,
    ) {
        searchQuery.value = query;
        searchOptions.value = {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
            useRegex: Boolean(options.useRegex),
        };
        const trimmedQuery = query.trim();

        if (!trimmedQuery) {
            clearSearch();
            return false;
        }

        const runId = ++searchRunId;
        cancelScheduledSearch();
        await cancelActiveSearch();
        cleanupProgressListener();

        if (trimmedQuery.length < MIN_QUERY_LENGTH) {
            isSearching.value = false;
            isTruncated.value = false;
            searchError.value = null;
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            return false;
        }

        // Mark as searching immediately so the UI doesn't show "No results found" while we're
        // waiting for the debounce window / backend response.
        isSearching.value = true;
        isTruncated.value = false;
        searchError.value = null;

        return new Promise<boolean>((resolve) => {
            scheduledResolve = resolve;
            const payload = {
                runId,
                query: trimmedQuery,
                pdfPath,
                options: { ...searchOptions.value },
                requestedAt: Date.now(),
            };
            if (pageCount !== undefined) {
                void debouncedPerformSearch({
                    ...payload,
                    pageCount,
                });
                return;
            }
            void debouncedPerformSearch(payload);
        });
    }

    function setSearchOption(
        key: keyof typeof searchOptions.value,
        value: boolean,
    ) {
        searchOptions.value = {
            ...searchOptions.value,
            [key]: value,
        };
    }

    function goToResult(direction: TSearchDirection) {
        if (results.value.length === 0) {
            return;
        }

        if (direction === 'next') {
            currentResultIndex.value = (currentResultIndex.value + 1) % results.value.length;
        } else {
            currentResultIndex.value = currentResultIndex.value <= 0
                ? results.value.length - 1
                : currentResultIndex.value - 1;
        }
        currentResultNavigationId.value += 1;
    }

    function setResultIndex(index: number) {
        if (index >= 0 && index < results.value.length) {
            if (currentResultIndex.value !== index) {
                currentResultIndex.value = index;
            }
            currentResultNavigationId.value += 1;
        }
    }

    function clearSearch() {
        searchRunId++;
        cancelScheduledSearch();
        void cancelActiveSearch();
        cleanupProgressListener();
        isSearching.value = false;
        searchQuery.value = '';
        submittedSearchQuery.value = '';
        searchError.value = null;
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;
        isTruncated.value = false;
    }

    function getMatchesForPage(pageIndex: number) {
        return pageMatches.value.get(pageIndex) ?? null;
    }

    function resetSearchCache() {
        clearSearch();
        void Promise.resolve(getSearchCapability().resetCache()).catch((error) => {
            BrowserLogger.debug(
                'pdf-search',
                'Failed to reset search cache',
                error,
            );
        });
    }

    tryOnScopeDispose(() => {
        searchRunId += 1;
        cancelScheduledSearch();
        cleanupProgressListener();
        void cancelActiveSearch();
        const maybeCancelableDebounce = debouncedPerformSearch as { cancel?: () => void; };
        maybeCancelableDebounce.cancel?.();
        isSearching.value = false;
    });

    return {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
        searchProgress,
        totalMatches,
        currentMatch,
        isTruncated,
        minQueryLength: MIN_QUERY_LENGTH,
        search,
        setSearchOption,
        goToResult,
        setResultIndex,
        clearSearch,
        resetSearchCache,
        getMatchesForPage,
    };
};
