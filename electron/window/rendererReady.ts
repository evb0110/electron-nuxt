import type { BrowserWindow } from 'electron';
import { WINDOW_RENDERER_READY_TIMEOUT_MS } from '@electron/config/constants';
import { getErrorMessage } from '@electron/utils/error';

interface IWindowStartupWaiter {
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutHandle: NodeJS.Timeout | null;
}

const windowStartupWaiters = new Map<number, IWindowStartupWaiter>();
const windowRendererReadyCallbacks = new Map<number, () => void>();

export function setWindowRendererReadyCallback(windowId: number, callback: () => void) {
    windowRendererReadyCallbacks.set(windowId, callback);
}

export function deleteWindowRendererReadyState(windowId: number) {
    windowRendererReadyCallbacks.delete(windowId);
    const waiter = windowStartupWaiters.get(windowId);
    if (waiter?.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
    }
    windowStartupWaiters.delete(windowId);
}

export function waitForInitialRendererReady(
    window: BrowserWindow,
    initialLoadPromise: Promise<void>,
) {
    const windowId = window.id;
    const windowWebContents = window.webContents;
    return new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            windowWebContents.removeListener('did-fail-load', handleFailLoad);
            windowWebContents.removeListener('render-process-gone', handleRenderProcessGone);
            window.removeListener('closed', handleClosed);

            const waiter = windowStartupWaiters.get(windowId);
            if (waiter?.timeoutHandle) {
                clearTimeout(waiter.timeoutHandle);
            }
            windowStartupWaiters.delete(windowId);
        };

        const resolveReady = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };

        const rejectReady = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const handleFailLoad = (
            _event: unknown,
            errorCode: number,
            errorDescription: string,
            validatedURL: string,
            isMainFrame?: boolean,
        ) => {
            if (isMainFrame === false) {
                return;
            }

            rejectReady(new Error(
                `Initial renderer load failed (${errorCode}: ${errorDescription}) for ${validatedURL}`,
            ));
        };

        const handleRenderProcessGone = (
            _event: unknown,
            details: {
                reason: string;
                exitCode: number;
            },
        ) => {
            rejectReady(new Error(
                `Renderer process exited before startup completed (${details.reason}, exitCode=${details.exitCode})`,
            ));
        };

        const handleClosed = () => {
            rejectReady(new Error('Window closed before renderer startup completed'));
        };

        const timeoutHandle = setTimeout(() => {
            rejectReady(new Error(`Renderer startup timed out after ${WINDOW_RENDERER_READY_TIMEOUT_MS}ms`));
        }, WINDOW_RENDERER_READY_TIMEOUT_MS);
        timeoutHandle.unref?.();

        windowStartupWaiters.set(windowId, {
            resolve: resolveReady,
            reject: rejectReady,
            timeoutHandle,
        });

        windowWebContents.on('did-fail-load', handleFailLoad);
        windowWebContents.on('render-process-gone', handleRenderProcessGone);
        window.on('closed', handleClosed);

        void initialLoadPromise.catch((error) => {
            queueMicrotask(() => {
                const waiter = windowStartupWaiters.get(windowId);
                if (!waiter) {
                    return;
                }
                rejectReady(new Error(`Initial loadURL failed: ${getErrorMessage(error)}`));
            });
        });
    });
}

export function markWindowRendererReady(windowId: number) {
    windowRendererReadyCallbacks.get(windowId)?.();

    const waiter = windowStartupWaiters.get(windowId);
    if (!waiter) {
        return;
    }

    if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
    }
    windowStartupWaiters.delete(windowId);
    waiter.resolve();
}
