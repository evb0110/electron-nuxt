import type {IpcRenderer} from 'electron';
import type {
    IPdfSearchExcerpt,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchProgress,
    IPdfSearchResult,
    ISearchPreloadClient,
} from '@contracts/search';
import {
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@contracts/search';
import { toPageNumber } from '@contracts/pageNumbers';
import { isRecord } from '@contracts/runtimeGuards';
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

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
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
    const invoke = createTypedIpcInvoker<ISearchInvokeMap>(ipcRenderer);
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
        onProgress: (callback): (() => void) =>
            eventSubscriber.onDecodedPayload(SEARCH_EVENT_CHANNELS.progress, decodeSearchProgress, callback),
        resetCache: () => invoke(SEARCH_CHANNELS.resetCache),
    };
}
