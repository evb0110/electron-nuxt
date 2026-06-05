import {createDjvuService} from '@electron/features/djvu/service';
import type {
    IDjvuService,
    TDjvuIpcMainRegistrar,
} from '@electron/features/djvu/ports';

export function registerDjvuIpcAdapter(
    registrar: TDjvuIpcMainRegistrar,
    service: IDjvuService = createDjvuService(),
) {
    service.registerHandlers(registrar);
}
