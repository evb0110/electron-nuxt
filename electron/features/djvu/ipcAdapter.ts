import {createDjvuService} from '@electron/features/djvu/service';
import type {
    IDjvuService,
    IIpcMainRegistrar,
} from '@electron/features/djvu/ports';

export function registerDjvuIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IDjvuService = createDjvuService(),
) {
    service.registerHandlers(registrar);
}
