import type { BrowserWindow } from 'electron';
import { WINDOW_RENDERER_READY_TIMEOUT_MS } from '@electron/config/constants';
import { getErrorMessage } from '@electron/utils/error';

interface IWindowStartupWaiter {
    resolve: () => void;
    reject: (error: Error) => void;
    rejectInitialLoadFailure: (error: Error) => void;
    timeoutHandle: NodeJS.Timeout | null;
}

const windowStartupWaiters = new Map<number, IWindowStartupWaiter>();
const windowRendererReadyCallbacks = new Map<number, () => void>();

export interface IWaitForInitialRendererReadyOptions {
    onInitialLoadFailure?: (error: Error) => void;
    onRendererGone?: () => void;
}

export function setWindowRendererReadyCallback(windowId: number, callback: () => void) {
    windowRendererReadyCallbacks.set(windowId, callback);
}

export function deleteWindowRendererReadyCallback(windowId: number) {
    windowRendererReadyCallbacks.delete(windowId);
}

export function deleteWindowRendererReadyState(windowId: number) {
    deleteWindowRendererReadyCallback(windowId);
    const waiter = windowStartupWaiters.get(windowId);
    if (waiter?.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
    }
    windowStartupWaiters.delete(windowId);
}

export function waitForInitialRendererReady(
    window: BrowserWindow,
    initialLoadPromise: Promise<void>,
    options: IWaitForInitialRendererReadyOptions = {},
) {
    const windowId = window.id;
    const windowWebContents = window.webContents;
    return new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
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

        const rejectInitialLoadFailure = (error: Error) => {
            try {
                options.onInitialLoadFailure?.(error);
            } catch {
                // Diagnostic reporting must not change readiness rejection behavior.
            }
            rejectReady(error);
        };

        const handleRenderProcessGone = (
            _event: unknown,
            details: {
                reason: string;
                exitCode: number;
            },
        ) => {
            try {
                options.onRendererGone?.();
            } catch {
                // Readiness rejection must not depend on diagnostic ownership hooks.
            }
            rejectReady(new Error(
                `Renderer process exited before startup completed (${details.reason}, exitCode=${details.exitCode})`,
            ));
        };

        const handleClosed = () => {
            rejectReady(new Error('Window closed before renderer startup completed'));
        };

        const timeoutHandle = setTimeout(() => {
            rejectInitialLoadFailure(new Error(`Renderer startup timed out after ${WINDOW_RENDERER_READY_TIMEOUT_MS}ms`));
        }, WINDOW_RENDERER_READY_TIMEOUT_MS);
        timeoutHandle.unref();

        windowStartupWaiters.set(windowId, {
            resolve: resolveReady,
            reject: rejectReady,
            rejectInitialLoadFailure,
            timeoutHandle,
        });

        windowWebContents.on('render-process-gone', handleRenderProcessGone);
        window.on('closed', handleClosed);

        void initialLoadPromise.catch((error) => {
            queueMicrotask(() => {
                const waiter = windowStartupWaiters.get(windowId);
                if (!waiter) {
                    return;
                }
                waiter.rejectInitialLoadFailure(new Error(`Initial loadURL failed: ${getErrorMessage(error)}`));
            });
        });
    });
}

export function notifyWindowRendererLoadFailure(windowId: number, error: Error) {
    windowStartupWaiters.get(windowId)?.rejectInitialLoadFailure(error);
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
