import type { BrowserWindow } from 'electron';

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

    try {
        window.webContents.send(channel, ...args);
    } catch (error) {
        onError(error);
    }
}
