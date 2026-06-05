import { registerSearchHandlers } from '@electron/features/search/main/ipc';
import type {
    TSearchIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/ports';

export function createSearchService(): ISearchService {
    return {registerHandlers: (registrar: TSearchIpcMainRegistrar) => {
        registerSearchHandlers(registrar);
    }};
}
