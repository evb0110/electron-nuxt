import {createPageOpsService} from '@electron/features/page-ops/service';
import type {
    IPageOpsService,
    IIpcMainRegistrar,
} from '@electron/features/page-ops/ports';

export function registerPageOpsIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IPageOpsService = createPageOpsService(),
) {
    service.registerHandlers(registrar);
}
