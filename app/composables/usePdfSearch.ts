
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
} from '@app/types/pdf';
import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
} from '@contracts/search';
import {
    tryOnScopeDispose,
    useDebounceFn,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';

export type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
};

export const usePdfSearch = () => {
    const searchQuery = ref('');
    const searchOptions = ref<Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>>({
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    });
    const results = ref<IPdfSearchMatch[]>([]);
    const pageMatches = ref<Map<number, IPdfPageMatches>>(new Map());
    const currentResultIndex = ref(-1);
    const isSearching = ref(false);
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

    function cleanupProgressListener() {
        if (progressCleanup) {
            progressCleanup();
            progressCleanup = null;
        }
        searchProgress.value = undefined;
    }

    const debouncedPerformSearch = useDebounceFn(async (payload: {
        runId: number;
        query: string;
        pdfPath: string;
        pageCount?: number;
        options: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>;
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
            );
        } catch (error) {
            BrowserLogger.warn('pdf-search', 'Search failed', {
                query: payload.query,
                error,
            });
        } finally {
            resolver?.(payload.runId === searchRunId);
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
            await getElectronAPI().search.cancel(requestIdToCancel);
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
        options: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>> = searchOptions.value,
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
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            cleanupProgressListener();

            // Call backend search API
            const api = getElectronAPI();
            const searchId = requestId;
            activeRequestId = requestId;

            progressCleanup = api.search.onProgress((progress: IPdfSearchProgress) => {
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
            });

            const response: IPdfSearchResponse = await api.search.run(pdfPath, query, {
                requestId,
                pageCount,
                ...options,
            });

            if (runId !== searchRunId) {
                return;
            }

            // Transform backend results to frontend format
            const mergedResults: IPdfSearchMatch[] = [];
            const matchesMap = new Map<number, IPdfPageMatches>();

            BrowserLogger.info('pdf-search', `Processing ${response.results.length} results`, {
                searchId,
                query, 
            });

            response.results.forEach((result, idx) => {
                mergedResults.push({
                    pageIndex: result.pageNumber - 1,
                    pageMatchIndex: result.pageMatchIndex,
                    matchIndex: result.matchIndex,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                    excerpt: result.excerpt,
                });

                // Build page matches for highlighting
                const pageIndex = result.pageNumber - 1;
                if (!matchesMap.has(pageIndex)) {
                    const pageMatches = {
                        pageIndex,
                        pageText: '', // Not required for highlighting (PDF.js text layer is the source of truth)
                        searchQuery: query, // Store the search query for text item matching
                        searchOptions: { ...options },
                        matches: [],
                    };

                    matchesMap.set(pageIndex, pageMatches);

                    BrowserLogger.debug('pdf-search', `Created pageMatches for page ${result.pageNumber}`, { searchId });
                }

                const pageMatch = matchesMap.get(pageIndex)!;
                pageMatch.matches.push({
                    matchIndex: result.matchIndex,
                    start: result.startOffset,
                    end: result.endOffset,
                });

                if (idx < 3) {
                    BrowserLogger.debug('pdf-search', `Result ${idx}`, {
                        searchId,
                        page: result.pageNumber,
                        startOffset: result.startOffset,
                        endOffset: result.endOffset,
                    });
                }
            });

            BrowserLogger.info('pdf-search', `Created ${matchesMap.size} pageMatches entries`, { searchId });
            BrowserLogger.debug(
                'pdf-search',
                'pageMatches map',
                () => Object.fromEntries(
                    Array.from(matchesMap.entries()).map((entry) => {
                        const [
                            pageIdx,
                            data,
                        ] = entry;

                        return [
                            `page-${pageIdx + 1}`,
                            {
                                searchQuery: data.searchQuery,
                                matchesCount: data.matches.length,
                            },
                        ];
                    }),
                ),
            );

            results.value = mergedResults;
            pageMatches.value = matchesMap;
            isTruncated.value = response.truncated;

            if (mergedResults.length === 0) {
                currentResultIndex.value = -1;
                return;
            }

            if (currentResultIndex.value < 0) {
                currentResultIndex.value = 0;
            } else if (currentResultIndex.value >= mergedResults.length) {
                currentResultIndex.value = mergedResults.length - 1;
            }
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
    ): Promise<boolean> {
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

        cancelScheduledSearch();
        await cancelActiveSearch();
        cleanupProgressListener();
        const runId = ++searchRunId;

        if (trimmedQuery.length < MIN_QUERY_LENGTH) {
            isSearching.value = false;
            isTruncated.value = false;
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            return false;
        }

        // Mark as searching immediately so the UI doesn't show "No results found" while we're
        // waiting for the debounce window / backend response.
        isSearching.value = true;
        isTruncated.value = false;

        return new Promise<boolean>((resolve) => {
            scheduledResolve = resolve;
            void debouncedPerformSearch({
                runId,
                query: trimmedQuery,
                pdfPath,
                pageCount,
                options: { ...searchOptions.value },
            });
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
    }

    function setResultIndex(index: number) {
        if (index >= 0 && index < results.value.length) {
            currentResultIndex.value = index;
        }
    }

    function clearSearch() {
        searchRunId++;
        cancelScheduledSearch();
        void cancelActiveSearch();
        cleanupProgressListener();
        isSearching.value = false;
        searchQuery.value = '';
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
        const api = getElectronAPI();
        void Promise.resolve(api.search.resetCache()).catch((error) => {
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
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
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
