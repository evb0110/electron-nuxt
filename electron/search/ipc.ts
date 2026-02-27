import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    app,
    ipcMain,
    webContents,
} from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/logger';
import { resolveAllowedReadPath } from '@electron/utils/path-validator';
import { findWorkingCopyPathByOriginalPath } from '@electron/ipc/workingCopy';
import type {
    ISearchRequest,
    ISearchResponse,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/search/protocol';

interface IPendingSearchRequest {
    resolve: (response: ISearchResponse) => void;
    reject: (error: Error) => void;
}

interface ISenderSearchState {
    senderId: number;
    worker: Worker;
    activeRequestId: string | null;
    pendingByRequestId: Map<string, IPendingSearchRequest>;
    requestTimeouts: Map<string, NodeJS.Timeout>;
    idleCleanupTimer: NodeJS.Timeout | null;
    lastActivityAtMs: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('search-ipc');
const senderSearchStates = new Map<number, ISenderSearchState>();
const registeredSenderCleanup = new Set<number>();
let appCleanupRegistered = false;
const SEARCH_REQUEST_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const SEARCH_WORKER_MAX_ACTIVE = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_MAX_ACTIVE ?? '8', 10);
    if (!Number.isFinite(parsed)) {
        return 8;
    }
    return clamp(parsed, 1, 256);
})();
const SEARCH_WORKER_IDLE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS ?? `${60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 60 * 1000;
    }
    return parsed;
})();

type TSearchMatch = ISearchResponse['results'][number];

function assertNever(value: never): never {
    throw new Error(`Unhandled search worker message: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseSearchExcerpt(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.prefix !== 'boolean'
        || typeof value.suffix !== 'boolean'
        || typeof value.before !== 'string'
        || typeof value.match !== 'string'
        || typeof value.after !== 'string'
    ) {
        return null;
    }
    return {
        prefix: value.prefix,
        suffix: value.suffix,
        before: value.before,
        match: value.match,
        after: value.after,
    };
}

function parseSearchMatch(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    const excerpt = parseSearchExcerpt(value.excerpt);
    if (!excerpt) {
        return null;
    }
    if (
        !isFiniteNumber(value.pageNumber)
        || !isFiniteNumber(value.pageMatchIndex)
        || !isFiniteNumber(value.matchIndex)
        || !isFiniteNumber(value.startOffset)
        || !isFiniteNumber(value.endOffset)
    ) {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt,
    };
}

function parseSearchResponse(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }
    const results: TSearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = parseSearchMatch(result);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }
    return {
        results,
        truncated: value.truncated,
    };
}

function parseWorkerOutboundMessage(value: unknown): TSearchWorkerOutboundMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'progress':
            if (!isFiniteNumber(value.processed) || !isFiniteNumber(value.total)) {
                return null;
            }
            return {
                type: 'progress',
                requestId: value.requestId,
                processed: value.processed,
                total: value.total,
            };
        case 'complete': {
            const response = parseSearchResponse(value.response);
            if (!response) {
                return null;
            }
            return {
                type: 'complete',
                requestId: value.requestId,
                response,
            };
        }
        case 'cancelled':
            return {
                type: 'cancelled',
                requestId: value.requestId,
            };
        case 'error':
            if (typeof value.error !== 'string') {
                return null;
            }
            return {
                type: 'error',
                requestId: value.requestId,
                error: value.error,
            };
        default:
            return null;
    }
}

function getWorkerPath(): string {
    const defaultPath = join(__dirname, 'search-worker.js');
    if (!app?.isPackaged) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function sendSearchProgress(
    senderId: number,
    progress: {
        requestId: string;
        processed: number;
        total: number;
    },
) {
    const sender = webContents.fromId(senderId);
    if (!sender || sender.isDestroyed()) {
        return;
    }

    try {
        sender.send('pdf:search:progress', progress);
    } catch (err) {
        log.debug(`Failed to send search progress: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function markStateActivity(state: ISenderSearchState) {
    state.lastActivityAtMs = Date.now();
}

function isStateIdle(state: ISenderSearchState) {
    return !state.activeRequestId && state.pendingByRequestId.size === 0;
}

function clearIdleCleanupTimer(state: ISenderSearchState) {
    if (!state.idleCleanupTimer) {
        return;
    }

    clearTimeout(state.idleCleanupTimer);
    state.idleCleanupTimer = null;
}

function clearRequestTimeout(
    state: ISenderSearchState,
    requestId: string,
) {
    const timeout = state.requestTimeouts.get(requestId);
    if (!timeout) {
        return;
    }

    clearTimeout(timeout);
    state.requestTimeouts.delete(requestId);
}

function scheduleIdleCleanup(
    state: ISenderSearchState,
) {
    clearIdleCleanupTimer(state);
    if (!isStateIdle(state)) {
        return;
    }

    state.idleCleanupTimer = setTimeout(() => {
        const senderId = state.senderId;
        const currentState = senderSearchStates.get(senderId);
        if (currentState !== state) {
            return;
        }
        if (!isStateIdle(currentState)) {
            return;
        }
        log.info(`Search worker lifecycle: sender ${senderId} idle TTL elapsed; terminating worker`);
        cleanupSenderState(senderId, {
            terminateWorker: true,
            reason: 'Search worker idle timeout',
        });
    }, SEARCH_WORKER_IDLE_TTL_MS);
    state.idleCleanupTimer.unref?.();
    log.debug(`Search worker lifecycle: sender ${state.senderId} scheduled idle cleanup in ${SEARCH_WORKER_IDLE_TTL_MS}ms`);
}

function resolvePendingRequest(
    state: ISenderSearchState,
    requestId: string,
    response: ISearchResponse,
) {
    const pending = state.pendingByRequestId.get(requestId);
    if (!pending) {
        return;
    }

    clearRequestTimeout(state, requestId);
    markStateActivity(state);
    state.pendingByRequestId.delete(requestId);
    pending.resolve(response);
    scheduleIdleCleanup(state);
}

function rejectPendingRequest(
    state: ISenderSearchState,
    requestId: string,
    error: Error,
) {
    const pending = state.pendingByRequestId.get(requestId);
    if (!pending) {
        return;
    }

    clearRequestTimeout(state, requestId);
    markStateActivity(state);
    state.pendingByRequestId.delete(requestId);
    pending.reject(error);
    scheduleIdleCleanup(state);
}

function cleanupSenderState(
    senderId: number,
    options?: {
        terminateWorker?: boolean;
        reason?: string;
    },
) {
    const state = senderSearchStates.get(senderId);
    if (!state) {
        return;
    }

    log.info(`Search worker lifecycle: cleaning sender ${senderId} state (${options?.reason ?? 'Search worker stopped'})`);
    senderSearchStates.delete(senderId);
    clearIdleCleanupTimer(state);
    for (const timeout of state.requestTimeouts.values()) {
        clearTimeout(timeout);
    }
    state.requestTimeouts.clear();

    const reason = options?.reason ?? 'Search worker stopped';
    for (const pending of state.pendingByRequestId.values()) {
        pending.reject(new Error(reason));
    }
    state.pendingByRequestId.clear();
    state.activeRequestId = null;

    if (options?.terminateWorker !== false) {
        void state.worker.terminate().catch(() => {
            // Ignore worker cleanup errors
        });
    }
}

function cancelRequest(
    state: ISenderSearchState,
    requestId: string,
) {
    try {
        state.worker.postMessage({
            type: 'cancel',
            requestId,
        } satisfies TSearchWorkerInboundMessage);
    } catch {
        // Ignore send errors while cancelling
    }

    resolvePendingRequest(state, requestId, {
        results: [],
        truncated: false,
    });

    if (state.activeRequestId === requestId) {
        state.activeRequestId = null;
    }
}

function registerSenderCleanup(event: IpcMainInvokeEvent, senderId: number) {
    if (registeredSenderCleanup.has(senderId)) {
        return;
    }

    registeredSenderCleanup.add(senderId);
    const handleCleanup = () => {
        cleanupSenderState(senderId, {
            terminateWorker: true,
            reason: 'Renderer closed',
        });
        registeredSenderCleanup.delete(senderId);
    };
    event.sender.once('destroyed', handleCleanup);
    event.sender.once('render-process-gone', handleCleanup);
}

function handleWorkerMessage(
    state: ISenderSearchState,
    message: TSearchWorkerOutboundMessage,
) {
    const senderId = state.senderId;
    if (senderSearchStates.get(senderId) !== state) {
        return;
    }
    markStateActivity(state);

    switch (message.type) {
        case 'progress':
            sendSearchProgress(senderId, {
                requestId: message.requestId,
                processed: message.processed,
                total: message.total,
            });
            return;
        case 'complete':
            if (state.activeRequestId === message.requestId) {
                state.activeRequestId = null;
            }
            resolvePendingRequest(state, message.requestId, message.response);
            return;
        case 'cancelled':
            if (state.activeRequestId === message.requestId) {
                state.activeRequestId = null;
            }
            resolvePendingRequest(state, message.requestId, {
                results: [],
                truncated: false,
            });
            return;
        case 'error':
            if (state.activeRequestId === message.requestId) {
                state.activeRequestId = null;
            }
            rejectPendingRequest(state, message.requestId, new Error(message.error));
            return;
        default:
            assertNever(message);
    }
}

function createSenderSearchState(senderId: number): ISenderSearchState {
    const workerPath = getWorkerPath();
    const worker = new Worker(workerPath);
    const state: ISenderSearchState = {
        senderId,
        worker,
        activeRequestId: null,
        pendingByRequestId: new Map(),
        requestTimeouts: new Map(),
        idleCleanupTimer: null,
        lastActivityAtMs: Date.now(),
    };
    log.info(`Search worker lifecycle: created worker for sender ${senderId}`);

    worker.on('message', (message: unknown) => {
        const parsedMessage = parseWorkerOutboundMessage(message);
        if (!parsedMessage) {
            log.warn(`Search worker sent malformed message for sender ${state.senderId}`);
            return;
        }
        handleWorkerMessage(state, parsedMessage);
    });

    worker.on('error', (error: Error) => {
        const currentSenderId = state.senderId;
        log.error(`Search worker error for sender ${currentSenderId}: ${error.message}`);
        cleanupSenderState(currentSenderId, {
            terminateWorker: true,
            reason: `Search worker error: ${error.message}`,
        });
    });

    worker.on('exit', (code) => {
        const currentSenderId = state.senderId;
        const reason = code === 0
            ? 'Search worker exited'
            : `Search worker exited unexpectedly with code ${code}`;
        cleanupSenderState(currentSenderId, {
            terminateWorker: false,
            reason,
        });
    });

    scheduleIdleCleanup(state);
    return state;
}

function findReusableIdleState() {
    const idleStates = Array.from(senderSearchStates.values())
        .filter(state => isStateIdle(state))
        .sort((left, right) => left.lastActivityAtMs - right.lastActivityAtMs);
    return idleStates[0] ?? null;
}

function ensureSenderState(event: IpcMainInvokeEvent, senderId: number) {
    registerSenderCleanup(event, senderId);

    let state = senderSearchStates.get(senderId);
    if (state) {
        markStateActivity(state);
        clearIdleCleanupTimer(state);
        return state;
    }

    if (senderSearchStates.size >= SEARCH_WORKER_MAX_ACTIVE) {
        const reusableState = findReusableIdleState();
        if (reusableState) {
            const previousSenderId = reusableState.senderId;
            senderSearchStates.delete(previousSenderId);
            reusableState.senderId = senderId;
            markStateActivity(reusableState);
            clearIdleCleanupTimer(reusableState);
            senderSearchStates.set(senderId, reusableState);
            log.warn(
                `Search worker cap pressure: reusing idle worker from sender ${previousSenderId} for sender ${senderId} `
                + `(max active: ${SEARCH_WORKER_MAX_ACTIVE})`,
            );
            return reusableState;
        }

        log.warn(
            `Search worker cap pressure: rejecting sender ${senderId}; no idle workers available `
            + `(max active: ${SEARCH_WORKER_MAX_ACTIVE})`,
        );
        throw new Error(
            `Search worker limit reached (${SEARCH_WORKER_MAX_ACTIVE} active senders). `
            + 'Please retry shortly.',
        );
    }

    state = createSenderSearchState(senderId);
    senderSearchStates.set(senderId, state);
    log.info(
        `Search worker lifecycle: sender ${senderId} worker active `
        + `(${senderSearchStates.size}/${SEARCH_WORKER_MAX_ACTIVE})`,
    );
    return state;
}

export async function resolveSearchablePdfPath(pdfPath: string): Promise<string | null> {
    const directResolvedPath = await resolveAllowedReadPath(pdfPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(pdfPath);
    if (!mappedWorkingCopyPath) {
        return null;
    }

    return resolveAllowedReadPath(mappedWorkingCopyPath);
}

async function handlePdfSearch(
    event: IpcMainInvokeEvent,
    request: ISearchRequest,
): Promise<ISearchResponse> {
    const {
        pdfPath,
        query,
        pageCount,
    } = request;

    if (!query || query.trim().length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const normalizedPdfPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
    if (!normalizedPdfPath) {
        throw new Error('Invalid PDF path');
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath);
    if (!resolvedPdfPath) {
        throw new Error('Invalid PDF path: search only allowed within temp directory');
    }

    const senderId = event.sender.id;
    const state = ensureSenderState(event, senderId);
    const requestId = request.requestId?.trim()
        || `search-${randomUUID()}`;

    if (state.activeRequestId && state.activeRequestId !== requestId) {
        cancelRequest(state, state.activeRequestId);
    }

    state.activeRequestId = requestId;
    clearIdleCleanupTimer(state);

    return new Promise<ISearchResponse>((resolve, reject) => {
        state.pendingByRequestId.set(requestId, {
            resolve,
            reject,
        });
        const requestTimeout = setTimeout(() => {
            try {
                state.worker.postMessage({
                    type: 'cancel',
                    requestId,
                } satisfies TSearchWorkerInboundMessage);
            } catch {
                // Ignore cancellation transport errors when timing out.
            }

            if (state.activeRequestId === requestId) {
                state.activeRequestId = null;
            }
            rejectPendingRequest(
                state,
                requestId,
                new Error(`Search request timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`),
            );
        }, SEARCH_REQUEST_TIMEOUT_MS);
        requestTimeout.unref?.();
        state.requestTimeouts.set(requestId, requestTimeout);

        try {
            state.worker.postMessage({
                type: 'search',
                payload: {
                    requestId,
                    pdfPath: resolvedPdfPath,
                    query,
                    pageCount,
                },
            } satisfies TSearchWorkerInboundMessage);
        } catch (error) {
            clearRequestTimeout(state, requestId);
            state.pendingByRequestId.delete(requestId);
            if (state.activeRequestId === requestId) {
                state.activeRequestId = null;
            }
            reject(new Error(error instanceof Error ? error.message : String(error)));
            scheduleIdleCleanup(state);
        }
    });
}

function handlePdfSearchCancel(
    event: IpcMainInvokeEvent,
    requestId?: string,
) {
    const senderId = event.sender.id;
    const state = senderSearchStates.get(senderId);
    if (!state) {
        return { canceled: false };
    }

    const targetRequestId = requestId?.trim() || state.activeRequestId;
    if (!targetRequestId) {
        return { canceled: false };
    }

    cancelRequest(state, targetRequestId);
    return { canceled: true };
}

export function registerSearchHandlers() {
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${SEARCH_REQUEST_TIMEOUT_MS}, idleTtlMs=${SEARCH_WORKER_IDLE_TTL_MS}, maxActive=${SEARCH_WORKER_MAX_ACTIVE})`,
    );
    ipcMain.handle('pdf:search', handlePdfSearch);
    ipcMain.handle('pdf:search:cancel', handlePdfSearchCancel);
    ipcMain.handle('pdf:search:resetCache', () => {
        for (const state of senderSearchStates.values()) {
            try {
                state.worker.postMessage({type: 'reset-cache'} satisfies TSearchWorkerInboundMessage);
            } catch {
                // Ignore cache-reset failures
            }
        }
        return true;
    });

    if (!appCleanupRegistered) {
        appCleanupRegistered = true;
        app.on('before-quit', () => {
            for (const senderId of senderSearchStates.keys()) {
                cleanupSenderState(senderId, {
                    terminateWorker: true,
                    reason: 'App shutting down',
                });
            }
        });
    }
}
