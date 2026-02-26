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
    lowerTexts: string[];
    accessedAt: number;
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
    return {
        requestId: value.requestId,
        pdfPath: value.pdfPath,
        query: value.query,
        pageCount,
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

async function processSearchRequest(request: ISearchWorkerRequest) {
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

            const page = indexEntry.index.pages[pageIdx];
            if (!page) {
                continue;
            }
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

parentPort?.on('message', (rawMessage: unknown) => {
    const message = parseInboundMessage(rawMessage);
    if (!message) {
        log.warn('Ignoring malformed search worker inbound message');
        return;
    }

    switch (message.type) {
        case 'cancel':
            cancelledRequests.add(message.requestId);
            requestAbortControllers.get(message.requestId)?.abort();
            return;
        case 'reset-cache':
            indexCache.clear();
            return;
        case 'search':
            void processSearchRequest(message.payload);
            return;
        default:
            assertNever(message);
    }
});

log.debug('Search worker initialized');
