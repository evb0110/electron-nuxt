import type { IWindowTabsCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getWindowTabsCapability(): IWindowTabsCapability {
    return getPlatformAPI().windowTabs;
}
