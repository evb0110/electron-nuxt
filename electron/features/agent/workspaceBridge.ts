import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'crypto';
import type {
    IAgentDocumentReference,
    IAgentDocumentReadiness,
    IAgentDocumentRecommendation,
    IAgentDocumentOcrState,
    IAgentPaneSnapshot,
    IAgentRecentFileSnapshot,
    IAgentTabSnapshot,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentRendererAck,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSummary,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    TAgentCommand,
    TAgentDocumentKind,
    TAgentDocumentReadinessStatus,
    TAgentOcrCoverageStatus,
    TAgentRecommendationId,
    TAgentWorkspaceMode,
    TAgentRendererAckReason,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type { TEditorLayoutNode } from '@contracts/editorPanes';
import {
    sendAgentCommandRequest,
    sendAgentWorkspaceSnapshotRequest,
} from '@electron/features/agent/main/agentRendererEvents';
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

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isAgentDocumentKind(value: unknown): value is TAgentDocumentKind {
    return value === 'empty'
        || value === 'pdf'
        || value === 'djvu'
        || value === 'image'
        || value === 'unknown';
}

function isDocumentReadinessStatus(value: unknown): value is TAgentDocumentReadinessStatus {
    return value === 'ready'
        || value === 'needs-preparation'
        || value === 'unknown'
        || value === 'empty';
}

function isOcrCoverageStatus(value: unknown): value is TAgentOcrCoverageStatus {
    return value === 'complete'
        || value === 'partial'
        || value === 'none'
        || value === 'unknown';
}

function isAgentRecommendationId(value: unknown): value is TAgentRecommendationId {
    return value === 'convert_to_pdf' || value === 'ocr_all_pages';
}

function isWorkspaceMode(value: unknown): value is TAgentWorkspaceMode {
    return value === 'empty-workspace'
        || value === 'open-document'
        || value === 'documents-open-no-active-document';
}

function isDocumentReference(value: unknown): value is IAgentDocumentReference {
    return isRecord(value)
        && typeof value.tabId === 'string'
        && isNullableString(value.paneId)
        && isNullableString(value.fileName)
        && isNullableString(value.originalPath)
        && isAgentDocumentKind(value.kind);
}

function isWorkspaceSummary(value: unknown): value is IAgentWorkspaceSummary {
    return isRecord(value)
        && isWorkspaceMode(value.mode)
        && (value.activeDocument === null || isDocumentReference(value.activeDocument))
        && isNonNegativeInteger(value.documentCount)
        && isNonNegativeInteger(value.recentFileCount)
        && typeof value.recentFilesResolved === 'boolean';
}

function isAgentPaneSnapshot(value: unknown): value is IAgentPaneSnapshot {
    return isRecord(value)
        && typeof value.paneId === 'string'
        && isStringArray(value.tabIds)
        && isNullableString(value.activeTabId);
}

function isAgentDocumentOcrState(value: unknown): value is IAgentDocumentOcrState {
    return isRecord(value)
        && isOcrCoverageStatus(value.status)
        && isNonNegativeInteger(value.pageCount)
        && (value.textPageCount === undefined || isNonNegativeInteger(value.textPageCount))
        && (
            value.missingTextPages === undefined
            || (Array.isArray(value.missingTextPages) && value.missingTextPages.every(isNonNegativeInteger))
        )
        && isOptionalFiniteNumber(value.coverage);
}

function isAgentDocumentRecommendation(value: unknown): value is IAgentDocumentRecommendation {
    return isRecord(value)
        && isAgentRecommendationId(value.id)
        && typeof value.title === 'string'
        && typeof value.reason === 'string'
        && (value.toolName === undefined || typeof value.toolName === 'string');
}

function isAgentDocumentReadiness(value: unknown): value is IAgentDocumentReadiness {
    return isRecord(value)
        && isDocumentReadinessStatus(value.status)
        && isStringArray(value.reasons)
        && (value.ocr === undefined || isAgentDocumentOcrState(value.ocr))
        && Array.isArray(value.recommendations)
        && value.recommendations.every(isAgentDocumentRecommendation);
}

function isAgentTabSnapshot(value: unknown): value is IAgentTabSnapshot {
    return isRecord(value)
        && typeof value.tabId === 'string'
        && isNullableString(value.paneId)
        && isNullableString(value.fileName)
        && isNullableString(value.originalPath)
        && typeof value.isDirty === 'boolean'
        && isAgentDocumentKind(value.kind)
        && typeof value.workspaceAttached === 'boolean'
        && typeof value.hasPdf === 'boolean'
        && typeof value.isDjvu === 'boolean'
        && typeof value.isOpeningDocument === 'boolean'
        && typeof value.hasOpenError === 'boolean'
        && isNullableFiniteNumber(value.currentPage)
        && isNullableFiniteNumber(value.totalPages)
        && isAgentDocumentReadiness(value.readiness);
}

function isAgentRecentFileSnapshot(value: unknown): value is IAgentRecentFileSnapshot {
    return isRecord(value)
        && typeof value.fileName === 'string'
        && typeof value.originalPath === 'string'
        && isAgentDocumentKind(value.kind)
        && typeof value.openedAt === 'string'
        && (value.fileSize === undefined || isNonNegativeInteger(value.fileSize));
}

function isEditorLayoutNode(value: unknown, depth = 0): value is TEditorLayoutNode | null {
    if (value === null) {
        return true;
    }
    if (depth > 64 || !isRecord(value)) {
        return false;
    }
    if (value.type === 'leaf') {
        return typeof value.paneId === 'string';
    }
    return value.type === 'split'
        && typeof value.id === 'string'
        && (value.orientation === 'horizontal' || value.orientation === 'vertical')
        && typeof value.ratio === 'number'
        && Number.isFinite(value.ratio)
        && isEditorLayoutNode(value.first, depth + 1)
        && isEditorLayoutNode(value.second, depth + 1);
}

function isAgentWorkspaceSnapshot(value: unknown): value is IAgentWorkspaceSnapshot {
    return isRecord(value)
        && typeof value.capturedAt === 'string'
        && isNullableString(value.activePaneId)
        && isNullableString(value.activeTabId)
        && isWorkspaceSummary(value.summary)
        && Array.isArray(value.panes)
        && value.panes.every(isAgentPaneSnapshot)
        && Array.isArray(value.tabs)
        && value.tabs.every(isAgentTabSnapshot)
        && Array.isArray(value.recentFiles)
        && value.recentFiles.every(isAgentRecentFileSnapshot)
        && isEditorLayoutNode(value.layout);
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
        && (response.snapshot === undefined || isAgentWorkspaceSnapshot(response.snapshot))
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

function rejectPendingInvalidSnapshotResponse(
    event: IpcMainInvokeEvent,
    rawResponse: unknown,
) {
    if (!isRecord(rawResponse) || typeof rawResponse.requestId !== 'string' || rawResponse.requestId.trim().length === 0) {
        return;
    }

    const requestId = rawResponse.requestId;
    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingSnapshotRequests,
        requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return;
    }

    rejectPendingRequest(
        pendingSnapshotRequests,
        requestId,
        new Error('Agent workspace snapshot response did not match the expected contract.'),
    );
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
        sendAgentWorkspaceSnapshotRequest(window, request);
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
        sendAgentCommandRequest(window, request);
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
        rejectPendingInvalidSnapshotResponse(event, rawResponse);
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
