import type { BrowserWindow } from 'electron';
import { config } from '@electron/config';
import { isTrustedRendererUrl } from '@electron/security/isTrustedRendererUrl';

function hasTrustedRendererUrl(window: BrowserWindow) {
    const trustedUrl = config.renderer.trustedUrl;
    const getURL = (window.webContents as {getURL?: () => string}).getURL;
    const currentUrl = typeof getURL === 'function' ? getURL.call(window.webContents) : '';
    return Boolean(trustedUrl && currentUrl && isTrustedRendererUrl(currentUrl, trustedUrl));
}

export function sendToLiveWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    args: unknown[],
    onError: (error: unknown) => void,
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }
    if (!hasTrustedRendererUrl(window)) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch (error) {
        onError(error);
    }
}
