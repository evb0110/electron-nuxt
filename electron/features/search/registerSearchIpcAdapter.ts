import {createSearchService} from '@electron/features/search/createSearchService';
import type {
    TSearchIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/searchService';

export function registerSearchIpcAdapter(
    registrar: TSearchIpcMainRegistrar,
    service: ISearchService = createSearchService(),
) {
    service.registerHandlers(registrar);
}
