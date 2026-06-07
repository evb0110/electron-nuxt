import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'crypto';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotResponse,
    TAgentCommand,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import { getErrorMessage } from '@electron/utils/error';

const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 2500;

interface IPendingRequest<TResponse> {
    windowId: number;
    timeout: NodeJS.Timeout;
    resolve(response: TResponse): void;
    reject(error: Error): void;
}

const pendingSnapshotRequests = new Map<string, IPendingRequest<IAgentWorkspaceSnapshot>>();
const pendingCommandRequests = new Map<string, IPendingRequest<Record<string, unknown>>>();

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
    pendingMap.delete(requestId);
    pending.resolve(response);
    return true;
}

function createPendingRequest<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    windowId: number,
    timeoutMs: number,
) {
    return new Promise<TResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
            rejectPendingRequest(
                pendingMap,
                requestId,
                new Error(`Agent renderer request timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);

        pendingMap.set(requestId, {
            windowId,
            timeout,
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

function isExpectedResponseSender<TResponse>(
    pendingMap: Map<string, IPendingRequest<TResponse>>,
    requestId: string,
    senderWindowId: number | null,
) {
    if (senderWindowId === null) {
        return false;
    }

    const pending = pendingMap.get(requestId);
    return Boolean(pending && pending.windowId === senderWindowId);
}

function normalizeResponseError(response: { error?: string }) {
    return response.error?.trim() || 'Agent renderer request failed.';
}

function isValidSnapshotResponse(response: unknown): response is IAgentWorkspaceSnapshotResponse {
    return isRecord(response)
        && typeof response.requestId === 'string'
        && response.requestId.trim().length > 0
        && typeof response.ok === 'boolean'
        && (response.windowId === undefined || typeof response.windowId === 'number')
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
    const request = {
        requestId,
        windowId: window.id,
    };
    const pending = createPendingRequest(
        pendingSnapshotRequests,
        requestId,
        window.id,
        timeoutMs,
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
        window.id,
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
        return false;
    }

    const senderWindowId = getResponseSenderWindowId(event);
    if (!isExpectedResponseSender(
        pendingSnapshotRequests,
        rawResponse.requestId,
        senderWindowId,
    )) {
        return false;
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return true;
    }

    if (!rawResponse.snapshot) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error('Agent workspace snapshot response did not include a snapshot.'),
        );
        return true;
    }

    return resolvePendingRequest(
        pendingSnapshotRequests,
        rawResponse.requestId,
        rawResponse.snapshot,
    );
}

export function submitAgentCommandResponse(
    event: IpcMainInvokeEvent,
    rawResponse: unknown,
) {
    if (!isValidCommandResponse(rawResponse)) {
        return false;
    }

    const senderWindowId = getResponseSenderWindowId(event);
    if (!isExpectedResponseSender(
        pendingCommandRequests,
        rawResponse.requestId,
        senderWindowId,
    )) {
        return false;
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingCommandRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return true;
    }

    return resolvePendingRequest(
        pendingCommandRequests,
        rawResponse.requestId,
        rawResponse.result ?? {},
    );
}
