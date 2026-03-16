import type { IShellCapability } from '@contracts/electron-api';
import { BrowserLogger } from '@app/utils/browser-logger';

export const browserShellCapability: IShellCapability = {openExternal(url) {
    if (typeof window === 'undefined') {
        return Promise.resolve();
    }

    const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
        BrowserLogger.warn('shell', 'Failed to open external URL', { url });
    }

    return Promise.resolve();
}};
