import type { IHostCapability } from '@contracts/electronApiHost';
import { getPlatformAPI } from '@app/utils/platform';

export function getHostCapability(): IHostCapability {
    return getPlatformAPI().host;
}
