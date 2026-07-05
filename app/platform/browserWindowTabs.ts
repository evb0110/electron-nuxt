import {isRecord} from '@contracts/runtimeGuards';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TSplitPayload,
} from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';

const WINDOW_TABS_CHANNEL = 'evb-viewer:browserWindowTabs';
const WINDOW_ID_QUERY_PARAM = 'evbWindowId';
const WINDOW_TABS_STATE_KEY = '__evbBrowserWindowTabsState';
const DEFAULT_TRANSFER_TIMEOUT_MS = 12_000;
const INCOMING_TRANSFER_NONCE_TTL_MS = 60_000;
const DISCOVERY_SETTLE_DELAY_MS = 60;
const FALLBACK_WINDOW_TITLE = 'EVB Viewer';
const CLOSE_CURRENT_WINDOW_TIMEOUT_MS = 150;
const TRANSFER_MESSAGE_SCHEMA_VERSION = 1;

type TIncomingTransferListener = (
    transfer: IWindowTabIncomingTransfer,
) => void;

interface IKnownBrowserWindow {
    label: string;
    lastSeenAt: number;
    ready: boolean;
}

interface IBrowserWindowTabsState {
    cleanupInstance?: () => void;
    instanceId?: symbol;
    windowId?: number;
}

interface IPendingBrowserTransfer {
    transferId: string;
    targetWindowId: number;
    nonce: string;
    payload: TBrowserTransferEnvelope;
    resolve: (result: IWindowTabTransferResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

interface IIncomingBrowserTransferNonce {
    nonce: string;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

type TBrowserTransferEnvelope = IWindowTabIncomingTransfer & {
    schemaVersion: typeof TRANSFER_MESSAGE_SCHEMA_VERSION;
    nonce: string;
};

type TBrowserTransferAckEnvelope = IWindowTabTransferAck & {
    schemaVersion: typeof TRANSFER_MESSAGE_SCHEMA_VERSION;
    nonce: string;
};

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
        transfer: TBrowserTransferEnvelope;
    }
    | {
        type: 'ack';
        windowId: number;
        ack: TBrowserTransferAckEnvelope;
    };

const incomingTransferListeners = new Set<TIncomingTransferListener>();
const knownWindows = new Map<number, IKnownBrowserWindow>();
const pendingTransfers = new Map<string, IPendingBrowserTransfer>();
const incomingTransferNonces = new Map<string, IIncomingBrowserTransferNonce>();
const queuedTransfersByWindow = new Map<number, string[]>();

const browserWindowTabsInstanceId = Symbol('browserWindowTabsInstance');

let channel: BroadcastChannel | null = null;
let initialized = false;
let currentWindowId = -1;
let isCurrentWindowReady = false;
let cleanupRegistered = false;

type TBrowserWindowTabsMessageHandlers = {
    [TType in TBrowserWindowTabsMessage['type']]: (
        message: Extract<
            TBrowserWindowTabsMessage,
            { type: TType }
        >,
    ) => void;
};


function isPositiveWindowId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
    return value === undefined || isNullableString(value);
}

function isTransferredTabState(value: unknown): value is IWindowTabIncomingTransfer['tab'] {
    return isRecord(value)
        && isNullableString(value.fileName)
        && isNullableString(value.originalPath)
        && isOptionalNullableString(value.documentInstanceId)
        && typeof value.isDirty === 'boolean'
        && typeof value.isDjvu === 'boolean';
}

function isSplitPayload(value: unknown): value is TSplitPayload {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        return false;
    }

    if (value.kind === 'empty') {
        return true;
    }

    if (value.kind === 'djvu') {
        return typeof value.sourcePath === 'string';
    }

    return value.kind === 'pdfSnapshot'
        && typeof value.fileName === 'string'
        && isNullableString(value.originalPath)
        && typeof value.snapshotPath === 'string'
        && typeof value.isDirty === 'boolean'
        && isOptionalPositiveInteger(value.currentPage)
        && isOptionalPositiveInteger(value.totalPages);
}

function isTransferSession(value: unknown): value is IWindowTabIncomingTransfer['session'] {
    return value === undefined
        || (
            isRecord(value)
            && typeof value.sessionId === 'string'
            && value.sessionId.trim().length > 0
            && isNonNegativeInteger(value.sessionRevision)
            && isNullableString(value.documentRef)
            && isOptionalNullableString(value.documentInstanceId)
            && (value.documentRevisionToken === undefined || typeof value.documentRevisionToken === 'string')
        );
}

function isBrowserTransferEnvelope(value: unknown): value is TBrowserTransferEnvelope {
    return isRecord(value)
        && value.schemaVersion === TRANSFER_MESSAGE_SCHEMA_VERSION
        && typeof value.nonce === 'string'
        && typeof value.transferId === 'string'
        && isPositiveWindowId(value.sourceWindowId)
        && isPositiveWindowId(value.targetWindowId)
        && isTransferredTabState(value.tab)
        && isSplitPayload(value.payload)
        && isTransferSession(value.session);
}

function isBrowserTransferAckEnvelope(value: unknown): value is TBrowserTransferAckEnvelope {
    return isRecord(value)
        && value.schemaVersion === TRANSFER_MESSAGE_SCHEMA_VERSION
        && typeof value.nonce === 'string'
        && typeof value.transferId === 'string'
        && typeof value.success === 'boolean'
        && (value.error === undefined || typeof value.error === 'string');
}

function parseBrowserWindowTabsMessage(data: unknown): TBrowserWindowTabsMessage | null {
    if (!isRecord(data) || typeof data.type !== 'string') {
        return null;
    }

    switch (data.type) {
        case 'discover':
            return isPositiveWindowId(data.windowId)
                ? {
                    type: 'discover',
                    windowId: data.windowId,
                }
                : null;
        case 'announce':
            return isPositiveWindowId(data.windowId)
                && typeof data.label === 'string'
                && typeof data.ready === 'boolean'
                ? {
                    type: 'announce',
                    windowId: data.windowId,
                    label: data.label,
                    ready: data.ready,
                }
                : null;
        case 'unregister':
            return isPositiveWindowId(data.windowId)
                ? {
                    type: 'unregister',
                    windowId: data.windowId,
                }
                : null;
        case 'transfer':
            return isBrowserTransferEnvelope(data.transfer)
                ? {
                    type: 'transfer',
                    transfer: data.transfer,
                }
                : null;
        case 'ack':
            return isPositiveWindowId(data.windowId) && isBrowserTransferAckEnvelope(data.ack)
                ? {
                    type: 'ack',
                    windowId: data.windowId,
                    ack: data.ack,
                }
                : null;
        default:
            return null;
    }
}

function noopUnsubscribe(): TMenuEventUnsubscribe {
    return () => {};
}

function hasBrowserWindowContext() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getBrowserWindowTabsState() {
    if (!hasBrowserWindowContext()) {
        return null;
    }

    const browserWindow = window as Window & {[WINDOW_TABS_STATE_KEY]?: IBrowserWindowTabsState;};
    browserWindow[WINDOW_TABS_STATE_KEY] ??= {};
    return browserWindow[WINDOW_TABS_STATE_KEY];
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

function createTransferNonce() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
            const state = getBrowserWindowTabsState();
            if (state) {
                state.windowId = fromQuery;
            }
            return fromQuery;
        }
    } catch (error) {
        BrowserLogger.warn(
            'browserWindowTabs',
            'Failed to resolve browser window ID from URL',
            error,
        );
    }

    const state = getBrowserWindowTabsState();
    if (isPositiveWindowId(state?.windowId)) {
        return state.windowId;
    }

    const windowId = createWindowId();
    if (state) {
        state.windowId = windowId;
    }
    return windowId;
}

function ensureChannel() {
    if (channel || !hasBrowserWindowContext()) {
        return channel;
    }

    if (typeof BroadcastChannel === 'undefined') {
        return null;
    }

    channel = new BroadcastChannel(WINDOW_TABS_CHANNEL);
    channel.addEventListener('message', handleChannelMessage);
    return channel;
}

function handleChannelMessage(event: MessageEvent<unknown>) {
    handleMessage(event.data);
}

function cleanupChannel() {
    if (!channel) {
        return;
    }

    channel.removeEventListener('message', handleChannelMessage);
    channel.close();
    channel = null;
}

function cleanupBrowserWindowTabsInstance(unregister: boolean) {
    if (unregister && currentWindowId > 0) {
        postMessage({
            type: 'unregister',
            windowId: currentWindowId,
        });
    }

    if (hasBrowserWindowContext() && cleanupRegistered) {
        window.removeEventListener('beforeunload', handleWindowBeforeUnload);
        window.removeEventListener('focus', handleWindowFocus);
    }
    cleanupRegistered = false;
    cleanupChannel();
    clearIncomingTransferNonces();

    const state = getBrowserWindowTabsState();
    if (state?.instanceId === browserWindowTabsInstanceId) {
        delete state.cleanupInstance;
    }
}

function claimBrowserWindowTabsInstance() {
    const state = getBrowserWindowTabsState();
    if (!state || state.instanceId === browserWindowTabsInstanceId) {
        return;
    }

    state.cleanupInstance?.();
    state.instanceId = browserWindowTabsInstanceId;
    delete state.cleanupInstance;
}

function rememberBrowserWindowTabsInstance() {
    const state = getBrowserWindowTabsState();
    if (!state || state.instanceId !== browserWindowTabsInstanceId) {
        return;
    }

    state.cleanupInstance = () => cleanupBrowserWindowTabsInstance(true);
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

function forgetIncomingTransferNonce(transferId: string) {
    const entry = incomingTransferNonces.get(transferId);
    if (!entry) {
        return;
    }

    clearTimeout(entry.timeoutHandle);
    incomingTransferNonces.delete(transferId);
}

function rememberIncomingTransferNonce(transferId: string, nonce: string) {
    forgetIncomingTransferNonce(transferId);
    const timeoutHandle = setTimeout(() => {
        const currentEntry = incomingTransferNonces.get(transferId);
        if (currentEntry?.timeoutHandle === timeoutHandle) {
            incomingTransferNonces.delete(transferId);
        }
    }, INCOMING_TRANSFER_NONCE_TTL_MS);
    incomingTransferNonces.set(transferId, {
        nonce,
        timeoutHandle,
    });
}

function clearIncomingTransferNonces() {
    incomingTransferNonces.forEach((entry) => {
        clearTimeout(entry.timeoutHandle);
    });
    incomingTransferNonces.clear();
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

function shouldIgnoreBrowserWindowTabsMessage(message: TBrowserWindowTabsMessage) {
    return 'windowId' in message && message.windowId === currentWindowId;
}

function handleWindowAnnouncement(message: Extract<TBrowserWindowTabsMessage, { type: 'announce' }>) {
    knownWindows.set(message.windowId, {
        label: message.label,
        lastSeenAt: Date.now(),
        ready: message.ready,
    });
    if (message.ready) {
        dispatchQueuedTransfers(message.windowId);
    }
}

function handleIncomingTransferMessage(message: Extract<TBrowserWindowTabsMessage, { type: 'transfer' }>) {
    if (
        message.transfer.schemaVersion !== TRANSFER_MESSAGE_SCHEMA_VERSION
        || !message.transfer.nonce
        || message.transfer.targetWindowId !== currentWindowId
        || !isCurrentWindowReady
    ) {
        return;
    }

    rememberIncomingTransferNonce(
        message.transfer.transferId,
        message.transfer.nonce,
    );
    incomingTransferListeners.forEach((listener) => {
        listener(message.transfer);
    });
}

function handleTransferAckMessage(message: Extract<TBrowserWindowTabsMessage, { type: 'ack' }>) {
    const pending = pendingTransfers.get(message.ack.transferId);
    if (
        !pending
        || message.windowId !== pending.targetWindowId
        || message.ack.schemaVersion !== TRANSFER_MESSAGE_SCHEMA_VERSION
        || message.ack.nonce !== pending.nonce
    ) {
        return;
    }

    finishTransfer(message.ack.transferId, {
        success: message.ack.success,
        ...(message.ack.error ? { error: message.ack.error } : {}),
    });
}

const browserWindowTabsMessageHandlers: TBrowserWindowTabsMessageHandlers = {
    discover: () => {
        announceCurrentWindow();
    },
    announce: handleWindowAnnouncement,
    unregister: (message) => {
        markWindowUnavailable(
            message.windowId,
            'Target browser window closed before transfer completed.',
        );
    },
    transfer: handleIncomingTransferMessage,
    ack: handleTransferAckMessage,
};

function handleMessage(data: unknown) {
    const message = parseBrowserWindowTabsMessage(data);
    if (!message) {
        return;
    }
    if (shouldIgnoreBrowserWindowTabsMessage(message)) {
        return;
    }

    switch (message.type) {
        case 'discover':
            browserWindowTabsMessageHandlers.discover(message);
            break;
        case 'announce':
            browserWindowTabsMessageHandlers.announce(message);
            break;
        case 'unregister':
            browserWindowTabsMessageHandlers.unregister(message);
            break;
        case 'transfer':
            browserWindowTabsMessageHandlers.transfer(message);
            break;
        case 'ack':
            browserWindowTabsMessageHandlers.ack(message);
            break;
    }
}

function registerCleanupHandlers() {
    if (cleanupRegistered || !hasBrowserWindowContext()) {
        return;
    }

    cleanupRegistered = true;
    window.addEventListener('beforeunload', handleWindowBeforeUnload);
    window.addEventListener('focus', handleWindowFocus);
}

function handleWindowBeforeUnload() {
    cleanupBrowserWindowTabsInstance(true);
}

function handleWindowFocus() {
    announceCurrentWindow();
}

function initializeBrowserWindowTabs() {
    if (initialized || !hasBrowserWindowContext()) {
        return;
    }

    claimBrowserWindowTabsInstance();
    initialized = true;
    currentWindowId = resolveCurrentWindowId();
    knownWindows.set(currentWindowId, {
        label: getCurrentWindowLabel(),
        lastSeenAt: Date.now(),
        ready: isCurrentWindowReady,
    });
    rememberBrowserWindowTabsInstance();
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
        lastSeenAt: Date.now(),
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

function pruneStaleTargetWindows(discoveryStartedAt: number) {
    for (const [
        windowId,
        windowInfo,
    ] of knownWindows) {
        if (windowId !== currentWindowId && windowInfo.lastSeenAt < discoveryStartedAt) {
            knownWindows.delete(windowId);
        }
    }
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

        const transferId = createTransferNonce();
        const nonce = createTransferNonce();
        const payload: TBrowserTransferEnvelope = {
            transferId,
            sourceWindowId: currentWindowId,
            targetWindowId,
            tab: request.tab,
            payload: request.payload,
            ...(request.session === undefined ? {} : {session: request.session}),
            schemaVersion: TRANSFER_MESSAGE_SCHEMA_VERSION,
            nonce,
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
                nonce,
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
        const nonceEntry = incomingTransferNonces.get(ack.transferId);
        if (!nonceEntry) {
            return Promise.resolve(false);
        }

        forgetIncomingTransferNonce(ack.transferId);
        postMessage({
            type: 'ack',
            windowId: currentWindowId,
            ack: {
                ...ack,
                schemaVersion: TRANSFER_MESSAGE_SCHEMA_VERSION,
                nonce: nonceEntry.nonce,
            },
        });
        return Promise.resolve(true);
    },
    async listTargetWindows() {
        initializeBrowserWindowTabs();
        const discoveryStartedAt = Date.now();
        postMessage({
            type: 'discover',
            windowId: currentWindowId,
        });
        await waitForDiscoverySettling();
        pruneStaleTargetWindows(discoveryStartedAt);

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
    claimPendingExternalOpenPaths() {
        return Promise.resolve([]);
    },
    acknowledgePendingExternalOpenPaths() {
        return Promise.resolve();
    },
    onMenuNewTab: noopUnsubscribe,
    onMenuCloseTab: noopUnsubscribe,
    onMenuSplitEditor: noopUnsubscribe,
    onMenuFocusEditorPane: noopUnsubscribe,
    onMenuMoveTabToPane: noopUnsubscribe,
    onMenuCopyTabToPane: noopUnsubscribe,
};
