import type {
    IMenuEventUnsubscribe,
    IWindowTabsCapability,
} from '@contracts/platform-api';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
} from '@contracts/window-tabs';
import { BrowserLogger } from '@app/utils/browser-logger';

const WINDOW_TABS_CHANNEL = 'evb-viewer:browser-window-tabs';
const WINDOW_ID_QUERY_PARAM = 'evbWindowId';
const DEFAULT_TRANSFER_TIMEOUT_MS = 12_000;
const DISCOVERY_SETTLE_DELAY_MS = 60;
const FALLBACK_WINDOW_TITLE = 'EVB Viewer';
const CLOSE_CURRENT_WINDOW_TIMEOUT_MS = 150;

type TIncomingTransferListener = (
    transfer: IWindowTabIncomingTransfer,
) => void;

interface IKnownBrowserWindow {
    label: string;
    ready: boolean;
}

interface IPendingBrowserTransfer {
    transferId: string;
    targetWindowId: number;
    payload: IWindowTabIncomingTransfer;
    resolve: (result: IWindowTabTransferResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

type TBrowserWindowTabsMessage =
    | {
        type: 'discover';
        windowId: number;
    }
    | {
        type: 'announce';
        windowId: number;
        label: string;
        ready: boolean;
    }
    | {
        type: 'unregister';
        windowId: number;
    }
    | {
        type: 'transfer';
        transfer: IWindowTabIncomingTransfer;
    }
    | {
        type: 'ack';
        windowId: number;
        ack: IWindowTabTransferAck;
    };

const incomingTransferListeners = new Set<TIncomingTransferListener>();
const knownWindows = new Map<number, IKnownBrowserWindow>();
const pendingTransfers = new Map<string, IPendingBrowserTransfer>();
const queuedTransfersByWindow = new Map<number, string[]>();

let channel: BroadcastChannel | null = null;
let initialized = false;
let currentWindowId = -1;
let isCurrentWindowReady = false;
let cleanupRegistered = false;

function noopUnsubscribe(): IMenuEventUnsubscribe {
    return () => {};
}

function hasBrowserWindowContext() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getCurrentWindowLabel() {
    if (!hasBrowserWindowContext()) {
        return FALLBACK_WINDOW_TITLE;
    }

    const title = document.title.trim();
    return title.length > 0 ? title : FALLBACK_WINDOW_TITLE;
}

function normalizeTimeout(timeoutMs: number | undefined) {
    if (
        typeof timeoutMs !== 'number'
        || !Number.isFinite(timeoutMs)
        || timeoutMs <= 0
    ) {
        return DEFAULT_TRANSFER_TIMEOUT_MS;
    }

    return Math.max(1, Math.floor(timeoutMs));
}

function createWindowId() {
    return Math.max(
        1,
        Math.floor(Date.now() + Math.random() * 1_000_000),
    );
}

function resolveCurrentWindowId() {
    if (!hasBrowserWindowContext()) {
        return -1;
    }

    try {
        const url = new URL(window.location.href);
        const fromQuery = Number(url.searchParams.get(WINDOW_ID_QUERY_PARAM));
        if (Number.isSafeInteger(fromQuery) && fromQuery > 0) {
            url.searchParams.delete(WINDOW_ID_QUERY_PARAM);
            if (window.history?.replaceState) {
                window.history.replaceState(
                    window.history.state,
                    '',
                    url.toString(),
                );
            }
            return fromQuery;
        }
    } catch (error) {
        BrowserLogger.warn(
            'browser-window-tabs',
            'Failed to resolve browser window ID from URL',
            error,
        );
    }

    return createWindowId();
}

function ensureChannel() {
    if (channel || !hasBrowserWindowContext()) {
        return channel;
    }

    if (typeof BroadcastChannel === 'undefined') {
        return null;
    }

    channel = new BroadcastChannel(WINDOW_TABS_CHANNEL);
    channel.addEventListener('message', (event) => {
        handleMessage(event.data);
    });
    return channel;
}

function postMessage(message: TBrowserWindowTabsMessage) {
    ensureChannel()?.postMessage(message);
}

function waitForBrowserWindowCloseAttempt() {
    if (!hasBrowserWindowContext()) {
        return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
        let settled = false;
        let timeoutId = 0;

        const cleanup = () => {
            window.removeEventListener('pagehide', handleWindowClosed);
            window.removeEventListener('beforeunload', handleWindowClosed);
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
        };

        const finish = (closed: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(closed);
        };

        const handleWindowClosed = () => {
            finish(true);
        };

        window.addEventListener('pagehide', handleWindowClosed, { once: true });
        window.addEventListener('beforeunload', handleWindowClosed, { once: true });

        timeoutId = window.setTimeout(() => {
            finish(false);
        }, CLOSE_CURRENT_WINDOW_TIMEOUT_MS);
    });
}

function queueTransferForWindow(windowId: number, transferId: string) {
    const queued = queuedTransfersByWindow.get(windowId) ?? [];
    queued.push(transferId);
    queuedTransfersByWindow.set(windowId, queued);
}

function removeQueuedTransferReference(windowId: number, transferId: string) {
    const queued = queuedTransfersByWindow.get(windowId);
    if (!queued) {
        return;
    }

    const nextQueued = queued.filter((candidate) => candidate !== transferId);
    if (nextQueued.length === 0) {
        queuedTransfersByWindow.delete(windowId);
        return;
    }

    queuedTransfersByWindow.set(windowId, nextQueued);
}

function finishTransfer(
    transferId: string,
    result: {
        success: boolean;
        error?: string;
    },
) {
    const pending = pendingTransfers.get(transferId);
    if (!pending) {
        return;
    }

    pendingTransfers.delete(transferId);
    removeQueuedTransferReference(pending.targetWindowId, transferId);
    clearTimeout(pending.timeoutHandle);
    pending.resolve({
        transferId,
        success: result.success,
        targetWindowId: pending.targetWindowId,
        ...(result.error ? { error: result.error } : {}),
    });
}

function dispatchQueuedTransfers(windowId: number) {
    const queued = queuedTransfersByWindow.get(windowId) ?? [];
    if (queued.length === 0) {
        return;
    }

    queuedTransfersByWindow.delete(windowId);
    for (const transferId of queued) {
        dispatchTransfer(transferId);
    }
}

function markWindowUnavailable(windowId: number, error: string) {
    knownWindows.delete(windowId);
    queuedTransfersByWindow.delete(windowId);

    const pendingForWindow = Array.from(pendingTransfers.values())
        .filter((transfer) => transfer.targetWindowId === windowId)
        .map((transfer) => transfer.transferId);

    for (const transferId of pendingForWindow) {
        finishTransfer(transferId, {
            success: false,
            error,
        });
    }
}

function announceCurrentWindow() {
    if (currentWindowId <= 0) {
        return;
    }

    postMessage({
        type: 'announce',
        windowId: currentWindowId,
        label: getCurrentWindowLabel(),
        ready: isCurrentWindowReady,
    });
}

function dispatchTransfer(transferId: string) {
    const pending = pendingTransfers.get(transferId);
    if (!pending) {
        return;
    }

    const targetWindow = knownWindows.get(pending.targetWindowId);
    if (!targetWindow?.ready) {
        queueTransferForWindow(pending.targetWindowId, transferId);
        return;
    }

    postMessage({
        type: 'transfer',
        transfer: pending.payload,
    });
}

function handleMessage(data: unknown) {
    if (!data || typeof data !== 'object' || !('type' in data)) {
        return;
    }

    const message = data as TBrowserWindowTabsMessage;
    if ('windowId' in message && message.windowId === currentWindowId) {
        return;
    }

    switch (message.type) {
        case 'discover':
            announceCurrentWindow();
            break;
        case 'announce':
            knownWindows.set(message.windowId, {
                label: message.label,
                ready: message.ready,
            });
            if (message.ready) {
                dispatchQueuedTransfers(message.windowId);
            }
            break;
        case 'unregister':
            markWindowUnavailable(
                message.windowId,
                'Target browser window closed before transfer completed.',
            );
            break;
        case 'transfer':
            if (
                message.transfer.targetWindowId !== currentWindowId
                || !isCurrentWindowReady
            ) {
                return;
            }

            incomingTransferListeners.forEach((listener) => {
                listener(message.transfer);
            });
            break;
        case 'ack':
            finishTransfer(message.ack.transferId, {
                success: message.ack.success,
                error: message.ack.error,
            });
            break;
    }
}

function registerCleanupHandlers() {
    if (cleanupRegistered || !hasBrowserWindowContext()) {
        return;
    }

    cleanupRegistered = true;
    window.addEventListener('beforeunload', () => {
        if (currentWindowId > 0) {
            postMessage({
                type: 'unregister',
                windowId: currentWindowId,
            });
        }
    });
    window.addEventListener('focus', () => {
        announceCurrentWindow();
    });
}

function initializeBrowserWindowTabs() {
    if (initialized || !hasBrowserWindowContext()) {
        return;
    }

    initialized = true;
    currentWindowId = resolveCurrentWindowId();
    knownWindows.set(currentWindowId, {
        label: getCurrentWindowLabel(),
        ready: isCurrentWindowReady,
    });
    ensureChannel();
    registerCleanupHandlers();
    announceCurrentWindow();
    postMessage({
        type: 'discover',
        windowId: currentWindowId,
    });
}

function updateKnownCurrentWindow() {
    if (currentWindowId <= 0) {
        return;
    }

    knownWindows.set(currentWindowId, {
        label: getCurrentWindowLabel(),
        ready: isCurrentWindowReady,
    });
}

function buildTransferWindowUrl(targetWindowId: number) {
    if (!hasBrowserWindowContext()) {
        return null;
    }

    const url = new URL(window.location.href);
    url.searchParams.set(WINDOW_ID_QUERY_PARAM, String(targetWindowId));
    return url.toString();
}

function openTargetWindow(targetWindowId: number) {
    if (!hasBrowserWindowContext()) {
        return false;
    }

    const url = buildTransferWindowUrl(targetWindowId);
    if (!url) {
        return false;
    }

    const opened = window.open(url, '_blank');
    return opened !== null;
}

function waitForDiscoverySettling() {
    return new Promise<void>((resolve) => {
        if (!hasBrowserWindowContext()) {
            resolve();
            return;
        }

        window.setTimeout(resolve, DISCOVERY_SETTLE_DELAY_MS);
    });
}

export function syncBrowserWindowTitle() {
    initializeBrowserWindowTabs();
    updateKnownCurrentWindow();
    announceCurrentWindow();
}

export const browserWindowTabsCapability: IWindowTabsCapability = {
    async transfer(request: IWindowTabTransferRequest) {
        initializeBrowserWindowTabs();
        if (!ensureChannel()) {
            return {
                transferId: '',
                success: false,
                targetWindowId:
                    request.target.kind === 'window'
                        ? request.target.windowId
                        : -1,
                error: 'Browser window transfer is unavailable in this runtime',
            };
        }

        const targetWindowId =
            request.target.kind === 'window'
                ? request.target.windowId
                : createWindowId();

        if (
            request.target.kind === 'new-window'
            && !openTargetWindow(targetWindowId)
        ) {
            return {
                transferId: '',
                success: false,
                targetWindowId,
                error: 'Browser blocked opening a new window for tab transfer.',
            };
        }

        const transferId = crypto.randomUUID();
        const payload: IWindowTabIncomingTransfer = {
            transferId,
            sourceWindowId: currentWindowId,
            targetWindowId,
            tab: request.tab,
            payload: request.payload,
        };

        return new Promise<IWindowTabTransferResult>((resolve) => {
            const timeoutHandle = setTimeout(() => {
                finishTransfer(transferId, {
                    success: false,
                    error: 'Transfer timed out while waiting for target acknowledgement.',
                });
            }, normalizeTimeout(request.timeoutMs));

            pendingTransfers.set(transferId, {
                transferId,
                targetWindowId,
                payload,
                resolve,
                timeoutHandle,
            });

            const targetWindow = knownWindows.get(targetWindowId);
            if (targetWindow?.ready) {
                dispatchTransfer(transferId);
                return;
            }

            queueTransferForWindow(targetWindowId, transferId);
            postMessage({
                type: 'discover',
                windowId: currentWindowId,
            });
        });
    },
    transferAck(ack: IWindowTabTransferAck) {
        initializeBrowserWindowTabs();
        postMessage({
            type: 'ack',
            windowId: currentWindowId,
            ack,
        });
        return Promise.resolve(true);
    },
    async listTargetWindows() {
        initializeBrowserWindowTabs();
        postMessage({
            type: 'discover',
            windowId: currentWindowId,
        });
        await waitForDiscoverySettling();

        return Array.from(knownWindows.entries())
            .filter(([
                windowId,
                windowInfo,
            ]) => (
                windowId !== currentWindowId && windowInfo.ready
            ))
            .map(([
                windowId,
                windowInfo,
            ]) => ({
                windowId,
                label: windowInfo.label,
            } satisfies IWindowTabTargetWindow))
            .sort((left, right) => left.label.localeCompare(right.label));
    },
    showContextMenu(_tabId: string) {
        return Promise.resolve();
    },
    onIncomingTransfer(callback) {
        initializeBrowserWindowTabs();
        incomingTransferListeners.add(callback);
        return () => {
            incomingTransferListeners.delete(callback);
        };
    },
    onWindowAction: noopUnsubscribe,
    async closeCurrentWindow() {
        if (!hasBrowserWindowContext()) {
            return false;
        }

        postMessage({
            type: 'unregister',
            windowId: currentWindowId,
        });
        window.close();
        return waitForBrowserWindowCloseAttempt();
    },
    notifyRendererReady() {
        initializeBrowserWindowTabs();
        isCurrentWindowReady = true;
        updateKnownCurrentWindow();
        announceCurrentWindow();
    },
    onMenuNewTab: noopUnsubscribe,
    onMenuCloseTab: noopUnsubscribe,
    onMenuSplitEditor: noopUnsubscribe,
    onMenuFocusEditorGroup: noopUnsubscribe,
    onMenuMoveTabToGroup: noopUnsubscribe,
    onMenuCopyTabToGroup: noopUnsubscribe,
};
