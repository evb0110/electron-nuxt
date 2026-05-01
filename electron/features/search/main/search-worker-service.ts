import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { webContents } from 'electron';
import { Worker } from 'worker_threads';
import { clamp } from 'es-toolkit/math';
import { withTimeout } from 'es-toolkit/promise';
import { SEARCH_EVENT_CHANNELS } from '@electron/features/search/contract';
import type {
    ISearchResponse,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/features/search/protocol';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/logger';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/worker-message';

interface IPendingSearchRequest {
    resolve: (response: ISearchResponse) => void;
    reject: (error: Error) => void;
}

type TPendingSearchSettler = (pending: IPendingSearchRequest) => void;

interface ISenderSearchState {
    senderId: number;
    worker: Worker;
    activeRequestId: string | null;
    pendingByRequestId: Map<string, IPendingSearchRequest>;
    requestTimeouts: Map<string, NodeJS.Timeout>;
    idleCleanupTimer: NodeJS.Timeout | null;
    lastActivityAtMs: number;
}

interface IDispatchSearchRequestPayload {
    resolvedPdfPath: string;
    query: string;
    pageCount?: number;
    requestId?: string;
    warmup?: boolean;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    requestIdPrefix: string;
}

type TSearchMatch = ISearchResponse['results'][number];

const log = createLogger('search-ipc');

const SEARCH_REQUEST_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const SEARCH_WORKER_MAX_ACTIVE = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_MAX_ACTIVE ?? '2', 10);
    if (!Number.isFinite(parsed)) {
        return 2;
    }
    return clamp(parsed, 1, 256);
})();
const SEARCH_WORKER_IDLE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS ?? `${30 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 30 * 1000;
    }
    return parsed;
})();
const SEARCH_WORKER_TERMINATE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS ?? '10_000', 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 10_000;
    }
    return parsed;
})();

function parseSearchExcerpt(value: unknown) {
    if (!isWorkerMessageRecord(value)) {
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
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    const excerpt = parseSearchExcerpt(value.excerpt);
    if (!excerpt) {
        return null;
    }
    if (
        !isFiniteWorkerMessageNumber(value.pageNumber)
        || !isFiniteWorkerMessageNumber(value.pageMatchIndex)
        || !isFiniteWorkerMessageNumber(value.matchIndex)
        || !isFiniteWorkerMessageNumber(value.startOffset)
        || !isFiniteWorkerMessageNumber(value.endOffset)
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
    if (!isWorkerMessageRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
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
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'progress':
            if (!isFiniteWorkerMessageNumber(value.processed) || !isFiniteWorkerMessageNumber(value.total)) {
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

export function getSearchWorkerServiceConfig() {
    return {
        requestTimeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
        idleTtlMs: SEARCH_WORKER_IDLE_TTL_MS,
        maxActive: SEARCH_WORKER_MAX_ACTIVE,
    };
}

export class SearchWorkerService {
    private readonly senderSearchStates = new Map<number, ISenderSearchState>();
    private readonly registeredSenderCleanup = new Set<number>();
    private readonly workerTerminationPromises = new Map<number, Promise<void>>();

    constructor(private readonly resolveWorkerPath: () => string) {}

    dispatchSearchRequest(
        event: IpcMainInvokeEvent,
        payload: IDispatchSearchRequestPayload,
    ): Promise<ISearchResponse> {
        const senderId = event.sender.id;
        const state = this.ensureSenderState(event, senderId);
        const requestId = payload.requestId
            || `${payload.requestIdPrefix}-${randomUUID()}`;
        if (state.pendingByRequestId.has(requestId)) {
            throw new Error(`Search request with id "${requestId}" is already in progress`);
        }

        if (state.activeRequestId && state.activeRequestId !== requestId) {
            this.cancelRequest(state, state.activeRequestId);
        }

        state.activeRequestId = requestId;
        this.clearIdleCleanupTimer(state);

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
                this.rejectPendingRequest(
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
                        pdfPath: payload.resolvedPdfPath,
                        query: payload.query,
                        pageCount: payload.pageCount,
                        warmup: payload.warmup,
                        matchCase: payload.matchCase,
                        wholeWord: payload.wholeWord,
                        useRegex: payload.useRegex,
                    },
                } satisfies TSearchWorkerInboundMessage);
            } catch (error) {
                this.clearRequestTimeout(state, requestId);
                state.pendingByRequestId.delete(requestId);
                if (state.activeRequestId === requestId) {
                    state.activeRequestId = null;
                }
                reject(new Error(getErrorMessage(error)));
                this.scheduleIdleCleanup(state);
            }
        });
    }

    cancel(event: IpcMainInvokeEvent, requestId?: string) {
        const senderId = event.sender.id;
        const state = this.senderSearchStates.get(senderId);
        if (!state) {
            return { canceled: false };
        }

        const targetRequestId = requestId?.trim() || state.activeRequestId;
        if (!targetRequestId) {
            return { canceled: false };
        }

        this.cancelRequest(state, targetRequestId);
        return { canceled: true };
    }

    resetCache() {
        for (const state of this.senderSearchStates.values()) {
            try {
                state.worker.postMessage({type: 'reset-cache'} satisfies TSearchWorkerInboundMessage);
            } catch {
                // Ignore cache-reset failures
            }
        }
        return true;
    }

    cleanupAll(reason: string) {
        for (const senderId of this.senderSearchStates.keys()) {
            this.cleanupSenderState(senderId, {
                terminateWorker: true,
                reason,
            });
        }
    }

    private sendSearchProgress(
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
            sender.send(SEARCH_EVENT_CHANNELS.progress, progress);
        } catch (err) {
            log.debug(`Failed to send search progress: ${getErrorMessage(err)}`);
        }
    }

    private markStateActivity(state: ISenderSearchState) {
        state.lastActivityAtMs = Date.now();
    }

    private isStateIdle(state: ISenderSearchState) {
        return !state.activeRequestId && state.pendingByRequestId.size === 0;
    }

    private clearIdleCleanupTimer(state: ISenderSearchState) {
        if (!state.idleCleanupTimer) {
            return;
        }

        clearTimeout(state.idleCleanupTimer);
        state.idleCleanupTimer = null;
    }

    private clearRequestTimeout(
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

    private scheduleIdleCleanup(
        state: ISenderSearchState,
    ) {
        this.clearIdleCleanupTimer(state);
        if (!this.isStateIdle(state)) {
            return;
        }

        state.idleCleanupTimer = setTimeout(() => {
            const senderId = state.senderId;
            const currentState = this.senderSearchStates.get(senderId);
            if (currentState !== state) {
                return;
            }
            if (!this.isStateIdle(currentState)) {
                return;
            }
            log.info(`Search worker lifecycle: sender ${senderId} idle TTL elapsed; terminating worker`);
            this.cleanupSenderState(senderId, {
                terminateWorker: true,
                reason: 'Search worker idle timeout',
            });
        }, SEARCH_WORKER_IDLE_TTL_MS);
        state.idleCleanupTimer.unref?.();
        log.debug(`Search worker lifecycle: sender ${state.senderId} scheduled idle cleanup in ${SEARCH_WORKER_IDLE_TTL_MS}ms`);
    }

    private resolvePendingRequest(
        state: ISenderSearchState,
        requestId: string,
        response: ISearchResponse,
    ) {
        this.settlePendingRequest(state, requestId, pending => pending.resolve(response));
    }

    private rejectPendingRequest(
        state: ISenderSearchState,
        requestId: string,
        error: Error,
    ) {
        this.settlePendingRequest(state, requestId, pending => pending.reject(error));
    }

    private settlePendingRequest(
        state: ISenderSearchState,
        requestId: string,
        settle: TPendingSearchSettler,
    ) {
        const pending = state.pendingByRequestId.get(requestId);
        if (!pending) {
            return;
        }

        this.clearRequestTimeout(state, requestId);
        this.markStateActivity(state);
        state.pendingByRequestId.delete(requestId);
        settle(pending);
        this.scheduleIdleCleanup(state);
    }

    private cleanupSenderState(
        senderId: number,
        options?: {
            terminateWorker?: boolean;
            reason?: string;
        },
    ) {
        const state = this.senderSearchStates.get(senderId);
        if (!state) {
            return;
        }

        log.info(`Search worker lifecycle: cleaning sender ${senderId} state (${options?.reason ?? 'Search worker stopped'})`);
        this.senderSearchStates.delete(senderId);
        this.clearIdleCleanupTimer(state);
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
            const existingTermination = this.workerTerminationPromises.get(senderId);
            if (!existingTermination) {
                const terminationPromise = withTimeout(
                    () => state.worker.terminate(),
                    SEARCH_WORKER_TERMINATE_TIMEOUT_MS,
                )
                    .then(() => {
                        log.debug(`Search worker lifecycle: sender ${senderId} worker terminated`);
                    })
                    .catch((error) => {
                        log.warn(
                            `Search worker lifecycle: sender ${senderId} worker terminate failed (${options?.reason ?? 'cleanup'}): ${
                                getErrorMessage(error)
                            }`,
                        );
                    })
                    .finally(() => {
                        this.workerTerminationPromises.delete(senderId);
                    });
                this.workerTerminationPromises.set(senderId, terminationPromise);
                void terminationPromise;
            }
        }
    }

    private cancelRequest(
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

        if (state.activeRequestId === requestId) {
            state.activeRequestId = null;
        }

        this.resolvePendingRequest(state, requestId, {
            results: [],
            truncated: false,
        });
    }

    private registerSenderCleanup(event: IpcMainInvokeEvent, senderId: number) {
        if (this.registeredSenderCleanup.has(senderId)) {
            return;
        }

        this.registeredSenderCleanup.add(senderId);
        const handleCleanup = () => {
            this.cleanupSenderState(senderId, {
                terminateWorker: true,
                reason: 'Renderer closed',
            });
            this.registeredSenderCleanup.delete(senderId);
        };
        event.sender.once('destroyed', handleCleanup);
        event.sender.once('render-process-gone', handleCleanup);
    }

    private handleWorkerMessage(
        state: ISenderSearchState,
        message: TSearchWorkerOutboundMessage,
    ) {
        const senderId = state.senderId;
        if (this.senderSearchStates.get(senderId) !== state) {
            return;
        }
        this.markStateActivity(state);

        switch (message.type) {
            case 'progress':
                this.sendSearchProgress(senderId, {
                    requestId: message.requestId,
                    processed: message.processed,
                    total: message.total,
                });
                return;
            case 'complete':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.resolvePendingRequest(state, message.requestId, message.response);
                return;
            case 'cancelled':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.resolvePendingRequest(state, message.requestId, {
                    results: [],
                    truncated: false,
                });
                return;
            case 'error':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.rejectPendingRequest(state, message.requestId, new Error(message.error));
                return;
        }
    }

    private createSenderSearchState(senderId: number): ISenderSearchState {
        const workerPath = this.resolveWorkerPath();
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
            this.handleWorkerMessage(state, parsedMessage);
        });

        worker.on('error', (error: Error) => {
            const currentSenderId = state.senderId;
            log.error(`Search worker error for sender ${currentSenderId}: ${error.message}`);
            this.cleanupSenderState(currentSenderId, {
                terminateWorker: true,
                reason: `Search worker error: ${error.message}`,
            });
        });

        worker.on('exit', (code) => {
            const currentSenderId = state.senderId;
            const reason = code === 0
                ? 'Search worker exited'
                : `Search worker exited unexpectedly with code ${code}`;
            this.cleanupSenderState(currentSenderId, {
                terminateWorker: false,
                reason,
            });
        });

        this.scheduleIdleCleanup(state);
        return state;
    }

    private findReusableIdleState() {
        const idleStates = Array.from(this.senderSearchStates.values())
            .filter(state => this.isStateIdle(state))
            .sort((left, right) => left.lastActivityAtMs - right.lastActivityAtMs);
        return idleStates[0] ?? null;
    }

    private ensureSenderState(event: IpcMainInvokeEvent, senderId: number) {
        this.registerSenderCleanup(event, senderId);

        let state = this.senderSearchStates.get(senderId);
        if (state) {
            this.markStateActivity(state);
            this.clearIdleCleanupTimer(state);
            return state;
        }

        if (this.senderSearchStates.size >= SEARCH_WORKER_MAX_ACTIVE) {
            const reusableState = this.findReusableIdleState();
            if (reusableState) {
                const previousSenderId = reusableState.senderId;
                this.senderSearchStates.delete(previousSenderId);
                reusableState.senderId = senderId;
                this.markStateActivity(reusableState);
                this.clearIdleCleanupTimer(reusableState);
                this.senderSearchStates.set(senderId, reusableState);
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

        state = this.createSenderSearchState(senderId);
        this.senderSearchStates.set(senderId, state);
        log.info(
            `Search worker lifecycle: sender ${senderId} worker active `
            + `(${this.senderSearchStates.size}/${SEARCH_WORKER_MAX_ACTIVE})`,
        );
        return state;
    }
}
