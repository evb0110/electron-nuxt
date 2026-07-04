import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type {IShutdownSaveFlushResult} from '@electron/platform-ipc/coreContract';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
} from '@electron/platform-ipc/coreContract';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

export interface IShutdownSaveFlushSummary {
    dirtyWorkingCopyPaths: string[];
    flushedWorkingCopyPaths: string[];
    timedOutWindowIds: number[];
}

function normalizePathList(value: unknown): string[] {
    return Array.isArray(value)
        ? (value as unknown[]).filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
            .map(path => path.trim())
        : [];
}

export async function requestShutdownSaveFlush(options: {
    getWindows: () => BrowserWindow[];
    logger: ILogger;
    timeoutMs: number;
}): Promise<IShutdownSaveFlushSummary> {
    const windows = options.getWindows()
        .filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
    if (windows.length === 0) {
        return {
            dirtyWorkingCopyPaths: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        };
    }

    const requestId = `shutdown-save-flush-${randomUUID()}`;
    const pendingBySenderId = new Map(windows.map(window => [
        window.webContents.id,
        window.id,
    ]));
    const dirtyWorkingCopyPaths = new Set<string>();
    const flushedWorkingCopyPaths = new Set<string>();

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            cleanup();
            const timedOutWindowIds = Array.from(pendingBySenderId.values());
            if (timedOutWindowIds.length > 0) {
                options.logger.error(
                    `Timed out waiting for shutdown save flush from ${timedOutWindowIds.length} renderer(s): ${timedOutWindowIds.join(', ')}`,
                );
            }
            resolve({
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                timedOutWindowIds,
            });
        }, options.timeoutMs);
        timeout.unref?.();

        const cleanup = () => {
            clearTimeout(timeout);
            ipcMain.removeListener(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, handleResponse);
        };

        const finishIfDone = () => {
            if (pendingBySenderId.size > 0) {
                return;
            }
            cleanup();
            resolve({
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                timedOutWindowIds: [],
            });
        };

        const handleResponse = (
            event: Electron.IpcMainEvent,
            payload: IShutdownSaveFlushResult,
        ) => {
            if (payload?.requestId !== requestId || !pendingBySenderId.has(event.sender.id)) {
                return;
            }
            pendingBySenderId.delete(event.sender.id);
            for (const path of normalizePathList(payload.dirtyWorkingCopyPaths)) {
                dirtyWorkingCopyPaths.add(path);
            }
            for (const path of normalizePathList(payload.flushedWorkingCopyPaths)) {
                flushedWorkingCopyPaths.add(path);
                dirtyWorkingCopyPaths.delete(path);
            }
            if (payload.error) {
                options.logger.error(`Renderer shutdown save flush failed: ${payload.error}`);
            }
            finishIfDone();
        };

        ipcMain.on(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, handleResponse);
        for (const window of windows) {
            try {
                window.webContents.send(CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest, {requestId});
            } catch (error) {
                pendingBySenderId.delete(window.webContents.id);
                options.logger.error(`Failed to request renderer save flush for window ${window.id}: ${getErrorMessage(error)}`);
            }
        }
        finishIfDone();
    });
}
