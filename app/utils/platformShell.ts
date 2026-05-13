import type { IPlatformApi } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getShellCapability(): IPlatformApi['shell'] {
    return getPlatformAPI().shell;
}
