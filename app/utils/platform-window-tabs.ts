import type { IWindowTabsCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getWindowTabsCapability(): IWindowTabsCapability {
    return getPlatformAPI().windowTabs;
}

export function isWindowTabTransferSupported() {
    if (typeof window === 'undefined') {
        return false;
    }

    return typeof BroadcastChannel !== 'undefined'
        && typeof window.open === 'function';
}
