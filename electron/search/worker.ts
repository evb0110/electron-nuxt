import { parentPort } from 'worker_threads';
import { stat } from 'fs/promises';
import type { IPdfSearchIndex } from '@electron/search/index-builder';
import type {
    ISearchMatch,
    ISearchWorkerRequest,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/search/protocol';
import { SEARCH_RESULT_LIMIT } from '@electron/config/constants';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/worker-message';
import {
    buildExcerpt,
    findPageMatches,
} from '@electron/search/worker/search-match';
import type { ICachedIndex } from '@electron/search/worker/search-index-cache';
import { ensureSearchIndex } from '@electron/search/worker/search-index-cache';

interface ISearchRequestContext {
    requestId: string;
    pdfPath: string;
    normalizedQuery: string;
    pageCount?: number;
    shouldWarmup: boolean;
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
    signal: AbortSignal;
}

interface ISearchExecutionResult {
    results: ISearchMatch[];
    truncated: boolean;
}

const PROGRESS_THROTTLE_MS = 60;
const SEARCH_INDEX_CACHE_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES ?? '2', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 2;
    }
    return Math.min(parsed, 128);
})();
const SEARCH_INDEX_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_INDEX_CACHE_TTL_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 30_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const CANCELLED_REQUESTS_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_CANCELLED_REQUESTS_MAX_ENTRIES ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 256;
    }
    return Math.min(parsed, 8_192);
})();
const CANCELLED_REQUEST_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_CANCELLED_REQUEST_TTL_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const SEARCH_WORKER_MAX_PAGE_TEXT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_MAX_PAGE_TEXT_BYTES ?? `${2 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 16 * 1024) {
        return 2 * 1024 * 1024;
    }
    return Math.min(parsed, 32 * 1024 * 1024);
})();
const SEARCH_WORKER_MAX_TOTAL_TEXT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_MAX_TOTAL_TEXT_BYTES ?? `${96 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 256 * 1024) {
        return 96 * 1024 * 1024;
    }
    return Math.min(parsed, 1024 * 1024 * 1024);
})();
const searchIndexCacheOptions = {
    maxEntries: SEARCH_INDEX_CACHE_MAX_ENTRIES,
    ttlMs: SEARCH_INDEX_CACHE_TTL_MS,
    maxPageTextBytes: SEARCH_WORKER_MAX_PAGE_TEXT_BYTES,
    maxTotalTextBytes: SEARCH_WORKER_MAX_TOTAL_TEXT_BYTES,
};
const indexCache = new Map<string, ICachedIndex>();
const cancelledRequests = new Map<string, number>();
const requestAbortControllers = new Map<string, AbortController>();
const progressSentAt = new Map<string, number>();
const log = createLogger('search-worker');

function assertNever(value: never): never {
    throw new Error(`Unhandled search worker inbound message: ${JSON.stringify(value)}`);
}

function parseSearchWorkerRequest(value: unknown): ISearchWorkerRequest | null {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    if (
        typeof value.requestId !== 'string'
        || typeof value.pdfPath !== 'string'
        || typeof value.query !== 'string'
    ) {
        return null;
    }
    const pageCount = isFiniteWorkerMessageNumber(value.pageCount) ? value.pageCount : undefined;
    const warmup = typeof value.warmup === 'boolean' ? value.warmup : undefined;
    const matchCase = typeof value.matchCase === 'boolean' ? value.matchCase : undefined;
    const wholeWord = typeof value.wholeWord === 'boolean' ? value.wholeWord : undefined;
    const useRegex = typeof value.useRegex === 'boolean' ? value.useRegex : undefined;
    return {
        requestId: value.requestId,
        pdfPath: value.pdfPath,
        query: value.query,
        pageCount,
        warmup,
        matchCase,
        wholeWord,
        useRegex,
    };
}

function parseInboundMessage(value: unknown): TSearchWorkerInboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'cancel':
            if (typeof value.requestId !== 'string') {
                return null;
            }
            return {
                type: 'cancel',
                requestId: value.requestId,
            };
        case 'reset-cache':
            return { type: 'reset-cache' };
        case 'search': {
            const payload = parseSearchWorkerRequest(value.payload);
            if (!payload) {
                return null;
            }
            return {
                type: 'search',
                payload,
            };
        }
        default:
            return null;
    }
}

function postMessage(message: TSearchWorkerOutboundMessage) {
    parentPort?.postMessage(message);
}

async function fileExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

function isCancelled(requestId: string) {
    const expiresAt = cancelledRequests.get(requestId);
    if (expiresAt === undefined) {
        return false;
    }
    if (expiresAt <= Date.now()) {
        cancelledRequests.delete(requestId);
        return false;
    }
    return true;
}

function pruneCancelledRequests(now = Date.now()) {
    for (const [
        requestId,
        expiresAt,
    ] of cancelledRequests.entries()) {
        if (expiresAt <= now) {
            cancelledRequests.delete(requestId);
        }
    }

    if (cancelledRequests.size <= CANCELLED_REQUESTS_MAX_ENTRIES) {
        return;
    }

    const overflowCount = cancelledRequests.size - CANCELLED_REQUESTS_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const oldestRequestId = cancelledRequests.keys().next().value;
        if (typeof oldestRequestId !== 'string') {
            break;
        }
        cancelledRequests.delete(oldestRequestId);
    }
}

function markRequestCancelled(requestId: string) {
    const now = Date.now();
    pruneCancelledRequests(now);
    if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
    }
    cancelledRequests.set(requestId, now + CANCELLED_REQUEST_TTL_MS);
    pruneCancelledRequests(now);
}

function throwIfCancelled(
    requestId: string,
    signal?: AbortSignal,
) {
    if (isCancelled(requestId) || signal?.aborted) {
        throw createAbortError();
    }
}

function sendProgress(
    requestId: string,
    processed: number,
    total: number,
    force = false,
    partialResult?: ISearchExecutionResult,
) {
    const now = Date.now();
    const lastSentAt = progressSentAt.get(requestId) ?? 0;
    if (
        !force
        && processed !== 0
        && processed !== total
        && now - lastSentAt < PROGRESS_THROTTLE_MS
    ) {
        return;
    }

    progressSentAt.set(requestId, now);
    postMessage({
        type: 'progress',
        requestId,
        processed,
        total,
        results: partialResult?.results,
        truncated: partialResult?.truncated,
    });
}

function postEmptySearchComplete(requestId: string) {
    postMessage({
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function postSearchComplete(
    requestId: string,
    result: ISearchExecutionResult,
) {
    postMessage({
        type: 'complete',
        requestId,
        response: result,
    });
}

function postSearchCancelled(requestId: string) {
    postMessage({
        type: 'cancelled',
        requestId,
    });
}

function postSearchError(
    requestId: string,
    error: unknown,
) {
    const errMsg = getErrorMessage(error);
    postMessage({
        type: 'error',
        requestId,
        error: `Search failed: ${errMsg}`,
    });
}

async function createSearchRequestContext(request: ISearchWorkerRequest): Promise<ISearchRequestContext> {
    const {
        requestId,
        pdfPath,
        query,
        pageCount,
        warmup,
        matchCase = false,
        wholeWord = false,
        useRegex = false,
    } = request;

    const abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);
    const { signal } = abortController;
    pruneCancelledRequests();
    progressSentAt.delete(requestId);
    throwIfCancelled(requestId, signal);

    if (!pdfPath || !(await fileExists(pdfPath))) {
        throw new Error(`PDF not found: ${pdfPath}`);
    }
    throwIfCancelled(requestId, signal);

    return {
        requestId,
        pdfPath,
        normalizedQuery: query.trim(),
        pageCount,
        shouldWarmup: warmup === true,
        matchCase,
        wholeWord,
        useRegex,
        signal,
    };
}

async function getRequestSearchIndex(context: ISearchRequestContext) {
    const {
        requestId,
        pdfPath,
        pageCount,
        signal,
    } = context;

    const streamIndexedPage = createIndexedPageResultStreamer(context);
    const indexEntry = await ensureSearchIndex(
        indexCache,
        pdfPath,
        searchIndexCacheOptions,
        {
            pageCount,
            signal,
            throwIfCancelled: abortSignal => throwIfCancelled(requestId, abortSignal),
            onPageIndexed: streamIndexedPage,
        },
    );
    throwIfCancelled(requestId, signal);
    return indexEntry;
}

function getTotalPages(
    indexEntry: ICachedIndex,
    pageCount?: number,
) {
    return typeof pageCount === 'number' && pageCount > 0
        ? pageCount
        : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);
}

function isPageSearchable(
    page: IPdfSearchIndex['pages'][number],
    totalPages: number,
) {
    return page.pageNumber >= 1 && page.pageNumber <= totalPages;
}

function appendPageMatches(
    params: {
        context: ISearchRequestContext;
        page: IPdfSearchIndex['pages'][number];
        results: ISearchMatch[];
        globalMatchIndex: number;
    },
) {
    const {
        context,
        page,
        results,
    } = params;
    const pageText = page.text;
    let { globalMatchIndex } = params;
    let truncated = false;

    if (!pageText) {
        return {
            globalMatchIndex,
            truncated,
        };
    }

    let pageMatchIndex = 0;
    const pageMatches = findPageMatches(pageText, context.normalizedQuery, {
        matchCase: context.matchCase,
        wholeWord: context.wholeWord,
        useRegex: context.useRegex,
    });

    for (const pageMatch of pageMatches) {
        throwIfCancelled(context.requestId, context.signal);
        const startOffset = pageMatch.startOffset;
        const endOffset = pageMatch.endOffset;

        results.push({
            pageNumber: page.pageNumber,
            pageMatchIndex,
            matchIndex: globalMatchIndex,
            startOffset,
            endOffset,
            excerpt: buildExcerpt(pageText, startOffset, endOffset),
        });

        pageMatchIndex += 1;
        globalMatchIndex += 1;

        if (results.length >= SEARCH_RESULT_LIMIT) {
            truncated = true;
            break;
        }
    }

    return {
        globalMatchIndex,
        truncated,
    };
}

function createIndexedPageResultStreamer(context: ISearchRequestContext) {
    if (context.shouldWarmup || context.normalizedQuery.length === 0) {
        return undefined;
    }

    const results: ISearchMatch[] = [];
    const totalPages = typeof context.pageCount === 'number' && context.pageCount > 0
        ? context.pageCount
        : 0;
    let globalMatchIndex = 0;
    let processedCount = 0;
    let truncated = false;

    return (page: IPdfSearchIndex['pages'][number]) => {
        throwIfCancelled(context.requestId, context.signal);
        const total = totalPages || Math.max(processedCount + 1, page.pageNumber);
        if (!isPageSearchable(page, total)) {
            return;
        }

        processedCount += 1;
        if (!truncated && results.length < SEARCH_RESULT_LIMIT) {
            const previousResultCount = results.length;
            const pageResult = appendPageMatches({
                context,
                page,
                results,
                globalMatchIndex,
            });
            globalMatchIndex = pageResult.globalMatchIndex;
            truncated = pageResult.truncated;

            if (results.length !== previousResultCount || truncated) {
                sendProgress(context.requestId, processedCount, total, true, {
                    results: [...results],
                    truncated,
                });
                return;
            }
        }

        sendProgress(context.requestId, processedCount, total);
    };
}

function searchIndex(
    context: ISearchRequestContext,
    indexEntry: ICachedIndex,
): ISearchExecutionResult {
    const totalPages = getTotalPages(indexEntry, context.pageCount);
    sendProgress(context.requestId, 0, totalPages, true);

    const results: ISearchMatch[] = [];
    let globalMatchIndex = 0;
    let processedCount = 0;
    let truncated = false;

    for (let pageIdx = 0; pageIdx < indexEntry.index.pages.length; pageIdx += 1) {
        throwIfCancelled(context.requestId, context.signal);

        const page = indexEntry.index.pages[pageIdx];
        if (!page || !isPageSearchable(page, totalPages)) {
            continue;
        }

        const pageResult = appendPageMatches({
            context,
            page,
            results,
            globalMatchIndex,
        });
        globalMatchIndex = pageResult.globalMatchIndex;
        truncated = pageResult.truncated;

        processedCount += 1;
        sendProgress(context.requestId, processedCount, totalPages);

        if (truncated) {
            break;
        }
    }

    if (processedCount < totalPages) {
        sendProgress(context.requestId, totalPages, totalPages, true);
    } else {
        sendProgress(context.requestId, processedCount, totalPages, true);
    }
    throwIfCancelled(context.requestId, context.signal);

    return {
        results,
        truncated,
    };
}

function handleSearchRequestError(
    requestId: string,
    error: unknown,
) {
    if (isAbortError(error) || isCancelled(requestId)) {
        postSearchCancelled(requestId);
        return;
    }

    postSearchError(requestId, error);
}

function cleanupSearchRequest(requestId: string) {
    requestAbortControllers.delete(requestId);
    progressSentAt.delete(requestId);
    cancelledRequests.delete(requestId);
}

async function processSearchRequest(request: ISearchWorkerRequest) {
    try {
        const context = await createSearchRequestContext(request);

        if (context.normalizedQuery.length === 0 && !context.shouldWarmup) {
            throwIfCancelled(context.requestId, context.signal);
            postEmptySearchComplete(context.requestId);
            return;
        }

        const indexEntry = await getRequestSearchIndex(context);

        if (context.shouldWarmup) {
            throwIfCancelled(context.requestId, context.signal);
            postEmptySearchComplete(context.requestId);
            return;
        }

        postSearchComplete(context.requestId, searchIndex(context, indexEntry));
    } catch (error) {
        handleSearchRequestError(request.requestId, error);
    } finally {
        cleanupSearchRequest(request.requestId);
    }
}

parentPort?.on('message', (rawMessage: unknown) => {
    const message = parseInboundMessage(rawMessage);
    if (!message) {
        log.warn('Ignoring malformed search worker inbound message');
        return;
    }

    switch (message.type) {
        case 'cancel':
            markRequestCancelled(message.requestId);
            requestAbortControllers.get(message.requestId)?.abort();
            return;
        case 'reset-cache':
            indexCache.clear();
            pruneCancelledRequests();
            return;
        case 'search':
            if (requestAbortControllers.has(message.payload.requestId)) {
                postMessage({
                    type: 'error',
                    requestId: message.payload.requestId,
                    error: `Search failed: duplicate active requestId "${message.payload.requestId}"`,
                });
                return;
            }
            void processSearchRequest(message.payload);
            return;
        default:
            assertNever(message);
    }
});

log.debug('Search worker initialized');
