import { registerDjvuHandlers } from '@electron/features/djvu/main/ipc';
import type { IDjvuService } from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {registerHandlers: (registrar) => {
        registerDjvuHandlers(registrar);
    }};
}
