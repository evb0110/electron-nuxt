import {
    handlePdfSearch,
    handlePdfSearchWarmIndex,
    searchWorkerService,
} from '@electron/features/search/main/ipc';
import type { ISearchService } from '@electron/features/search/searchService';

export function createSearchService(): ISearchService {
    return {
        search: (context, request) => handlePdfSearch(context, request),
        warmIndex: (context, request) => handlePdfSearchWarmIndex(context, request),
        cancel: (context, requestId) => searchWorkerService.cancel(context, requestId),
        resetCache: () => searchWorkerService.resetCache(),
        subscribeProgress: context => searchWorkerService.subscribeProgress(context),
        cleanupAll: reason => searchWorkerService.cleanupAll(reason),
    };
}
