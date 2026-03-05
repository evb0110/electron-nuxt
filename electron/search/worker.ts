import { parentPort } from 'worker_threads';
import { stat } from 'fs/promises';
import type { IPdfSearchIndex } from '@electron/search/index-builder';
import {
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/search/index-builder';
import type {
    ISearchExcerpt,
    ISearchMatch,
    ISearchWorkerRequest,
    TSearchWorkerInboundMessage,
    TSearchWorkerOutboundMessage,
} from '@electron/search/protocol';
import {
    EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

type TCachedIndex = {
    mtimeMs: number;
    index: IPdfSearchIndex;
    accessedAt: number;
    preparedPages: IPreparedSearchPage[] | null;
};

interface IPreparedSearchPage {
    pageNumber: number;
    sourcePageIndex: number;
    lowerText: string;
}

const PROGRESS_THROTTLE_MS = 60;
const SEARCH_INDEX_CACHE_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES ?? '8', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 8;
    }
    return Math.min(parsed, 128);
})();
const SEARCH_INDEX_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_INDEX_CACHE_TTL_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 30_000) {
        return 10 * 60 * 1000;
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
const indexCache = new Map<string, TCachedIndex>();
const cancelledRequests = new Map<string, number>();
const requestAbortControllers = new Map<string, AbortController>();
const progressSentAt = new Map<string, number>();
const log = createLogger('search-worker');

function assertNever(value: never): never {
    throw new Error(`Unhandled search worker inbound message: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseSearchWorkerRequest(value: unknown): ISearchWorkerRequest | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.requestId !== 'string'
        || typeof value.pdfPath !== 'string'
        || typeof value.query !== 'string'
    ) {
        return null;
    }
    const pageCount = isFiniteNumber(value.pageCount) ? value.pageCount : undefined;
    const warmup = typeof value.warmup === 'boolean' ? value.warmup : undefined;
    return {
        requestId: value.requestId,
        pdfPath: value.pdfPath,
        query: value.query,
        pageCount,
        warmup,
    };
}

function parseInboundMessage(value: unknown): TSearchWorkerInboundMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string') {
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

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

function pruneIndexCache(now = Date.now()) {
    for (const [
        pdfPath,
        entry,
    ] of indexCache.entries()) {
        if (now - entry.accessedAt > SEARCH_INDEX_CACHE_TTL_MS) {
            indexCache.delete(pdfPath);
        }
    }

    if (indexCache.size <= SEARCH_INDEX_CACHE_MAX_ENTRIES) {
        return;
    }

    const sortedByLeastRecentlyUsed = Array.from(indexCache.entries())
        .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    const overflowCount = indexCache.size - SEARCH_INDEX_CACHE_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const entry = sortedByLeastRecentlyUsed[index];
        if (!entry) {
            break;
        }
        indexCache.delete(entry[0]);
    }
}

function buildExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
): ISearchExcerpt {
    const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

    const beforeRaw = text.slice(excerptStart, startOffset);
    const match = text.slice(startOffset, endOffset);
    const afterRaw = text.slice(endOffset, excerptEnd);

    const before = beforeRaw.replace(/\s+/g, ' ').trimStart();
    const after = afterRaw.replace(/\s+/g, ' ').trimEnd();

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match,
        after,
    };
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

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown) {
    return error instanceof Error && (
        error.name === 'AbortError'
        || error.message.toLowerCase().includes('aborted')
    );
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
    });
}

async function loadCachedIndex(pdfPath: string): Promise<TCachedIndex | null> {
    const now = Date.now();
    pruneIndexCache(now);
    const indexPath = getIndexPath(pdfPath);

    let mtimeMs: number;
    try {
        mtimeMs = (await stat(indexPath)).mtimeMs;
    } catch {
        indexCache.delete(pdfPath);
        return null;
    }

    const cached = indexCache.get(pdfPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        cached.accessedAt = now;
        return cached;
    }

    const index = await loadSearchIndex(pdfPath);
    if (!index) {
        indexCache.delete(pdfPath);
        return null;
    }

    const entry: TCachedIndex = {
        mtimeMs,
        index,
        accessedAt: now,
        preparedPages: null,
    };
    indexCache.set(pdfPath, entry);
    pruneIndexCache(now);
    return entry;
}

async function cacheBuiltIndex(
    pdfPath: string,
    index: IPdfSearchIndex,
): Promise<TCachedIndex> {
    const now = Date.now();
    pruneIndexCache(now);
    const indexPath = getIndexPath(pdfPath);
    let mtimeMs: number;
    try {
        mtimeMs = (await stat(indexPath)).mtimeMs;
    } catch {
        mtimeMs = Date.now();
    }

    const entry: TCachedIndex = {
        mtimeMs,
        index,
        accessedAt: now,
        preparedPages: null,
    };
    indexCache.set(pdfPath, entry);
    pruneIndexCache(now);
    return entry;
}

async function ensureSearchIndex(
    requestId: string,
    pdfPath: string,
    options: {
        pageCount?: number;
        signal?: AbortSignal;
    },
): Promise<TCachedIndex> {
    const expectedCount = options.pageCount;
    const { signal } = options;
    throwIfCancelled(requestId, signal);

    let entry = await loadCachedIndex(pdfPath);
    throwIfCancelled(requestId, signal);
    if (!entry) {
        entry = await cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], {
                pageCount: expectedCount,
                signal,
            }),
        );
        return entry;
    }

    // Detect stale indexes where all pages have empty text (e.g. previous
    // pdftotext extraction failed silently) and force a rebuild.
    const hasAnyText = entry.index.pages.some(page => (page.text ?? '').length > 0);
    if (!hasAnyText && entry.index.pages.length > 0) {
        entry = await cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], {
                pageCount: expectedCount,
                signal,
            }),
        );
        return entry;
    }

    if (
        typeof expectedCount === 'number'
        && expectedCount > 0
        && entry.index.pages.length < expectedCount
    ) {
        entry = await cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], {
                pageCount: expectedCount,
                signal,
            }),
        );
    } else if (typeof expectedCount === 'number' && expectedCount > 0) {
        const inRangeCount = entry.index.pages.reduce((count, page) => (
            count + (page.pageNumber >= 1 && page.pageNumber <= expectedCount ? 1 : 0)
        ), 0);

        if (inRangeCount < expectedCount) {
            entry = await cacheBuiltIndex(
                pdfPath,
                await buildSearchIndex(pdfPath, [], {
                    pageCount: expectedCount,
                    signal,
                }),
            );
        }
    }

    return entry;
}

function ensurePreparedSearchPages(entry: TCachedIndex): IPreparedSearchPage[] {
    if (entry.preparedPages) {
        return entry.preparedPages;
    }

    let totalResidentTextBytes = 0;
    const preparedPages = entry.index.pages.map((page, sourcePageIndex) => {
        const pageText = page.text ?? '';
        const pageTextBytes = Buffer.byteLength(pageText, 'utf8');
        if (pageTextBytes > SEARCH_WORKER_MAX_PAGE_TEXT_BYTES) {
            throw new Error(
                `Search index page ${page.pageNumber} is too large (${Math.round(pageTextBytes / 1024)}KB > `
                + `${Math.round(SEARCH_WORKER_MAX_PAGE_TEXT_BYTES / 1024)}KB limit)`,
            );
        }

        const lowerText = pageText ? pageText.toLowerCase() : '';
        const lowerTextBytes = Buffer.byteLength(lowerText, 'utf8');
        totalResidentTextBytes += pageTextBytes + lowerTextBytes;
        if (totalResidentTextBytes > SEARCH_WORKER_MAX_TOTAL_TEXT_BYTES) {
            throw new Error(
                `Search index resident text budget exceeded (${Math.round(totalResidentTextBytes / (1024 * 1024))}MB > `
                + `${Math.round(SEARCH_WORKER_MAX_TOTAL_TEXT_BYTES / (1024 * 1024))}MB limit)`,
            );
        }

        return {
            pageNumber: page.pageNumber,
            sourcePageIndex,
            lowerText,
        };
    });

    entry.preparedPages = preparedPages;
    return preparedPages;
}

async function processSearchRequest(request: ISearchWorkerRequest) {
    const {
        requestId,
        pdfPath,
        query,
        pageCount,
        warmup,
    } = request;

    const abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);
    const { signal } = abortController;
    pruneCancelledRequests();

    try {
        progressSentAt.delete(requestId);
        throwIfCancelled(requestId, signal);

        if (!pdfPath || !(await fileExists(pdfPath))) {
            throw new Error(`PDF not found: ${pdfPath}`);
        }
        throwIfCancelled(requestId, signal);

        const normalizedQuery = query.trim();
        const shouldWarmup = warmup === true;
        if (normalizedQuery.length === 0 && !shouldWarmup) {
            throwIfCancelled(requestId, signal);
            postMessage({
                type: 'complete',
                requestId,
                response: {
                    results: [],
                    truncated: false,
                },
            });
            return;
        }

        const indexEntry = await ensureSearchIndex(requestId, pdfPath, {
            pageCount,
            signal,
        });
        throwIfCancelled(requestId, signal);
        const preparedPages = ensurePreparedSearchPages(indexEntry);

        if (shouldWarmup) {
            throwIfCancelled(requestId, signal);
            postMessage({
                type: 'complete',
                requestId,
                response: {
                    results: [],
                    truncated: false,
                },
            });
            return;
        }

        const lowerQuery = normalizedQuery.toLowerCase();

        const totalPages = typeof pageCount === 'number' && pageCount > 0
            ? pageCount
            : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);

        sendProgress(requestId, 0, totalPages, true);

        const results: ISearchMatch[] = [];
        let globalMatchIndex = 0;
        let processedCount = 0;
        let truncated = false;

        for (let pageIdx = 0; pageIdx < preparedPages.length; pageIdx += 1) {
            throwIfCancelled(requestId, signal);

            const page = preparedPages[pageIdx];
            if (!page) {
                continue;
            }
            if (page.pageNumber < 1) {
                continue;
            }
            if (page.pageNumber > totalPages) {
                continue;
            }

            const sourcePage = indexEntry.index.pages[page.sourcePageIndex];
            const pageText = sourcePage?.text ?? '';

            if (pageText) {
                const lowerPageText = page.lowerText;
                let position = 0;
                let pageMatchIndex = 0;

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    throwIfCancelled(requestId, signal);
                    const startOffset = position;
                    const endOffset = position + normalizedQuery.length;

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
                    position += normalizedQuery.length;

                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        truncated = true;
                        break;
                    }
                }
            }

            processedCount += 1;
            sendProgress(requestId, processedCount, totalPages);

            if (truncated) {
                break;
            }
        }

        if (processedCount < totalPages) {
            sendProgress(requestId, totalPages, totalPages, true);
        } else {
            sendProgress(requestId, processedCount, totalPages, true);
        }
        throwIfCancelled(requestId, signal);

        postMessage({
            type: 'complete',
            requestId,
            response: {
                results,
                truncated,
            },
        });
    } catch (error) {
        if (isAbortError(error) || isCancelled(requestId)) {
            postMessage({
                type: 'cancelled',
                requestId,
            });
            return;
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        postMessage({
            type: 'error',
            requestId,
            error: `Search failed: ${errMsg}`,
        });
    } finally {
        requestAbortControllers.delete(request.requestId);
        progressSentAt.delete(request.requestId);
        cancelledRequests.delete(request.requestId);
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
