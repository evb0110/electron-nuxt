import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'crypto';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentRendererAck,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    TAgentCommand,
    TAgentRendererAckReason,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import { getErrorMessage } from '@electron/utils/error';

const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 2500;

interface ICachedWorkspaceSnapshot {
    revision: number;
    snapshot: IAgentWorkspaceSnapshot;
}

interface IPendingRequest<TResponse> {
    windowId: number;
    timeout: NodeJS.Timeout;
    cleanupLifecycle: () => void;
    resolve(response: TResponse): void;
    reject(error: Error): void;
}

const pendingSnapshotRequests = new Map<string, IPendingRequest<IAgentWorkspaceSnapshot>>();
const pendingCommandRequests = new Map<string, IPendingRequest<Record<string, unknown>>>();
const snapshotCacheByWindowId = new Map<number, ICachedWorkspaceSnapshot>();

function rejectPendingRequest<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    error: Error,
) {
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return;
    }

    clearTimeout(pending.timeout);
    pending.cleanupLifecycle();
    pendingMap.delete(requestId);
    pending.reject(error);
}

function resolvePendingRequest<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    response: TResponse,
) {
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return false;
    }

    clearTimeout(pending.timeout);
    pending.cleanupLifecycle();
    pendingMap.delete(requestId);
    pending.resolve(response);
    return true;
}

function createTargetWindowLifecycleCleanup<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    window: BrowserWindow,
    onLifecycleReject?: () => void,
) {
    const rejectForLifecycle = (reason: string) => {
        onLifecycleReject?.();
        rejectPendingRequest(
            pendingMap,
            requestId,
            new Error(`Agent renderer request was canceled because the target window ${reason}.`),
        );
    };
    const handleClosed = () => rejectForLifecycle('closed');
    const handleRenderGone = () => rejectForLifecycle('renderer exited');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            rejectForLifecycle('navigated');
        }
    };

    window.once('closed', handleClosed);
    window.webContents.once('render-process-gone', handleRenderGone);
    window.webContents.on('did-start-navigation', handleNavigation);

    return () => {
        window.removeListener('closed', handleClosed);
        window.webContents.removeListener('render-process-gone', handleRenderGone);
        window.webContents.removeListener('did-start-navigation', handleNavigation);
    };
}

function createPendingRequest<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    window: BrowserWindow,
    timeoutMs: number,
    onLifecycleReject?: () => void,
) {
    return new Promise<TResponse>((resolve, reject) => {
        const cleanupLifecycle = createTargetWindowLifecycleCleanup(
            pendingMap,
            requestId,
            window,
            onLifecycleReject,
        );
        const timeout = setTimeout(() => {
            rejectPendingRequest(
                pendingMap,
                requestId,
                new Error(`Agent renderer request timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);

        pendingMap.set(requestId, {
            windowId: window.id,
            timeout,
            cleanupLifecycle,
            resolve,
            reject,
        });
    });
}

function assertUsableTargetWindow(window: BrowserWindow | null | undefined) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error('No live renderer window is available for the agent request.');
    }
    return window;
}

function getResponseSenderWindowId(event: IpcMainInvokeEvent) {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    return sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow.id : null;
}

function rejectRendererAck(reason: TAgentRendererAckReason): IAgentRendererAck {
    return {
        accepted: false,
        reason,
    };
}

function acceptRendererAck(): IAgentRendererAck {
    return { accepted: true };
}

function getRejectedAckForUnexpectedResponse<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    senderWindowId: number | null,
): IAgentRendererAck | null {
    if (senderWindowId === null) {
        return rejectRendererAck('unexpected-sender');
    }
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return rejectRendererAck('unknown-request');
    }
    if (pending.windowId !== senderWindowId) {
        return rejectRendererAck('unexpected-sender');
    }
    return null;
}

function normalizeResponseError(response: { error?: string }) {
    const message = response.error?.trim();
    return message && message.length > 0 ? message : 'Agent renderer request failed.';
}

function isValidSnapshotResponse(response: unknown): response is IAgentWorkspaceSnapshotResponse {
    return isRecord(response)
        && typeof response.requestId === 'string'
        && response.requestId.trim().length > 0
        && typeof response.ok === 'boolean'
        && (response.windowId === undefined || typeof response.windowId === 'number')
        && (response.revision === undefined || (
            typeof response.revision === 'number'
            && Number.isInteger(response.revision)
            && response.revision >= 0
        ))
        && (response.unchanged === undefined || typeof response.unchanged === 'boolean')
        && (response.snapshot === undefined || isRecord(response.snapshot))
        && (response.error === undefined || typeof response.error === 'string');
}

function isValidCommandResponse(response: unknown): response is IAgentCommandResponse {
    return isRecord(response)
        && typeof response.requestId === 'string'
        && response.requestId.trim().length > 0
        && typeof response.ok === 'boolean'
        && (response.windowId === undefined || typeof response.windowId === 'number')
        && (response.error === undefined || typeof response.error === 'string')
        && (response.result === undefined || isRecord(response.result));
}

export function requestAgentWorkspaceSnapshot(
    targetWindow: BrowserWindow | null | undefined,
    timeoutMs = DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
) {
    const window = assertUsableTargetWindow(targetWindow);
    const requestId = randomUUID();
    const cachedSnapshot = snapshotCacheByWindowId.get(window.id);
    const request: IAgentWorkspaceSnapshotRequest = {
        requestId,
        windowId: window.id,
        ...(cachedSnapshot === undefined ? {} : { lastSeenRevision: cachedSnapshot.revision }),
    };
    const pending = createPendingRequest(
        pendingSnapshotRequests,
        requestId,
        window,
        timeoutMs,
        () => snapshotCacheByWindowId.delete(window.id),
    );

    try {
        window.webContents.send(CORE_IPC_EVENT_CHANNELS.agentWorkspaceSnapshotRequest, request);
    } catch (error) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            requestId,
            new Error(`Failed to send agent workspace snapshot request: ${getErrorMessage(error)}`),
        );
    }

    return pending;
}

export function requestAgentCommand(
    targetWindow: BrowserWindow | null | undefined,
    command: TAgentCommand,
    timeoutMs = DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
) {
    const window = assertUsableTargetWindow(targetWindow);
    const requestId = randomUUID();
    const request: IAgentCommandRequest = {
        requestId,
        windowId: window.id,
        command,
    };
    const pending = createPendingRequest(
        pendingCommandRequests,
        requestId,
        window,
        timeoutMs,
    );

    try {
        window.webContents.send(CORE_IPC_EVENT_CHANNELS.agentCommandRequest, request);
    } catch (error) {
        rejectPendingRequest(
            pendingCommandRequests,
            requestId,
            new Error(`Failed to send agent command request: ${getErrorMessage(error)}`),
        );
    }

    return pending;
}

export function submitAgentWorkspaceSnapshotResponse(
    event: IpcMainInvokeEvent,
    rawResponse: unknown,
) {
    if (!isValidSnapshotResponse(rawResponse)) {
        return rejectRendererAck('invalid-payload');
    }

    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingSnapshotRequests,
        rawResponse.requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return rejectedAck;
    }
    const pending = pendingSnapshotRequests.get(rawResponse.requestId);
    if (!pending) {
        return rejectRendererAck('unknown-request');
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return acceptRendererAck();
    }

    if (rawResponse.unchanged === true) {
        const cachedSnapshot = snapshotCacheByWindowId.get(pending.windowId);
        if (!cachedSnapshot) {
            rejectPendingRequest(
                pendingSnapshotRequests,
                rawResponse.requestId,
                new Error('Agent workspace snapshot response was unchanged but no cached snapshot is available.'),
            );
            return acceptRendererAck();
        }
        if (
            rawResponse.revision !== undefined
            && rawResponse.revision !== cachedSnapshot.revision
        ) {
            rejectPendingRequest(
                pendingSnapshotRequests,
                rawResponse.requestId,
                new Error('Agent workspace snapshot response revision did not match the cached snapshot.'),
            );
            return acceptRendererAck();
        }
        resolvePendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            cachedSnapshot.snapshot,
        );
        return acceptRendererAck();
    }

    if (!rawResponse.snapshot) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error('Agent workspace snapshot response did not include a snapshot.'),
        );
        return acceptRendererAck();
    }

    const previousRevision = snapshotCacheByWindowId.get(pending.windowId)?.revision ?? 0;
    snapshotCacheByWindowId.set(pending.windowId, {
        revision: rawResponse.revision ?? previousRevision + 1,
        snapshot: rawResponse.snapshot,
    });
    resolvePendingRequest(
        pendingSnapshotRequests,
        rawResponse.requestId,
        rawResponse.snapshot,
    );
    return acceptRendererAck();
}

export function submitAgentCommandResponse(
    event: IpcMainInvokeEvent,
    rawResponse: unknown,
) {
    if (!isValidCommandResponse(rawResponse)) {
        return rejectRendererAck('invalid-payload');
    }

    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingCommandRequests,
        rawResponse.requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return rejectedAck;
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingCommandRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return acceptRendererAck();
    }

    resolvePendingRequest(
        pendingCommandRequests,
        rawResponse.requestId,
        rawResponse.result ?? {},
    );
    return acceptRendererAck();
}
