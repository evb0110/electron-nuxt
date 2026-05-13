import type { BrowserWindow } from 'electron';
import { createLogger } from '@electron/utils/logger';
import { sendToLiveWindow } from '@electron/utils/ipcWindow';

const logger = createLogger('djvu-ipcShared');

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    sendToLiveWindow(window, channel, args, (error) => {
        logger.debug(`Failed to send IPC message "${channel}": ${String(error)}`);
    });
}
