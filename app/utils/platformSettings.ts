import type { ISettingsCapability } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getSettingsCapability(): ISettingsCapability {
    return getPlatformAPI().settings;
}
