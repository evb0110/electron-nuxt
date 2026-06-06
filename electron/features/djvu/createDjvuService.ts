import { registerDjvuHandlers } from '@electron/features/djvu/main/registerDjvuHandlers';
import type { IDjvuService } from '@electron/features/djvu/ports';

export function createDjvuService(): IDjvuService {
    return {registerHandlers: (registrar) => {
        registerDjvuHandlers(registrar);
    }};
}
