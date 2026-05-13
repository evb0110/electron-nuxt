import {createSearchService} from '@electron/features/search/service';
import type {
    IIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/ports';

export function registerSearchIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: ISearchService = createSearchService(),
) {
    service.registerHandlers(registrar);
}
