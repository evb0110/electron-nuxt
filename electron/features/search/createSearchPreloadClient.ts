import type {IpcRenderer} from 'electron';
import type {
    IPdfSearchExcerpt,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchProgress,
    IPdfSearchResult,
    ISearchPreloadClient,
} from '@contracts/search';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import {
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@electron/features/search/searchRequestPayload';
import { toPageNumber } from '@contracts/pageNumbers';
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
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

const SEARCH_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const SEARCH_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [SEARCH_CHANNELS.search]: SEARCH_NATIVE_IPC_TIMEOUT_MS,
    [SEARCH_CHANNELS.warmIndex]: SEARCH_NATIVE_IPC_TIMEOUT_MS,
} as const;


function isOcrRotation(value: unknown): value is TOcrIndexRotation {
    return value === 0 || value === 90 || value === 180 || value === 270;
}

function decodeSearchExcerpt(value: unknown): IPdfSearchExcerpt | null {
    if (
        !isRecord(value)
        || typeof value.prefix !== 'boolean'
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

function decodeSearchResult(value: unknown): IPdfSearchResult | null {
    if (
        !isRecord(value)
        || !isFiniteNumber(value.pageNumber)
        || !isFiniteNumber(value.pageMatchIndex)
        || !isFiniteNumber(value.matchIndex)
        || !isFiniteNumber(value.startOffset)
        || !isFiniteNumber(value.endOffset)
    ) {
        return null;
    }
    const excerpt = decodeSearchExcerpt(value.excerpt);
    if (!excerpt) {
        return null;
    }
    if (value.words !== undefined && !Array.isArray(value.words)) {
        return null;
    }
    if (value.pageWidth !== undefined && !isFiniteNumber(value.pageWidth)) {
        return null;
    }
    if (value.pageHeight !== undefined && !isFiniteNumber(value.pageHeight)) {
        return null;
    }
    if (value.rotation !== undefined && !isOcrRotation(value.rotation)) {
        return null;
    }

    return {
        pageNumber: toPageNumber(value.pageNumber),
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt,
        ...(value.words === undefined ? {} : {words: value.words as NonNullable<IPdfSearchResult['words']>}),
        ...(value.pageWidth === undefined ? {} : {pageWidth: value.pageWidth}),
        ...(value.pageHeight === undefined ? {} : {pageHeight: value.pageHeight}),
        ...(value.rotation === undefined ? {} : {rotation: value.rotation}),
    };
}

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
    if (payload.results !== undefined) {
        if (!Array.isArray(payload.results)) {
            return null;
        }
        const results = payload.results.map(decodeSearchResult);
        if (results.some(result => result === null)) {
            return null;
        }
        return {
            requestId: payload.requestId,
            processed: payload.processed,
            total: payload.total,
            results: results as IPdfSearchResult[],
            ...(payload.truncated === undefined ? {} : {truncated: payload.truncated}),
            ...(payload.canceled === undefined ? {} : {canceled: payload.canceled}),
        };
    }
    return {
        requestId: payload.requestId,
        processed: payload.processed,
        total: payload.total,
        ...(payload.truncated === undefined ? {} : {truncated: payload.truncated}),
        ...(payload.canceled === undefined ? {} : {canceled: payload.canceled}),
    };
}

export function createSearchPreloadClient(ipcRenderer: IpcRenderer): ISearchPreloadClient {
    const invoke = createTypedIpcInvoker<ISearchInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: SEARCH_INVOKE_TIMEOUT_MS_BY_CHANNEL});
    const eventSubscriber = createTypedIpcEventSubscriber<ISearchEventMap>(ipcRenderer);

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
            void invoke(SEARCH_CHANNELS.subscribeProgress);
            return unsubscribe;
        },
        resetCache: () => invoke(SEARCH_CHANNELS.resetCache),
    };
}
