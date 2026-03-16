import { registerPageOpsHandlers } from '@electron/features/page-ops/main/ipc';
import type {
    IPageOpsService,
    IIpcMainRegistrar,
} from '@electron/features/page-ops/ports';

export function createPageOpsService(): IPageOpsService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerPageOpsHandlers(registrar);
    }};
}
