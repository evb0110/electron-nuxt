import type { ISettingsCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getSettingsCapability(): ISettingsCapability {
    return getPlatformAPI().settings;
}
