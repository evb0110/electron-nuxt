import { parentPort } from 'worker_threads';
import { stat } from 'fs/promises';
import type { IPdfSearchIndex } from '@electron/search/index-builder';
import {
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/search/index-builder';
import {
    EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface ISearchMatch {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: ISearchExcerpt;
}

interface ISearchRequest {
    requestId: string;
    pdfPath: string;
    query: string;
    pageCount?: number;
}

interface ISearchResponse {
    results: ISearchMatch[];
    truncated: boolean;
}

type TCachedIndex = {
    mtimeMs: number;
    index: IPdfSearchIndex;
    lowerTexts: string[];
    accessedAt: number;
};

type TWorkerInboundMessage =
    | {
        type: 'search';
        payload: ISearchRequest;
    }
    | {
        type: 'cancel';
        requestId: string;
    }
    | {type: 'reset-cache';};

type TWorkerOutboundMessage =
    | {
        type: 'progress';
        requestId: string;
        processed: number;
        total: number;
    }
    | {
        type: 'complete';
        requestId: string;
        response: ISearchResponse;
    }
    | {
        type: 'cancelled';
        requestId: string;
    }
    | {
        type: 'error';
        requestId: string;
        error: string;
    };

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
const indexCache = new Map<string, TCachedIndex>();
const cancelledRequests = new Set<string>();
const requestAbortControllers = new Map<string, AbortController>();
const progressSentAt = new Map<string, number>();
const log = createLogger('search-worker');

function postMessage(message: TWorkerOutboundMessage) {
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
    return cancelledRequests.has(requestId);
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
        lowerTexts: index.pages.map(page => (page.text ?? '').toLowerCase()),
        accessedAt: now,
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
        lowerTexts: index.pages.map(page => (page.text ?? '').toLowerCase()),
        accessedAt: now,
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
    const hasAnyText = entry.lowerTexts.some(t => t.length > 0);
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

async function processSearchRequest(request: ISearchRequest) {
    const {
        requestId,
        pdfPath,
        query,
        pageCount,
    } = request;

    const abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);
    const { signal } = abortController;

    try {
        progressSentAt.delete(requestId);
        throwIfCancelled(requestId, signal);

        if (!pdfPath || !(await fileExists(pdfPath))) {
            throw new Error(`PDF not found: ${pdfPath}`);
        }
        throwIfCancelled(requestId, signal);

        if (!query || query.trim().length === 0) {
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

        const normalizedQuery = query.trim();
        const lowerQuery = normalizedQuery.toLowerCase();
        const indexEntry = await ensureSearchIndex(requestId, pdfPath, {
            pageCount,
            signal,
        });
        throwIfCancelled(requestId, signal);

        const totalPages = typeof pageCount === 'number' && pageCount > 0
            ? pageCount
            : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);

        sendProgress(requestId, 0, totalPages, true);

        const results: ISearchMatch[] = [];
        let globalMatchIndex = 0;
        let processedCount = 0;
        let truncated = false;

        for (let pageIdx = 0; pageIdx < indexEntry.index.pages.length; pageIdx += 1) {
            throwIfCancelled(requestId, signal);

            const page = indexEntry.index.pages[pageIdx]!;
            if (page.pageNumber < 1) {
                continue;
            }
            if (page.pageNumber > totalPages) {
                break;
            }

            const pageText = page.text ?? '';

            if (pageText) {
                const lowerPageText = indexEntry.lowerTexts[pageIdx] ?? pageText.toLowerCase();
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

parentPort?.on('message', (message: TWorkerInboundMessage) => {
    if (message.type === 'cancel') {
        cancelledRequests.add(message.requestId);
        requestAbortControllers.get(message.requestId)?.abort();
        return;
    }

    if (message.type === 'reset-cache') {
        indexCache.clear();
        return;
    }

    if (message.type === 'search') {
        void processSearchRequest(message.payload);
    }
});

log.debug('Search worker initialized');
