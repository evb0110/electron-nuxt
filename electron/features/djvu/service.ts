import { registerDjvuHandlers } from '@electron/features/djvu/main/ipc';
import type {
    IDjvuService,
    TDjvuIpcMainRegistrar,
} from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {registerHandlers: (registrar: TDjvuIpcMainRegistrar) => {
        registerDjvuHandlers(registrar);
    }};
}
