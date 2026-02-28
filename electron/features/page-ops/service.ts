import { registerPageOpsHandlers } from '@electron/page-ops/ipc';
import type {
    IPageOpsService,
    IIpcMainRegistrar,
} from '@electron/features/page-ops/ports';

export function createPageOpsService(): IPageOpsService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerPageOpsHandlers(registrar);
    }};
}
