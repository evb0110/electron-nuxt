import { registerPageOpsHandlers } from '@electron/features/page-ops/main/registerPageOpsHandlers';
import type { IPageOpsService } from '@electron/features/page-ops/ports';

export function createPageOpsService(): IPageOpsService {
    return {registerHandlers: (registrar) => {
        registerPageOpsHandlers(registrar);
    }};
}
