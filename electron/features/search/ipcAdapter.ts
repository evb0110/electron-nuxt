import {createSearchService} from '@electron/features/search/service';
import type {
    TSearchIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/ports';

export function registerSearchIpcAdapter(
    registrar: TSearchIpcMainRegistrar,
    service: ISearchService = createSearchService(),
) {
    service.registerHandlers(registrar);
}
