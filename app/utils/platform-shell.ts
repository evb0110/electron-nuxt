import type { IPlatformApi } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getShellCapability(): IPlatformApi['shell'] {
    return getPlatformAPI().shell;
}
