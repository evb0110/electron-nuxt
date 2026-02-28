import { registerSearchHandlers } from '@electron/search/ipc';
import type {
    IIpcMainRegistrar,
    ISearchService,
} from '@electron/features/search/ports';

export function createSearchService(): ISearchService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerSearchHandlers(registrar);
    }};
}
