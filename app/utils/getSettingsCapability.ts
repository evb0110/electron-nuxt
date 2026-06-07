import type { ISettingsCapability } from '@contracts/settingsCapability';
import { getPlatformAPI } from '@app/utils/platform';

export function getSettingsCapability(): ISettingsCapability {
    return getPlatformAPI().settings;
}
