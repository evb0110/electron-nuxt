import { registerDjvuHandlers } from '@electron/djvu/ipc';
import type {
    IDjvuService,
    IIpcMainRegistrar,
} from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerDjvuHandlers(registrar);
    }};
}
