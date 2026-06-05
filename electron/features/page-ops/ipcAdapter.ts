import {createPageOpsService} from '@electron/features/page-ops/service';
import type {
    IPageOpsService,
    TPageOpsIpcMainRegistrar,
} from '@electron/features/page-ops/ports';

export function registerPageOpsIpcAdapter(
    registrar: TPageOpsIpcMainRegistrar,
    service: IPageOpsService = createPageOpsService(),
) {
    service.registerHandlers(registrar);
}
