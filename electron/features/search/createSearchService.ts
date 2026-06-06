import { registerSearchHandlers } from '@electron/features/search/main/ipc';
import type { ISearchService } from '@electron/features/search/searchService';

export function createSearchService(): ISearchService {
    return {registerHandlers: (registrar) => {
        registerSearchHandlers(registrar);
    }};
}
