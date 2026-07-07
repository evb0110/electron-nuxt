import { randomUUID } from 'node:crypto';
import { webContents } from 'electron';
import { Worker } from 'worker_threads';
import { minBy } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { withTimeout } from 'es-toolkit/promise';
import { SEARCH_RESULT_LIMIT } from '@electron/config/constants';
import { SEARCH_EVENT_CHANNELS } from '@electron/features/search/contract';
import type {
    ISearchResponse,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/features/search/protocol';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
    toSearchIpcError,
} from '@electron/features/search/main/searchErrors';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { parsePageNumber } from '@contracts/pageNumbers';
import { isOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    ISearchOperationContext,
    ISearchSenderContext,
} from '@electron/features/search/searchService';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';

interface IPendingSearchRequest {
    resolve: (response: ISearchResponse) => void;
    reject: (error: Error) => void;
}

type TPendingSearchSettler = (pending: IPendingSearchRequest) => void;
type TSearchMatch = ISearchResponse['results'][number];
interface ISearchProgressPayload {
    requestId: string;
    processed: number;
    total: number;
    results?: TSearchMatch[];
    resultsStartIndex?: number;
    truncated?: boolean;
    canceled?: boolean;
    status?: 'running' | 'success' | 'canceled' | 'failed';
    error?: string;
}

interface ISenderSearchState {
    senderId: number;
    worker: Worker;
    activeRequestId: string | null;
    pendingByRequestId: Map<string, IPendingSearchRequest>;
    pdfPathsByRequestId: Map<string, string>;
    pageCountsByRequestId: Map<string, number>;
    requestTimeouts: Map<string, NodeJS.Timeout>;
    cancellationFallbackTimeouts: Map<string, NodeJS.Timeout>;
    cancelPendingRequestIds: Set<string>;
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

const log = createLogger('search-ipc');

const DEFAULT_SEARCH_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_SEARCH_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SEARCH_WORKER_MAX_ACTIVE = 2;
const MAX_SEARCH_WORKER_ACTIVE = 256;
const DEFAULT_SEARCH_WORKER_IDLE_TTL_MS = 30 * 1000;
const MIN_SEARCH_WORKER_IDLE_TTL_MS = 10_000;
const DEFAULT_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = 10_000;
const MIN_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_SEARCH_CANCEL_ACK_TIMEOUT_MS = 5_000;
const MIN_SEARCH_CANCEL_ACK_TIMEOUT_MS = 100;
const SEARCH_OUTBOUND_RESULT_LIMIT = Math.max(1, SEARCH_RESULT_LIMIT);
const SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS = 4_096;
const SEARCH_OUTBOUND_WORD_LIMIT = 2_048;
const SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS = 4_096;

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

function parseNonNegativeWorkerInteger(value: unknown) {
    if (!isFiniteWorkerMessageNumber(value) || !Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    return value;
}

function parsePositiveWorkerNumber(value: unknown) {
    return isFiniteWorkerMessageNumber(value) && value > 0
        ? value
        : undefined;
}

function parseOcrRotation(value: unknown): TOcrIndexRotation | undefined {
    return value === 0 || value === 90 || value === 180 || value === 270
        ? value
        : undefined;
}

function trimSearchTextSegment(value: string, maxLength: number, fromEnd = false) {
    if (value.length <= maxLength) {
        return {
            value,
            truncated: false,
        };
    }
    return {
        value: fromEnd ? value.slice(-maxLength) : value.slice(0, maxLength),
        truncated: true,
    };
}

function capSearchMatch(match: TSearchMatch) {
    let truncated = false;
    const before = trimSearchTextSegment(match.excerpt.before, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS, true);
    const matchedText = trimSearchTextSegment(match.excerpt.match, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    const after = trimSearchTextSegment(match.excerpt.after, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    truncated = before.truncated || matchedText.truncated || after.truncated;

    let words = match.words;
    if (words !== undefined) {
        if (words.length > SEARCH_OUTBOUND_WORD_LIMIT) {
            words = words.slice(0, SEARCH_OUTBOUND_WORD_LIMIT);
            truncated = true;
        }
        const cappedWords = words.map((word) => {
            if (word.text.length <= SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS) {
                return word;
            }
            truncated = true;
            return {
                ...word,
                text: word.text.slice(0, SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS),
            };
        });
        words = cappedWords;
    }

    const cappedMatch: TSearchMatch = {
        ...match,
        excerpt: {
            prefix: match.excerpt.prefix || before.truncated,
            suffix: match.excerpt.suffix || after.truncated || matchedText.truncated,
            before: before.value,
            match: matchedText.value,
            after: after.value,
        },
        ...(words === undefined ? {} : {words}),
    };
    return {
        match: cappedMatch,
        truncated,
    };
}

function capSearchResponse(
    response: ISearchResponse,
    maxResults = SEARCH_OUTBOUND_RESULT_LIMIT,
): ISearchResponse {
    let truncated = response.truncated || response.results.length > maxResults;
    const results: TSearchMatch[] = [];
    for (const result of response.results.slice(0, maxResults)) {
        const capped = capSearchMatch(result);
        results.push(capped.match);
        truncated = truncated || capped.truncated;
    }

    return {
        results,
        truncated,
        ...(response.canceled === undefined ? {} : {canceled: response.canceled}),
    };
}

function parseSearchMatch(value: unknown, pageCount?: number) {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    const excerpt = parseSearchExcerpt(value.excerpt);
    if (!excerpt) {
        return null;
    }
    const pageNumber = isFiniteWorkerMessageNumber(value.pageNumber)
        ? parsePageNumber(value.pageNumber, pageCount)
        : null;
    const pageMatchIndex = parseNonNegativeWorkerInteger(value.pageMatchIndex);
    const matchIndex = parseNonNegativeWorkerInteger(value.matchIndex);
    const startOffset = parseNonNegativeWorkerInteger(value.startOffset);
    const endOffset = parseNonNegativeWorkerInteger(value.endOffset);
    if (
        pageNumber === null
        || pageMatchIndex === null
        || matchIndex === null
        || startOffset === null
        || endOffset === null
        || endOffset < startOffset
    ) {
        return null;
    }
    const words = Array.isArray(value.words) && value.words.every(isOcrWord)
        ? value.words
        : undefined;
    const pageWidth = parsePositiveWorkerNumber(value.pageWidth);
    const pageHeight = parsePositiveWorkerNumber(value.pageHeight);
    const rotation = parseOcrRotation(value.rotation);
    return {
        pageNumber,
        pageMatchIndex,
        matchIndex,
        startOffset,
        endOffset,
        excerpt,
        ...(words !== undefined ? { words } : {}),
        ...(pageWidth !== undefined ? { pageWidth } : {}),
        ...(pageHeight !== undefined ? { pageHeight } : {}),
        ...(rotation !== undefined ? { rotation } : {}),
    };
}

function parseSearchResponse(value: unknown, pageCount?: number) {
    if (!isWorkerMessageRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }
    if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
        return null;
    }
    const results: TSearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = parseSearchMatch(result, pageCount);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }
    return capSearchResponse({
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    });
}

function parseWorkerOutboundMessage(
    value: unknown,
    resolvePageCount: (requestId: string) => number | undefined,
): TSearchWorkerOutboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
        return null;
    }
    const pageCount = resolvePageCount(value.requestId);
    switch (value.type) {
        case 'progress': {
            if (
                !isFiniteWorkerMessageNumber(value.processed)
                || !isFiniteWorkerMessageNumber(value.total)
                || value.processed < 0
                || value.total < 0
            ) {
                return null;
            }
            if (value.results !== undefined && !Array.isArray(value.results)) {
                return null;
            }
            const resultsStartIndex = value.resultsStartIndex === undefined
                ? undefined
                : parseNonNegativeWorkerInteger(value.resultsStartIndex);
            if (value.resultsStartIndex !== undefined && resultsStartIndex === null) {
                return null;
            }
            const resultDeltaStartIndex = resultsStartIndex ?? undefined;
            if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
                return null;
            }
            if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
                return null;
            }
            if (Array.isArray(value.results)) {
                const results: TSearchMatch[] = [];
                for (const result of value.results) {
                    const parsedResult = parseSearchMatch(result, pageCount);
                    if (!parsedResult) {
                        return null;
                    }
                    results.push(parsedResult);
                }
                const maxResults = resultDeltaStartIndex === undefined
                    ? SEARCH_OUTBOUND_RESULT_LIMIT
                    : Math.max(0, SEARCH_OUTBOUND_RESULT_LIMIT - resultDeltaStartIndex);
                const cappedResponse = capSearchResponse({
                    results,
                    truncated: Boolean(value.truncated),
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                }, maxResults);
                return {
                    type: 'progress',
                    requestId: value.requestId,
                    processed: value.processed,
                    total: value.total,
                    results: cappedResponse.results,
                    ...(resultDeltaStartIndex === undefined ? {} : {resultsStartIndex: resultDeltaStartIndex}),
                    truncated: cappedResponse.truncated,
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                };
            }
            return {
                type: 'progress',
                requestId: value.requestId,
                processed: value.processed,
                total: value.total,
                ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
            };
        }
        case 'complete': {
            const response = parseSearchResponse(value.response, pageCount);
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

function getWorkerOutboundRequestId(value: unknown) {
    return isWorkerMessageRecord(value) && typeof value.requestId === 'string'
        ? value.requestId
        : null;
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
    private readonly senderCleanupDisposers = new Map<number, () => void>();
    private readonly workerTerminationPromises = new Map<Worker, Promise<void>>();
    private readonly progressPumpsBySenderId = new Map<number, ReturnType<typeof createIpcProgressPump<ISearchProgressPayload>>>();
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
        this.progressPumpsBySenderId.get(operationContext.senderId)?.subscribe({
            key: `web-contents:${operationContext.senderId}`,
            isDestroyed: () => operationContext.sender.isDestroyed(),
            send: (channel: string, payload: ISearchProgressPayload) => operationContext.sender.send(channel, payload),
        });
    }

    dispatchSearchRequest(
        context: ISearchSenderContext,
        payload: IDispatchSearchRequestPayload,
    ): Promise<ISearchResponse> {
        const operationContext = this.normalizeOperationContext(context);
        const senderId = operationContext.senderId;
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

        const state = this.ensureSenderState(operationContext);
        if (state.pendingByRequestId.has(requestId)) {
            throw new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_INVALID_PAYLOAD',
                `Search request with id "${requestId}" is already in progress`,
            ));
        }

        if (!payload.warmup && state.activeRequestId && state.activeRequestId !== requestId) {
            this.cancelRequest(state, state.activeRequestId);
        }

        if (!payload.warmup) {
            this.activateRequest(state, requestId);
        } else {
            this.markStateActivity(state);
        }
        this.clearIdleCleanupTimer(state);

        const requestPromise = new Promise<ISearchResponse>((resolve, reject) => {
            state.pendingByRequestId.set(requestId, {
                resolve,
                reject,
            });
            state.pdfPathsByRequestId.set(requestId, payload.resolvedPdfPath);
            if (payload.pageCount !== undefined) {
                state.pageCountsByRequestId.set(requestId, payload.pageCount);
            }
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
                this.sendSearchTerminalProgress(
                    state,
                    requestId,
                    'failed',
                    {error: `Search request timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`},
                );
                this.rejectPendingRequest(
                    state,
                    requestId,
                    new SearchIpcError(buildSearchErrorEnvelope(
                        'SEARCH_TIMEOUT',
                        `Search request timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`,
                        {retryable: true},
                    )),
                );
                this.cleanupSenderState(senderId, {
                    terminateWorker: true,
                    reason: `Search request ${requestId} timed out`,
                    expectedState: state,
                });
            }, SEARCH_REQUEST_TIMEOUT_MS);
            requestTimeout.unref?.();
            state.requestTimeouts.set(requestId, requestTimeout);

            try {
                state.worker.postMessage(buildSearchWorkerRequest(payload, requestId));
            } catch (error) {
                this.clearRequestTimeout(state, requestId);
                state.pendingByRequestId.delete(requestId);
                state.pdfPathsByRequestId.delete(requestId);
                state.pageCountsByRequestId.delete(requestId);
                if (state.activeRequestId === requestId) {
                    state.activeRequestId = null;
                }
                reject(new Error(getErrorMessage(error)));
                this.scheduleIdleCleanup(state);
            }
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

    cancel(context: ISearchOperationContext, requestId?: unknown) {
        const senderId = context.senderId;
        const normalizedRequestId = normalizeOptionalIpcRequestId(requestId);
        const state = this.senderSearchStates.get(senderId);
        if (!state) {
            return { canceled: false };
        }

        const targetRequestId = normalizedRequestId ?? state.activeRequestId;
        if (!targetRequestId) {
            return { canceled: false };
        }

        return { canceled: this.cancelRequest(state, targetRequestId) };
    }

    cancelRequestsForPdfPath(pdfPath: string, reason: string) {
        const targetPathKey = getSearchPdfPathKey(pdfPath);
        let canceledCount = 0;

        for (const state of this.senderSearchStates.values()) {
            const requestIds = Array.from(state.pdfPathsByRequestId.entries())
                .filter(([
                    , requestPdfPath,
                ]) => getSearchPdfPathKey(requestPdfPath) === targetPathKey)
                .map(([requestId]) => requestId);

            for (const requestId of requestIds) {
                if (!state.pendingByRequestId.has(requestId)) {
                    continue;
                }
                if (this.cancelRequest(state, requestId)) {
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
        progress: ISearchProgressPayload,
    ) {
        let pump = this.progressPumpsBySenderId.get(senderId);
        if (!pump) {
            pump = createIpcProgressPump<ISearchProgressPayload>({
                channel: SEARCH_EVENT_CHANNELS.progress,
                getTarget: () => {
                    const sender = webContents.fromId(senderId);
                    if (!sender) {
                        return null;
                    }
                    return {
                        key: `web-contents:${senderId}`,
                        isDestroyed: () => sender.isDestroyed(),
                        send: (channel: string, payload: ISearchProgressPayload) => sender.send(channel, payload),
                    };
                },
                getKey: (payload: ISearchProgressPayload) => payload.requestId,
                isTerminal: (payload: ISearchProgressPayload) => payload.status === 'success'
                    || payload.status === 'canceled'
                    || payload.status === 'failed'
                    || payload.canceled === true
                    || payload.processed >= payload.total,
                onError: (err: unknown) => {
                    log.debug(`Failed to send search progress: ${getErrorMessage(err)}`);
                },
                onIdle: () => {
                    this.progressPumpsBySenderId.delete(senderId);
                },
            });
            this.progressPumpsBySenderId.set(senderId, pump);
        }
        pump.enqueue(progress);
    }

    private sendSearchTerminalProgress(
        state: ISenderSearchState,
        requestId: string,
        status: 'success' | 'canceled' | 'failed',
        options: {
            error?: string;
            canceled?: boolean;
        } = {},
    ) {
        const total = state.pageCountsByRequestId.get(requestId) ?? 0;
        this.sendSearchProgress(state.senderId, {
            requestId,
            processed: status === 'success' ? total : 0,
            total,
            ...(options.canceled === true ? {canceled: true} : {}),
            status,
            ...(options.error === undefined ? {} : {error: options.error}),
        });
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

    private activateRequest(state: ISenderSearchState, requestId: string) {
        state.activeRequestId = requestId;
        this.markStateActivity(state);
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

    private clearCancellationFallbackTimeout(
        state: ISenderSearchState,
        requestId: string,
    ) {
        const timeout = state.cancellationFallbackTimeouts.get(requestId);
        if (!timeout) {
            return;
        }

        clearTimeout(timeout);
        state.cancellationFallbackTimeouts.delete(requestId);
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
        this.clearCancellationFallbackTimeout(state, requestId);
        this.markStateActivity(state);
        state.pendingByRequestId.delete(requestId);
        state.pdfPathsByRequestId.delete(requestId);
        state.pageCountsByRequestId.delete(requestId);
        state.cancelPendingRequestIds.delete(requestId);
        settle(pending);
        this.scheduleIdleCleanup(state);
    }

    private settleCancelledRequest(
        state: ISenderSearchState,
        requestId: string,
    ) {
        if (state.activeRequestId === requestId) {
            state.activeRequestId = null;
        }
        this.sendSearchTerminalProgress(state, requestId, 'canceled', {canceled: true});
        this.resolvePendingRequest(state, requestId, {
            results: [],
            truncated: false,
            canceled: true,
        });
    }

    private postCancelMessage(
        state: ISenderSearchState,
        requestId: string,
    ) {
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

    private postCancelMessagesForPendingRequests(state: ISenderSearchState) {
        let sentAny = false;
        for (const requestId of state.pendingByRequestId.keys()) {
            sentAny = this.postCancelMessage(state, requestId) || sentAny;
        }
        return sentAny;
    }

    private clearProgressPump(senderId: number) {
        const pump = this.progressPumpsBySenderId.get(senderId);
        if (!pump) {
            return;
        }

        pump.clear();
        this.progressPumpsBySenderId.delete(senderId);
    }

    private disposeSenderCleanup(senderId: number) {
        const dispose = this.senderCleanupDisposers.get(senderId);
        if (!dispose) {
            return;
        }

        this.senderCleanupDisposers.delete(senderId);
        dispose();
    }

    private waitForWorkerExit(worker: Worker, timeoutMs: number) {
        return new Promise<boolean>((resolve) => {
            const cleanup = {
                timeout: null as NodeJS.Timeout | null,
                handleExit: () => {
                    if (cleanup.timeout) {
                        clearTimeout(cleanup.timeout);
                    }
                    resolve(true);
                },
            };

            cleanup.timeout = setTimeout(() => {
                worker.removeListener('exit', cleanup.handleExit);
                resolve(false);
            }, timeoutMs);
            cleanup.timeout.unref?.();

            worker.once('exit', cleanup.handleExit);
        });
    }

    private terminateWorkerAfterCooperativeStop(
        senderId: number,
        state: ISenderSearchState,
        reason: string,
        cooperativeStopRequested: boolean,
    ) {
        const existingTermination = this.workerTerminationPromises.get(state.worker);
        if (existingTermination) {
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
        options?: {
            terminateWorker?: boolean;
            reason?: string;
            rejectionError?: Error;
            expectedState?: ISenderSearchState;
        },
    ) {
        const state = this.senderSearchStates.get(senderId);
        if (!state) {
            return;
        }
        if (options?.expectedState && state !== options.expectedState) {
            return;
        }

        log.info(`Search worker lifecycle: cleaning sender ${senderId} state (${options?.reason ?? 'Search worker stopped'})`);
        this.senderSearchStates.delete(senderId);
        this.clearProgressPump(senderId);
        this.disposeSenderCleanup(senderId);
        this.clearIdleCleanupTimer(state);
        for (const timeout of state.requestTimeouts.values()) {
            clearTimeout(timeout);
        }
        state.requestTimeouts.clear();
        for (const timeout of state.cancellationFallbackTimeouts.values()) {
            clearTimeout(timeout);
        }
        state.cancellationFallbackTimeouts.clear();
        for (const [
            documentBuildKey,
            warmup,
        ] of this.warmupSingleflightsByDocument.entries()) {
            if (state.pendingByRequestId.has(warmup.requestId)) {
                this.warmupSingleflightsByDocument.delete(documentBuildKey);
            }
        }

        const reason = options?.reason ?? 'Search worker stopped';
        const terminalError = options?.rejectionError ? getErrorMessage(options.rejectionError) : reason;
        const cooperativeStopRequested = options?.terminateWorker !== false
            && this.postCancelMessagesForPendingRequests(state);
        for (const [
            requestId,
            pending,
        ] of state.pendingByRequestId.entries()) {
            if (state.cancelPendingRequestIds.has(requestId)) {
                this.sendSearchTerminalProgress(state, requestId, 'canceled', {canceled: true});
                pending.resolve({
                    results: [],
                    truncated: false,
                    canceled: true,
                });
                continue;
            }

            this.sendSearchTerminalProgress(state, requestId, 'failed', {error: terminalError});
            pending.reject(options?.rejectionError ?? new Error(reason));
        }
        state.pendingByRequestId.clear();
        state.pdfPathsByRequestId.clear();
        state.pageCountsByRequestId.clear();
        state.cancelPendingRequestIds.clear();
        state.activeRequestId = null;

        if (options?.terminateWorker !== false) {
            this.terminateWorkerAfterCooperativeStop(senderId, state, reason, cooperativeStopRequested);
        }
    }

    private cancelRequest(
        state: ISenderSearchState,
        requestId: string,
    ) {
        if (!state.pendingByRequestId.has(requestId)) {
            return false;
        }
        if (state.cancelPendingRequestIds.has(requestId)) {
            return true;
        }

        state.cancelPendingRequestIds.add(requestId);
        this.clearRequestTimeout(state, requestId);
        this.postCancelMessage(state, requestId);
        if (state.activeRequestId === requestId) {
            state.activeRequestId = null;
        }

        const fallbackTimeout = setTimeout(() => {
            if (this.senderSearchStates.get(state.senderId) !== state || !state.pendingByRequestId.has(requestId)) {
                return;
            }

            log.warn(
                `Search worker lifecycle: cancellation for request ${requestId} was not acknowledged within ${
                    SEARCH_CANCEL_ACK_TIMEOUT_MS
                }ms; forcing worker cleanup`,
            );
            this.settleCancelledRequest(state, requestId);
            this.cleanupSenderState(state.senderId, {
                terminateWorker: true,
                reason: `Search worker did not acknowledge cancellation for request ${requestId}`,
                expectedState: state,
            });
        }, SEARCH_CANCEL_ACK_TIMEOUT_MS);
        fallbackTimeout.unref?.();
        state.cancellationFallbackTimeouts.set(requestId, fallbackTimeout);
        return true;
    }

    private registerSenderCleanup(context: ISearchOperationContext) {
        const {
            sender,
            senderId,
        } = context;
        if (this.senderCleanupDisposers.has(senderId)) {
            return;
        }

        const cleanup = (reason: string) => {
            this.cleanupSenderState(senderId, {
                terminateWorker: true,
                reason,
            });
            this.disposeSenderCleanup(senderId);
        };
        const handleDestroyed = () => {
            cleanup('Renderer destroyed');
        };
        const handleRenderProcessGone = () => {
            cleanup('Renderer process gone');
        };
        const handleNavigation = (
            _event: Electron.Event,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => {
            if (isMainFrame && !isInPlace) {
                cleanup('Renderer navigated');
            }
        };

        sender.once('destroyed', handleDestroyed);
        sender.once('render-process-gone', handleRenderProcessGone);
        sender.on('did-start-navigation', handleNavigation);
        this.senderCleanupDisposers.set(senderId, () => {
            sender.removeListener('destroyed', handleDestroyed);
            sender.removeListener('render-process-gone', handleRenderProcessGone);
            sender.removeListener('did-start-navigation', handleNavigation);
        });
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
                this.sendSearchProgress(senderId, progress);
                return;
            }
            case 'complete':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.sendSearchTerminalProgress(state, message.requestId, 'success');
                this.resolvePendingRequest(state, message.requestId, capSearchResponse(message.response));
                return;
            case 'cancelled':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.sendSearchTerminalProgress(state, message.requestId, 'canceled', {canceled: true});
                this.resolvePendingRequest(state, message.requestId, {
                    results: [],
                    truncated: false,
                    canceled: true,
                });
                return;
            case 'error':
                if (state.activeRequestId === message.requestId) {
                    state.activeRequestId = null;
                }
                this.sendSearchTerminalProgress(state, message.requestId, 'failed', {error: message.error});
                this.rejectPendingRequest(
                    state,
                    message.requestId,
                    new SearchIpcError(buildSearchErrorEnvelope('SEARCH_WORKER_ERROR', message.error, {retryable: true})),
                );
                return;
        }
    }

    private handleMalformedWorkerMessage(
        state: ISenderSearchState,
        requestId: string | null,
    ) {
        const senderId = state.senderId;
        log.warn(`Search worker sent malformed message for sender ${senderId}`);
        if (requestId === null || !state.pendingByRequestId.has(requestId)) {
            return;
        }

        if (state.activeRequestId === requestId) {
            state.activeRequestId = null;
        }
        this.sendSearchTerminalProgress(
            state,
            requestId,
            'failed',
            {error: `Search worker sent malformed message for request "${requestId}"`},
        );
        this.rejectPendingRequest(
            state,
            requestId,
            new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_WORKER_PROTOCOL',
                `Search worker sent malformed message for request "${requestId}"`,
            )),
        );
        this.cleanupSenderState(senderId, {
            terminateWorker: true,
            reason: `Search worker protocol error for request ${requestId}`,
            expectedState: state,
        });
    }

    private createSenderSearchState(senderId: number): ISenderSearchState {
        const workerPath = this.resolveWorkerPath();
        const worker = new Worker(workerPath);
        const state: ISenderSearchState = {
            senderId,
            worker,
            activeRequestId: null,
            pendingByRequestId: new Map(),
            pdfPathsByRequestId: new Map(),
            pageCountsByRequestId: new Map(),
            requestTimeouts: new Map(),
            cancellationFallbackTimeouts: new Map(),
            cancelPendingRequestIds: new Set(),
            idleCleanupTimer: null,
            lastActivityAtMs: Date.now(),
        };
        log.info(`Search worker lifecycle: created worker for sender ${senderId}`);

        worker.on('message', (message: unknown) => {
            const requestId = getWorkerOutboundRequestId(message);
            if (requestId !== null && !state.pendingByRequestId.has(requestId)) {
                return;
            }

            const parsedMessage = parseWorkerOutboundMessage(
                message,
                requestId => state.pageCountsByRequestId.get(requestId),
            );
            if (!parsedMessage) {
                this.handleMalformedWorkerMessage(state, requestId);
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
                rejectionError: toSearchIpcError(error, 'SEARCH_WORKER_ERROR', true),
                expectedState: state,
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
                ...(code === 0
                    ? {}
                    : {rejectionError: new SearchIpcError(buildSearchErrorEnvelope('SEARCH_WORKER_ERROR', reason, {retryable: true}))}),
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

    private ensureSenderState(context: ISearchOperationContext) {
        const senderId = context.senderId;
        this.registerSenderCleanup(context);

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
                this.clearProgressPump(previousSenderId);
                this.disposeSenderCleanup(previousSenderId);
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
