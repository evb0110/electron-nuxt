import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import {
    createDjvuWorkerFromPath,
    searchDjvuWorkerText,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';

type TBrowserDjvuTextSearchCapability = Pick<
    IDjvuCapability,
    'searchText' | 'cancelTextSearch' | 'onTextSearchProgress'
>;

const progressListeners = new Set<Parameters<IDjvuCapability['onTextSearchProgress']>[0]>();
const activeSearchesByRequestId = new Map<string, Map<string, AbortController>>();

function getActiveSearchesForRequest(requestId: string) {
    const activeSearches = activeSearchesByRequestId.get(requestId);
    if (activeSearches) {
        return activeSearches;
    }
    const created = new Map<string, AbortController>();
    activeSearchesByRequestId.set(requestId, created);
    return created;
}

export const browserDjvuTextSearchCapability: TBrowserDjvuTextSearchCapability = {
    async searchText(djvuPath, query, options) {
        const activeSearches = getActiveSearchesForRequest(options.requestId);
        const previous = activeSearches.get(djvuPath);
        previous?.abort();
        const abortController = new AbortController();
        activeSearches.set(djvuPath, abortController);
        const isCurrentSearch = () => activeSearches.get(djvuPath) === abortController;
        let worker: Awaited<ReturnType<typeof createDjvuWorkerFromPath>> | null = null;
        try {
            worker = await createDjvuWorkerFromPath(djvuPath, {signal: abortController.signal});
            return await searchDjvuWorkerText(worker, {
                requestId: options.requestId,
                pageCount: options.pageCount,
                query,
                matchOptions: {
                    matchCase: Boolean(options.matchCase),
                    wholeWord: Boolean(options.wholeWord),
                    useRegex: Boolean(options.useRegex),
                },
                signal: abortController.signal,
                onProgress(progress) {
                    if (!isCurrentSearch()) {
                        return;
                    }
                    progressListeners.forEach(listener => listener(progress));
                },
            });
        } finally {
            worker?.terminate();
            if (isCurrentSearch()) {
                activeSearches.delete(djvuPath);
            }
            if (
                activeSearches.size === 0
                && activeSearchesByRequestId.get(options.requestId) === activeSearches
            ) {
                activeSearchesByRequestId.delete(options.requestId);
            }
        }
    },
    cancelTextSearch(requestId) {
        const activeSearches = activeSearchesByRequestId.get(requestId);
        if (!activeSearches) {
            return Promise.resolve({canceled: false});
        }
        let canceled = false;
        for (const activeSearch of activeSearches.values()) {
            if (!activeSearch.signal.aborted) {
                activeSearch.abort();
                canceled = true;
            }
        }
        activeSearchesByRequestId.delete(requestId);
        return Promise.resolve({canceled});
    },
    onTextSearchProgress(callback) {
        progressListeners.add(callback);
        return () => {
            progressListeners.delete(callback);
        };
    },
};
