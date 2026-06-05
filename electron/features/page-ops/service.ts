import { registerPageOpsHandlers } from '@electron/features/page-ops/main/ipc';
import type {
    IPageOpsService,
    TPageOpsIpcMainRegistrar,
} from '@electron/features/page-ops/ports';

export function createPageOpsService(): IPageOpsService {
    return {registerHandlers: (registrar: TPageOpsIpcMainRegistrar) => {
        registerPageOpsHandlers(registrar);
    }};
}
