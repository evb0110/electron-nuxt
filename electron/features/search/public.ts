export {
    prepareSearchMainBindings,
    resolveSearchablePdfPath,
    resolveSearchWorkerPath,
    searchWorkerService,
} from '@electron/features/search/main/ipc';
export {
    parseOptionalSearchPageCount,
    validateSearchQuery,
} from '@electron/features/search/main/searchRequestValidation';
export {
    normalizeOptionalSearchPageCount,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    SEARCH_PAGE_COUNT_DEFAULT_MAX,
    SEARCH_PDF_PATH_MAX_LENGTH,
    SEARCH_REQUEST_ID_MAX_LENGTH,
} from '@electron/features/search/searchRequestPayload';
export { SearchWorkerService } from '@electron/features/search/main/searchWorkerService';
