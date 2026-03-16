import { registerSearchHandlers } from '@electron/features/search/main/ipc';
import type {
    IIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/ports';

export function createSearchService(): ISearchService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerSearchHandlers(registrar);
    }};
}
