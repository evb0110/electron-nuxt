import type {IpcRenderer} from 'electron';
import type {
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchProgress,
    IPdfSearchResult,
    ISearchPreloadClient,
} from '@contracts/search';
import { SEARCH_WIRE_CODEC } from '@contracts/search';
import {
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@electron/features/search/searchRequestPayload';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    SEARCH_CHANNELS,
    SEARCH_EVENT_CHANNELS,
    type ISearchEventMap,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import { SEARCH_IPC_CODECS } from '@electron/features/search/searchIpcCodecs';
import {
    createCodecIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';

const SEARCH_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const SEARCH_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [SEARCH_CHANNELS.search]: SEARCH_NATIVE_IPC_TIMEOUT_MS,
    [SEARCH_CHANNELS.warmIndex]: SEARCH_NATIVE_IPC_TIMEOUT_MS,
} as const;


function decodeSearchProgress(payload: unknown): IPdfSearchProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.requestId !== 'string'
        || !isFiniteNumber(payload.processed)
        || !isFiniteNumber(payload.total)
    ) {
        return null;
    }
    if (payload.truncated !== undefined && typeof payload.truncated !== 'boolean') {
        return null;
    }
    if (payload.canceled !== undefined && typeof payload.canceled !== 'boolean') {
        return null;
    }
    if (
        payload.status !== undefined
        && payload.status !== 'running'
        && payload.status !== 'success'
        && payload.status !== 'canceled'
        && payload.status !== 'failed'
    ) {
        return null;
    }
    if (payload.error !== undefined && typeof payload.error !== 'string') {
        return null;
    }
    if (payload.results !== undefined) {
        if (!Array.isArray(payload.results)) {
            return null;
        }
        const rawResultsStartIndex = payload.resultsStartIndex;
        if (
            rawResultsStartIndex !== undefined
            && (!isFiniteNumber(rawResultsStartIndex) || !Number.isSafeInteger(rawResultsStartIndex) || rawResultsStartIndex < 0)
        ) {
            return null;
        }
        const resultsStartIndex = typeof rawResultsStartIndex === 'number'
            ? rawResultsStartIndex
            : undefined;
        const results = payload.results.map(result => SEARCH_WIRE_CODEC.decodeResult(result));
        if (results.some(result => result === null)) {
            return null;
        }
        return {
            requestId: payload.requestId,
            processed: payload.processed,
            total: payload.total,
            results: results as IPdfSearchResult[],
            ...(resultsStartIndex === undefined ? {} : {resultsStartIndex}),
            ...(payload.truncated === undefined ? {} : {truncated: payload.truncated}),
            ...(payload.canceled === undefined ? {} : {canceled: payload.canceled}),
            ...(payload.status === undefined ? {} : {status: payload.status}),
            ...(payload.error === undefined ? {} : {error: payload.error}),
        };
    }
    return {
        requestId: payload.requestId,
        processed: payload.processed,
        total: payload.total,
        ...(payload.truncated === undefined ? {} : {truncated: payload.truncated}),
        ...(payload.canceled === undefined ? {} : {canceled: payload.canceled}),
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
}

export function createSearchPreloadClient(ipcRenderer: IpcRenderer): ISearchPreloadClient {
    const invoke = createCodecIpcInvoker<ISearchInvokeMap>(ipcRenderer, SEARCH_IPC_CODECS, {invokeTimeoutMsByChannel: SEARCH_INVOKE_TIMEOUT_MS_BY_CHANNEL});
    const eventSubscriber = createTypedIpcEventSubscriber<ISearchEventMap>(ipcRenderer);
    let progressSubscriptionRequested = false;

    function ensureProgressSubscription() {
        if (progressSubscriptionRequested) {
            return;
        }
        progressSubscriptionRequested = true;
        void invoke(SEARCH_CHANNELS.subscribeProgress);
    }

    return {
        run: (
            pdfPath,
            query,
            options?: IPdfSearchRequestOptions,
        ): Promise<IPdfSearchResponse> => invoke(
            SEARCH_CHANNELS.search,
            normalizePdfSearchRequestPayload({
                pdfPath,
                query,
                ...options,
            }),
        ),
        warmIndex: (
            pdfPath,
            options?: IPdfSearchRequestOptions,
        ) => invoke(
            SEARCH_CHANNELS.warmIndex,
            normalizePdfSearchWarmIndexPayload({
                pdfPath,
                ...options,
            }),
        ),
        cancel: (requestId?: string): Promise<{ canceled: boolean }> =>
            invoke(SEARCH_CHANNELS.cancel, normalizeOptionalSearchRequestId(requestId)),
        onProgress: (callback): (() => void) => {
            const unsubscribe = eventSubscriber.onDecodedPayload(SEARCH_EVENT_CHANNELS.progress, decodeSearchProgress, callback);
            ensureProgressSubscription();
            return unsubscribe;
        },
        resetCache: () => invoke(SEARCH_CHANNELS.resetCache),
    };
}
