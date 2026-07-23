import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { Worker } from 'worker_threads';
import { minBy } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { withTimeout } from 'es-toolkit/promise';
import type {
    ISearchResponse,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/features/search/protocol';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
    toSearchIpcError,
} from '@electron/features/search/main/searchErrors';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    isSearchErrorEnvelope,
    type IPdfSearchProgress,
    type ISearchErrorEnvelope,
} from '@contracts/search';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import {
    capSearchResponse,
    getSearchWorkerOutboundRequestId,
    parseSearchWorkerOutboundMessage,
} from '@electron/features/search/main/searchWorkerMessageCodec';
import {
    createMainJobRegistry,
    type IMainJobHandle,
    type IMainJobRunContext,
    type TMainJobErrorKind,
} from '@electron/operation-lifecycle/createMainJobRegistry';

type TSearchMatch = ISearchResponse['results'][number];
type TSearchJobContext = IMainJobRunContext<IPdfSearchProgress, ISearchResponse, ISearchErrorEnvelope>;
type TSearchJobHandle = IMainJobHandle<IPdfSearchProgress, ISearchResponse, ISearchErrorEnvelope>;

export interface ISearchOperationContext {
    sender: WebContents;
    senderId: number;
}

export interface ISearchSenderContext {
    sender: WebContents;
    senderId?: number;
}

interface IWorkerSearchRequest {
    requestId: string;
    pdfPath: string;
    pageCount: number | undefined;
    registry: TSearchJobContext | null;
    queuedProgress: IPdfSearchProgress | null;
    cancellationFallbackTimeout: NodeJS.Timeout | null;
    resolve: (response: ISearchResponse) => void;
    reject: (error: Error) => void;
    settlement: Promise<ISearchResponse>;
    handle: TSearchJobHandle | null;
}

interface ISenderSearchState {
    senderId: number;
    worker: Worker;
    activeRequestId: string | null;
    requests: Map<string, IWorkerSearchRequest>;
    idleCleanupTimer: NodeJS.Timeout | null;
    lastActivityAtMs: number;
}

interface IWarmupSingleflight {
    requestId: string;
    promise: Promise<ISearchResponse>;
}

interface IDispatchSearchRequestPayload {
    resolvedPdfPath: string;
    documentRevision: TDocumentRevisionToken;
    query: string;
    pageCount?: number;
    requestId?: string;
    warmup?: boolean;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    requestIdPrefix: string;
}

function buildSearchWorkerRequest(
    payload: IDispatchSearchRequestPayload,
    requestId: string,
): TSearchWorkerInboundMessage {
    return {
        type: 'search',
        payload: {
            requestId,
            pdfPath: payload.resolvedPdfPath,
            documentRevision: payload.documentRevision,
            query: payload.query,
            ...(payload.pageCount !== undefined ? { pageCount: payload.pageCount } : {}),
            ...(payload.warmup !== undefined ? { warmup: payload.warmup } : {}),
            ...(payload.matchCase !== undefined ? { matchCase: payload.matchCase } : {}),
            ...(payload.wholeWord !== undefined ? { wholeWord: payload.wholeWord } : {}),
            ...(payload.useRegex !== undefined ? { useRegex: payload.useRegex } : {}),
        },
    };
}

function getSearchPdfPathKey(pdfPath: string) {
    return normalizePathForLookup(pdfPath) || pdfPath;
}

function getSearchDocumentBuildKey(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    return `${getSearchPdfPathKey(pdfPath)}\0${documentRevision}`;
}

function toSearchRegistryError(cause: unknown, kind: TMainJobErrorKind) {
    if (cause instanceof SearchIpcError) {
        return cause.errorEnvelope;
    }
    if (isSearchErrorEnvelope(cause)) {
        return cause;
    }
    const message = getErrorMessage(cause) || 'Search failed';
    if (kind === 'duplicate-job-id') {
        return buildSearchErrorEnvelope('SEARCH_INVALID_PAYLOAD', message);
    }
    return buildSearchErrorEnvelope('SEARCH_INTERNAL', message);
}

function createSearchJobRegistry() {
    const replay = SEARCH_PLATFORM_FEATURE.events.onProgress.subscription.replay;
    return createMainJobRegistry<IPdfSearchProgress, ISearchResponse, ISearchErrorEnvelope>({
        retention: {
            eventReplayTtlMs: replay.terminalRetentionMs,
            terminalRecordTtlMs: replay.terminalRetentionMs,
        },
        progress: {
            channel: SEARCH_PLATFORM_FEATURE.eventChannels.onProgress,
            intervalMs: replay.intervalMs,
            getEventKey: progress => replay.key(progress) || null,
        },
        toError: toSearchRegistryError,
        terminalProgress: {
            completed: latest => ({
                requestId: latest.requestId,
                processed: latest.total,
                total: latest.total,
                status: 'success',
            }),
            canceled: latest => ({
                requestId: latest.requestId,
                processed: 0,
                total: latest.total,
                canceled: true,
                status: 'canceled',
            }),
            failed: (latest, error) => ({
                requestId: latest.requestId,
                processed: 0,
                total: latest.total,
                status: 'failed',
                error: error.message,
            }),
        },
    });
}

function createWorkerSettlement(
    requestId: string,
    pdfPath: string,
    pageCount: number | undefined,
): IWorkerSearchRequest {
    let resolve!: (response: ISearchResponse) => void;
    let reject!: (error: Error) => void;
    const settlement = new Promise<ISearchResponse>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        requestId,
        pdfPath,
        pageCount,
        registry: null,
        queuedProgress: null,
        cancellationFallbackTimeout: null,
        resolve,
        reject,
        settlement,
        handle: null,
    };
}

const log = createLogger('search-ipc');
const DEFAULT_SEARCH_REQUEST_TIMEOUT_MS = SEARCH_PLATFORM_FEATURE.methods.run.ipc.timeoutMs;
const MIN_SEARCH_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SEARCH_WORKER_MAX_ACTIVE = 2;
const MAX_SEARCH_WORKER_ACTIVE = 256;
const DEFAULT_SEARCH_WORKER_IDLE_TTL_MS = 30 * 1000;
const MIN_SEARCH_WORKER_IDLE_TTL_MS = 10_000;
const DEFAULT_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = 10_000;
const MIN_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_SEARCH_CANCEL_ACK_TIMEOUT_MS = 5_000;
const MIN_SEARCH_CANCEL_ACK_TIMEOUT_MS = 100;

const SEARCH_REQUEST_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS ?? `${DEFAULT_SEARCH_REQUEST_TIMEOUT_MS}`, 10);
    if (!Number.isFinite(parsed) || parsed < MIN_SEARCH_REQUEST_TIMEOUT_MS) {
        return DEFAULT_SEARCH_REQUEST_TIMEOUT_MS;
    }
    return parsed;
})();
const SEARCH_WORKER_MAX_ACTIVE = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_MAX_ACTIVE ?? `${DEFAULT_SEARCH_WORKER_MAX_ACTIVE}`, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_SEARCH_WORKER_MAX_ACTIVE;
    }
    return clamp(parsed, 1, MAX_SEARCH_WORKER_ACTIVE);
})();
const SEARCH_WORKER_IDLE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS ?? `${DEFAULT_SEARCH_WORKER_IDLE_TTL_MS}`, 10);
    if (!Number.isFinite(parsed) || parsed < MIN_SEARCH_WORKER_IDLE_TTL_MS) {
        return DEFAULT_SEARCH_WORKER_IDLE_TTL_MS;
    }
    return parsed;
})();
const SEARCH_WORKER_TERMINATE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS ?? `${DEFAULT_SEARCH_WORKER_TERMINATE_TIMEOUT_MS}`,
        10,
    );
    if (!Number.isFinite(parsed) || parsed < MIN_SEARCH_WORKER_TERMINATE_TIMEOUT_MS) {
        return DEFAULT_SEARCH_WORKER_TERMINATE_TIMEOUT_MS;
    }
    return parsed;
})();
const SEARCH_CANCEL_ACK_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS ?? `${DEFAULT_SEARCH_CANCEL_ACK_TIMEOUT_MS}`,
        10,
    );
    if (!Number.isFinite(parsed) || parsed < MIN_SEARCH_CANCEL_ACK_TIMEOUT_MS) {
        return DEFAULT_SEARCH_CANCEL_ACK_TIMEOUT_MS;
    }
    return parsed;
})();

export function getSearchWorkerServiceConfig() {
    return {
        requestTimeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
        idleTtlMs: SEARCH_WORKER_IDLE_TTL_MS,
        maxActive: SEARCH_WORKER_MAX_ACTIVE,
    };
}

export class SearchWorkerService {
    private readonly searchJobs = createSearchJobRegistry();
    private readonly senderSearchStates = new Map<number, ISenderSearchState>();
    private readonly workerTerminationPromises = new Map<Worker, Promise<void>>();
    private readonly warmupSingleflightsByDocument = new Map<string, IWarmupSingleflight>();

    constructor(private readonly resolveWorkerPath: () => string) {}

    private normalizeOperationContext(context: ISearchSenderContext): ISearchOperationContext {
        return {
            sender: context.sender,
            senderId: context.senderId ?? context.sender.id,
        };
    }

    subscribeProgress(context: ISearchSenderContext) {
        const operationContext = this.normalizeOperationContext(context);
        this.searchJobs.subscribeOwner({sender: operationContext.sender});
    }

    dispatchSearchRequest(
        context: ISearchSenderContext,
        payload: IDispatchSearchRequestPayload,
    ): Promise<ISearchResponse> {
        const operationContext = this.normalizeOperationContext(context);
        const requestId = payload.requestId && payload.requestId.length > 0
            ? payload.requestId
            : `${payload.requestIdPrefix}-${randomUUID()}`;
        const documentBuildKey = getSearchDocumentBuildKey(payload.resolvedPdfPath, payload.documentRevision);
        if (payload.warmup) {
            const existingWarmup = this.warmupSingleflightsByDocument.get(documentBuildKey);
            if (existingWarmup && existingWarmup.requestId !== requestId) {
                return existingWarmup.promise;
            }
        }

        const request = createWorkerSettlement(requestId, payload.resolvedPdfPath, payload.pageCount);
        const handle = this.searchJobs.start({
            jobId: requestId,
            owner: {sender: operationContext.sender},
            operation: {
                kind: 'abortable-work',
                workingCopyPath: payload.resolvedPdfPath,
            },
            ownerLifecycle: {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            },
            initialProgress: {
                requestId,
                processed: 0,
                total: payload.pageCount ?? 0,
                status: 'running',
            },
            onCancel: reason => this.requestWorkerCancellation(request, reason),
            run: registry => this.runWorkerRequest(request, registry),
        });
        request.handle = handle;

        try {
            const state = this.ensureSenderState(operationContext.senderId);
            if (!payload.warmup && state.activeRequestId && state.activeRequestId !== requestId) {
                state.requests.get(state.activeRequestId)?.handle?.cancel('Superseded by a newer search request');
            }
            state.requests.set(requestId, request);
            if (!payload.warmup) {
                state.activeRequestId = requestId;
            }
            this.markStateActivity(state);
            this.clearIdleCleanupTimer(state);
            state.worker.postMessage(buildSearchWorkerRequest(payload, requestId));
        } catch (error) {
            request.reject(toSearchIpcError(error));
        }

        const requestPromise = handle.terminal.then((terminal) => {
            if (terminal.status === 'completed') {
                return terminal.result;
            }
            if (terminal.status === 'canceled') {
                return {
                    results: [],
                    truncated: false,
                    canceled: true,
                };
            }
            throw new SearchIpcError(terminal.error);
        });
        if (payload.warmup) {
            this.warmupSingleflightsByDocument.set(documentBuildKey, {
                requestId,
                promise: requestPromise,
            });
            const cleanupWarmupSingleflight = () => {
                const current = this.warmupSingleflightsByDocument.get(documentBuildKey);
                if (current?.requestId === requestId) {
                    this.warmupSingleflightsByDocument.delete(documentBuildKey);
                }
            };
            void requestPromise.then(cleanupWarmupSingleflight, cleanupWarmupSingleflight);
        }
        return requestPromise;
    }

    cancel(context: ISearchOperationContext, requestId?: string) {
        const state = this.senderSearchStates.get(context.senderId);
        const targetRequestId = requestId ?? state?.activeRequestId;
        if (!targetRequestId) {
            return { canceled: false };
        }
        return {canceled: this.searchJobs.cancel(
            targetRequestId,
            {sender: context.sender},
            'explicit cancel request',
        )};
    }

    cancelRequestsForPdfPath(pdfPath: string, reason: string) {
        const targetPathKey = getSearchPdfPathKey(pdfPath);
        let canceledCount = 0;
        for (const state of this.senderSearchStates.values()) {
            for (const request of state.requests.values()) {
                if (getSearchPdfPathKey(request.pdfPath) === targetPathKey && request.handle?.cancel(reason)) {
                    canceledCount += 1;
                }
            }
        }
        if (canceledCount > 0) {
            log.info(`Cancelled ${canceledCount} search request(s) for stale PDF path "${pdfPath}": ${reason}`);
        }
        return canceledCount;
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

    cleanupAll(reason: string, options: { cooperativeStop?: boolean } = {}) {
        for (const senderId of [...this.senderSearchStates.keys()]) {
            this.cleanupSenderState(senderId, {
                terminateWorker: true,
                reason,
                ...(options.cooperativeStop === undefined
                    ? {}
                    : {cooperativeStop: options.cooperativeStop}),
            });
        }
    }

    async shutdown(reason: string) {
        const settlements = [...this.senderSearchStates.values()]
            .flatMap(state => [...state.requests.values()])
            .flatMap(request => request.handle ? [request.handle.settled] : []);
        this.cleanupAll(reason, {cooperativeStop: false});
        await Promise.allSettled(settlements);
        while (this.workerTerminationPromises.size > 0) {
            await Promise.all(Array.from(this.workerTerminationPromises.values()));
        }
    }

    private async runWorkerRequest(
        request: IWorkerSearchRequest,
        registry: TSearchJobContext,
    ) {
        request.registry = registry;
        if (request.queuedProgress) {
            registry.publish(request.queuedProgress);
            request.queuedProgress = null;
        }
        const timeout = setTimeout(() => {
            const error = new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_TIMEOUT',
                `Search request timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`,
                {retryable: true},
            ));
            if (!registry.terminal.fail(error)) {
                return;
            }
            const state = this.findRequestState(request);
            if (state) {
                this.postCancelMessage(state, request.requestId);
                this.cleanupSenderState(state.senderId, {
                    cooperativeStop: false,
                    terminateWorker: true,
                    reason: `Search request ${request.requestId} timed out`,
                    rejectionError: error,
                    expectedState: state,
                });
            } else {
                request.reject(error);
            }
        }, SEARCH_REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        try {
            return await request.settlement;
        } finally {
            clearTimeout(timeout);
            const state = this.findRequestState(request);
            if (state) {
                this.removeWorkerRequest(state, request);
            }
        }
    }

    private findRequestState(request: IWorkerSearchRequest) {
        for (const state of this.senderSearchStates.values()) {
            if (state.requests.get(request.requestId) === request) {
                return state;
            }
        }
        return null;
    }

    private publishWorkerProgress(request: IWorkerSearchRequest, progress: IPdfSearchProgress) {
        if (request.registry) {
            request.registry.publish(progress);
        } else {
            request.queuedProgress = progress;
        }
    }

    private markStateActivity(state: ISenderSearchState) {
        state.lastActivityAtMs = Date.now();
    }

    private isStateIdle(state: ISenderSearchState) {
        return !state.activeRequestId && state.requests.size === 0;
    }

    private clearIdleCleanupTimer(state: ISenderSearchState) {
        if (state.idleCleanupTimer) {
            clearTimeout(state.idleCleanupTimer);
            state.idleCleanupTimer = null;
        }
    }

    private clearCancellationFallbackTimeout(request: IWorkerSearchRequest) {
        if (request.cancellationFallbackTimeout) {
            clearTimeout(request.cancellationFallbackTimeout);
            request.cancellationFallbackTimeout = null;
        }
    }

    private scheduleIdleCleanup(state: ISenderSearchState) {
        this.clearIdleCleanupTimer(state);
        if (!this.isStateIdle(state)) {
            return;
        }
        state.idleCleanupTimer = setTimeout(() => {
            if (this.senderSearchStates.get(state.senderId) !== state || !this.isStateIdle(state)) {
                return;
            }
            log.info(`Search worker lifecycle: sender ${state.senderId} idle TTL elapsed; terminating worker`);
            this.cleanupSenderState(state.senderId, {
                terminateWorker: true,
                reason: 'Search worker idle timeout',
            });
        }, SEARCH_WORKER_IDLE_TTL_MS);
        state.idleCleanupTimer.unref?.();
        log.debug(`Search worker lifecycle: sender ${state.senderId} scheduled idle cleanup in ${SEARCH_WORKER_IDLE_TTL_MS}ms`);
    }

    private removeWorkerRequest(state: ISenderSearchState, request: IWorkerSearchRequest) {
        if (state.requests.get(request.requestId) !== request) {
            return;
        }
        this.clearCancellationFallbackTimeout(request);
        state.requests.delete(request.requestId);
        if (state.activeRequestId === request.requestId) {
            state.activeRequestId = null;
        }
        this.markStateActivity(state);
        this.scheduleIdleCleanup(state);
    }

    private settleWorkerRequest(
        state: ISenderSearchState,
        requestId: string,
        settle: (request: IWorkerSearchRequest) => void,
    ) {
        const request = state.requests.get(requestId);
        if (!request) {
            return;
        }
        this.removeWorkerRequest(state, request);
        settle(request);
    }

    private postCancelMessage(state: ISenderSearchState, requestId: string) {
        try {
            state.worker.postMessage({
                type: 'cancel',
                requestId,
            } satisfies TSearchWorkerInboundMessage);
            return true;
        } catch {
            return false;
        }
    }

    private requestWorkerCancellation(request: IWorkerSearchRequest, _reason: string) {
        const state = this.findRequestState(request);
        if (!state || request.cancellationFallbackTimeout) {
            return;
        }
        this.postCancelMessage(state, request.requestId);
        if (state.activeRequestId === request.requestId) {
            state.activeRequestId = null;
        }
        request.cancellationFallbackTimeout = setTimeout(() => {
            if (this.findRequestState(request) !== state) {
                return;
            }
            log.warn(
                `Search worker lifecycle: cancellation for request ${request.requestId} was not acknowledged within ${
                    SEARCH_CANCEL_ACK_TIMEOUT_MS
                }ms; forcing worker cleanup`,
            );
            this.settleWorkerRequest(state, request.requestId, pending => pending.resolve({
                results: [],
                truncated: false,
                canceled: true,
            }));
            this.cleanupSenderState(state.senderId, {
                terminateWorker: true,
                reason: `Search worker did not acknowledge cancellation for request ${request.requestId}`,
                expectedState: state,
            });
        }, SEARCH_CANCEL_ACK_TIMEOUT_MS);
        request.cancellationFallbackTimeout.unref?.();
    }

    private postCancelMessagesForRequests(state: ISenderSearchState) {
        let sentAny = false;
        for (const requestId of state.requests.keys()) {
            sentAny = this.postCancelMessage(state, requestId) || sentAny;
        }
        return sentAny;
    }

    private waitForWorkerExit(worker: Worker, timeoutMs: number) {
        return new Promise<boolean>((resolve) => {
            let timeout: NodeJS.Timeout | null = null;
            const handleExit = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve(true);
            };
            timeout = setTimeout(() => {
                worker.removeListener('exit', handleExit);
                resolve(false);
            }, timeoutMs);
            timeout.unref?.();
            worker.once('exit', handleExit);
        });
    }

    private terminateWorkerAfterCooperativeStop(
        senderId: number,
        state: ISenderSearchState,
        reason: string,
        cooperativeStopRequested: boolean,
    ) {
        if (this.workerTerminationPromises.has(state.worker)) {
            return;
        }
        const terminationPromise = (async () => {
            if (cooperativeStopRequested && await this.waitForWorkerExit(state.worker, SEARCH_WORKER_TERMINATE_TIMEOUT_MS)) {
                log.debug(`Search worker lifecycle: sender ${senderId} worker exited after cooperative stop`);
                return;
            }
            await withTimeout(
                () => state.worker.terminate(),
                SEARCH_WORKER_TERMINATE_TIMEOUT_MS,
            );
            log.debug(`Search worker lifecycle: sender ${senderId} worker terminated`);
        })()
            .catch((error) => {
                log.warn(
                    `Search worker lifecycle: sender ${senderId} worker terminate failed (${reason}): ${
                        getErrorMessage(error)
                    }`,
                );
            })
            .finally(() => {
                this.workerTerminationPromises.delete(state.worker);
            });
        this.workerTerminationPromises.set(state.worker, terminationPromise);
        void terminationPromise;
    }

    private cleanupSenderState(
        senderId: number,
        options: {
            cooperativeStop?: boolean;
            terminateWorker?: boolean;
            reason?: string;
            rejectionError?: Error;
            expectedState?: ISenderSearchState;
        } = {},
    ) {
        const state = this.senderSearchStates.get(senderId);
        if (!state || (options.expectedState && state !== options.expectedState)) {
            return;
        }
        const reason = options.reason ?? 'Search worker stopped';
        log.info(`Search worker lifecycle: cleaning sender ${senderId} state (${reason})`);
        this.senderSearchStates.delete(senderId);
        this.clearIdleCleanupTimer(state);
        for (const [
            documentBuildKey,
            warmup,
        ] of this.warmupSingleflightsByDocument.entries()) {
            if (state.requests.has(warmup.requestId)) {
                this.warmupSingleflightsByDocument.delete(documentBuildKey);
            }
        }
        const cooperativeStopRequested = options.cooperativeStop !== false
            && options.terminateWorker !== false
            && this.postCancelMessagesForRequests(state);
        const error = options.rejectionError ?? new Error(reason);
        for (const request of state.requests.values()) {
            this.clearCancellationFallbackTimeout(request);
            request.registry?.terminal.fail(error);
            request.reject(error);
        }
        state.requests.clear();
        state.activeRequestId = null;
        if (options.terminateWorker !== false) {
            this.terminateWorkerAfterCooperativeStop(senderId, state, reason, cooperativeStopRequested);
        }
    }

    private handleWorkerMessage(
        state: ISenderSearchState,
        message: TSearchWorkerOutboundMessage,
    ) {
        if (this.senderSearchStates.get(state.senderId) !== state) {
            return;
        }
        const request = state.requests.get(message.requestId);
        if (!request) {
            return;
        }
        this.markStateActivity(state);
        switch (message.type) {
            case 'progress': {
                const progress: {
                    requestId: string;
                    processed: number;
                    total: number;
                    results?: TSearchMatch[];
                    resultsStartIndex?: number;
                    truncated?: boolean;
                    canceled?: boolean;
                } = {
                    requestId: message.requestId,
                    processed: message.processed,
                    total: message.total,
                };
                if (message.results !== undefined) {
                    progress.results = message.results;
                }
                if (message.resultsStartIndex !== undefined) {
                    progress.resultsStartIndex = message.resultsStartIndex;
                }
                if (message.truncated !== undefined) {
                    progress.truncated = message.truncated;
                }
                this.publishWorkerProgress(request, progress);
                return;
            }
            case 'complete':
                this.settleWorkerRequest(
                    state,
                    message.requestId,
                    pending => pending.resolve(capSearchResponse(message.response)),
                );
                return;
            case 'cancelled':
                this.settleWorkerRequest(state, message.requestId, pending => pending.resolve({
                    results: [],
                    truncated: false,
                    canceled: true,
                }));
                return;
            case 'error':
                this.settleWorkerRequest(
                    state,
                    message.requestId,
                    pending => pending.reject(new SearchIpcError(buildSearchErrorEnvelope(
                        'SEARCH_WORKER_ERROR',
                        message.error,
                        {retryable: true},
                    ))),
                );
                return;
        }
    }

    private handleMalformedWorkerMessage(
        state: ISenderSearchState,
        requestId: string | null,
    ) {
        log.warn(`Search worker sent malformed message for sender ${state.senderId}`);
        if (requestId === null || !state.requests.has(requestId)) {
            return;
        }
        const error = new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_WORKER_PROTOCOL',
            `Search worker sent malformed message for request "${requestId}"`,
        ));
        this.settleWorkerRequest(state, requestId, request => request.reject(error));
        this.cleanupSenderState(state.senderId, {
            terminateWorker: true,
            reason: `Search worker protocol error for request ${requestId}`,
            expectedState: state,
        });
    }

    private createSenderSearchState(senderId: number): ISenderSearchState {
        const worker = new Worker(this.resolveWorkerPath());
        const state: ISenderSearchState = {
            senderId,
            worker,
            activeRequestId: null,
            requests: new Map(),
            idleCleanupTimer: null,
            lastActivityAtMs: Date.now(),
        };
        log.info(`Search worker lifecycle: created worker for sender ${senderId}`);
        worker.on('message', (message: unknown) => {
            const requestId = getSearchWorkerOutboundRequestId(message);
            if (requestId !== null && !state.requests.has(requestId)) {
                return;
            }
            const parsedMessage = parseSearchWorkerOutboundMessage(
                message,
                candidateRequestId => state.requests.get(candidateRequestId)?.pageCount,
            );
            if (!parsedMessage) {
                this.handleMalformedWorkerMessage(state, requestId);
                return;
            }
            this.handleWorkerMessage(state, parsedMessage);
        });
        worker.on('error', (error: Error) => {
            log.error(`Search worker error for sender ${state.senderId}: ${error.message}`);
            this.cleanupSenderState(state.senderId, {
                terminateWorker: true,
                reason: `Search worker error: ${error.message}`,
                rejectionError: toSearchIpcError(error, 'SEARCH_WORKER_ERROR', true),
                expectedState: state,
            });
        });
        worker.on('exit', (code) => {
            const reason = code === 0
                ? 'Search worker exited'
                : `Search worker exited unexpectedly with code ${code}`;
            this.cleanupSenderState(state.senderId, {
                terminateWorker: false,
                reason,
                ...(code === 0
                    ? {}
                    : {rejectionError: new SearchIpcError(buildSearchErrorEnvelope(
                        'SEARCH_WORKER_ERROR',
                        reason,
                        {retryable: true},
                    ))}),
                expectedState: state,
            });
        });
        this.scheduleIdleCleanup(state);
        return state;
    }

    private findReusableIdleState() {
        const idleStates = Array.from(this.senderSearchStates.values())
            .filter(state => this.isStateIdle(state));
        return minBy(idleStates, state => state.lastActivityAtMs) ?? null;
    }

    private ensureSenderState(senderId: number) {
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
                reusableState.worker.postMessage({type: 'reset-state'} satisfies TSearchWorkerInboundMessage);
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
            throw new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_WORKER_LIMIT',
                `Search worker limit reached (${SEARCH_WORKER_MAX_ACTIVE} active senders). Please retry shortly.`,
                {retryable: true},
            ));
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
