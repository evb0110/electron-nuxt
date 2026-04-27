import { createUuid } from '@app/utils/uuid';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import type { ISearchCapability } from '@contracts/platform-api';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@app/platform/browser-api/common';
import {
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
} from '@app/platform/browser-api/browser-search-worker-client';
import { extractBrowserSearchDocumentText } from '@app/platform/browser-api/browser-search-core';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { browserDocumentStore } from '@app/platform/browser-document-store';

interface IPreparedSearchDocumentCache {
    pageCount: number | null;
    pageTexts: Map<number, string>;
    pageTextBytes: number;
    canCacheWholeDocumentText: boolean;
}

interface IPersistedSearchDocumentCacheRecord {
    pdfPath: string;
    fileSize: number;
    pageCount: number;
    pageTexts: string[];
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: () => void;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;

const SEARCH_PAGE_CACHE_LIMIT = 24;
const SEARCH_DOCUMENT_CACHE_LIMIT = 4;
const SEARCH_YIELD_INTERVAL = 1;
const BROWSER_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
const SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_CACHE_DB_NAME = 'evb-browser-search-cache';
const SEARCH_CACHE_DB_VERSION = 1;
const SEARCH_CACHE_STORE = 'document-text';

function createBrowserSearchTooLargeError() {
    return new Error('ERR_BROWSER_SEARCH_TOO_LARGE');
}

function isBrowserSearchCanceledError(error: unknown) {
    return error instanceof Error && error.message === 'ERR_BROWSER_SEARCH_CANCELED';
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(
    query: string,
    options: {
        matchCase: boolean;
        wholeWord: boolean;
        useRegex: boolean;
    },
) {
    const basePattern = options.useRegex ? query : escapeRegex(query);
    const pattern = options.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${basePattern})(?![\\p{L}\\p{N}_])`
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

function buildSearchExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
) {
    const excerptStart = Math.max(0, startOffset - SEARCH_EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(
        text.length,
        endOffset + SEARCH_EXCERPT_CONTEXT_CHARS,
    );
    const before = text
        .slice(excerptStart, startOffset)
        .replace(/\s+/g, ' ')
        .trimStart();
    const after = text
        .slice(endOffset, excerptEnd)
        .replace(/\s+/g, ' ')
        .trimEnd();

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match: text.slice(startOffset, endOffset),
        after,
    };
}

function isRecordCacheReady(cache: IPreparedSearchDocumentCache) {
    return typeof cache.pageCount === 'number'
        && cache.pageCount > 0
        && cache.canCacheWholeDocumentText
        && cache.pageTexts.size >= cache.pageCount;
}

function createDocumentCache(): IPreparedSearchDocumentCache {
    return {
        pageCount: null,
        pageTexts: new Map<number, string>(),
        pageTextBytes: 0,
        canCacheWholeDocumentText: true,
    };
}

function isIndexedDbAvailable() {
    return typeof indexedDB !== 'undefined';
}

function openSearchCacheDb(): Promise<IDBDatabase | null> {
    if (!isIndexedDbAvailable()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(SEARCH_CACHE_DB_NAME, SEARCH_CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SEARCH_CACHE_STORE)) {
                db.createObjectStore(SEARCH_CACHE_STORE, { keyPath: 'pdfPath' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open search cache database'));
    });
}

function readStoreValue<T>(
    store: IDBObjectStore,
    key: IDBValidKey,
): Promise<T | null> {
    return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error('Failed to read search cache record'));
    });
}

function writeStoreValue(
    store: IDBObjectStore,
    value: IPersistedSearchDocumentCacheRecord,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.put(value);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to write search cache record'));
    });
}

function deleteStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to delete search cache record'));
    });
}

function getAllStoreKeys(store: IDBObjectStore): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve((request.result as IDBValidKey[] | undefined) ?? []);
        request.onerror = () => reject(request.error ?? new Error('Failed to list search cache records'));
    });
}

async function loadPersistedSearchCacheRecord(cacheKey: string) {
    const db = await openSearchCacheDb();
    if (!db) {
        return null;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, 'readonly');
        const store = tx.objectStore(SEARCH_CACHE_STORE);
        return await readStoreValue<IPersistedSearchDocumentCacheRecord>(store, cacheKey);
    } finally {
        db.close();
    }
}

async function persistSearchCacheRecord(
    record: IPersistedSearchDocumentCacheRecord,
) {
    const db = await openSearchCacheDb();
    if (!db) {
        return;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, 'readwrite');
        const store = tx.objectStore(SEARCH_CACHE_STORE);
        await writeStoreValue(store, record);
    } finally {
        db.close();
    }
}

async function clearPersistedSearchCaches() {
    const db = await openSearchCacheDb();
    if (!db) {
        return;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, 'readwrite');
        const store = tx.objectStore(SEARCH_CACHE_STORE);
        const keys = await getAllStoreKeys(store);
        for (const key of keys) {
            await deleteStoreValue(store, key);
        }
    } finally {
        db.close();
    }
}

function hydrateCacheFromPersistedRecord(
    cache: IPreparedSearchDocumentCache,
    record: IPersistedSearchDocumentCacheRecord | null,
) {
    if (!record || cache.pageTexts.size > 0) {
        return;
    }

    cache.pageCount = record.pageCount;
    cache.pageTexts = new Map();
    cache.pageTextBytes = 0;
    cache.canCacheWholeDocumentText = true;

    record.pageTexts.forEach((text, index) => {
        rememberPageText(cache, index + 1, text);
    });
}

function yieldAfterSearchPage(pageNumber: number) {
    return pageNumber % SEARCH_YIELD_INTERVAL === 0 ? yieldToBrowser() : Promise.resolve();
}

function rememberPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
    text: string,
) {
    const existing = cache.pageTexts.get(pageNumber);
    if (typeof existing === 'string') {
        cache.pageTextBytes -= existing.length * 2;
        cache.pageTexts.delete(pageNumber);
    }
    cache.pageTexts.set(pageNumber, text);
    cache.pageTextBytes += text.length * 2;

    if (
        cache.canCacheWholeDocumentText
        && cache.pageTextBytes <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES
    ) {
        return;
    }

    cache.canCacheWholeDocumentText = false;
    while (cache.pageTexts.size > SEARCH_PAGE_CACHE_LIMIT) {
        const oldestPage = cache.pageTexts.keys().next().value;
        if (typeof oldestPage !== 'number') {
            break;
        }
        const oldestText = cache.pageTexts.get(oldestPage);
        if (typeof oldestText === 'string') {
            cache.pageTextBytes -= oldestText.length * 2;
        }
        cache.pageTexts.delete(oldestPage);
    }
}

function getCachedPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
) {
    const cached = cache.pageTexts.get(pageNumber);
    if (typeof cached !== 'string') {
        return null;
    }

    cache.pageTexts.delete(pageNumber);
    cache.pageTexts.set(pageNumber, cached);
    return cached;
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const searchDocumentCache = new Map<string, IPreparedSearchDocumentCache>();
    const canceledSearchRequests = new Set<string>();
    const activeWorkerSearchRequests = new Map<string, number>();

    function getDocumentCache(pdfPath: string) {
        let cache = searchDocumentCache.get(pdfPath);
        if (!cache) {
            while (searchDocumentCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT) {
                const oldestKey = searchDocumentCache.keys().next().value;
                if (typeof oldestKey !== 'string') {
                    break;
                }
                searchDocumentCache.delete(oldestKey);
            }
            cache = createDocumentCache();
            searchDocumentCache.set(pdfPath, cache);
        }
        return cache;
    }

    function clearSearchCaches() {
        searchDocumentCache.clear();
        void clearPersistedSearchCaches();
    }

    async function assertSearchWithinBrowserBudget(pdfPath: string) {
        const { size } = await browserDocumentStore.stat(pdfPath);
        if (size > BROWSER_SEARCH_MAX_BYTES) {
            throw createBrowserSearchTooLargeError();
        }
    }

    async function iterateSearchPages(
        pdfPath: string,
        fileSize: number,
        options: {
            onPage: (pageNumber: number, text: string, pageCount: number) => Promise<unknown> | unknown;
            requestId?: string;
        },
    ) {
        const cache = getDocumentCache(pdfPath);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache) && cachedPageCount) {
            for (let pageNumber = 1; pageNumber <= cachedPageCount; pageNumber += 1) {
                if (options.requestId && canceledSearchRequests.has(options.requestId)) {
                    canceledSearchRequests.delete(options.requestId);
                    return false;
                }

                const cachedText = getCachedPageText(cache, pageNumber) ?? '';
                if (await options.onPage(pageNumber, cachedText, cachedPageCount) === false) {
                    return false;
                }

                if (options.requestId) {
                    const progress: IPdfSearchProgress = {
                        requestId: options.requestId,
                        processed: pageNumber,
                        total: cachedPageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                }
                await yieldAfterSearchPage(pageNumber);
            }
            return true;
        }

        const persistentCacheKey = pdfPath;
        const persistedRecord = await loadPersistedSearchCacheRecord(persistentCacheKey);
        const validPersistedRecord = persistedRecord
            && persistedRecord.fileSize === fileSize
            && persistedRecord.pageCount === persistedRecord.pageTexts.length
            ? persistedRecord
            : null;
        if (validPersistedRecord) {
            hydrateCacheFromPersistedRecord(cache, validPersistedRecord);

            for (let pageNumber = 1; pageNumber <= validPersistedRecord.pageCount; pageNumber += 1) {
                if (options.requestId && canceledSearchRequests.has(options.requestId)) {
                    canceledSearchRequests.delete(options.requestId);
                    return false;
                }

                const text = validPersistedRecord.pageTexts[pageNumber - 1] ?? '';
                if (await options.onPage(pageNumber, text, validPersistedRecord.pageCount) === false) {
                    return true;
                }

                if (options.requestId) {
                    const progress: IPdfSearchProgress = {
                        requestId: options.requestId,
                        processed: pageNumber,
                        total: validPersistedRecord.pageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                }
                await yieldAfterSearchPage(pageNumber);
            }

            return true;
        }

        let extractedDocumentText: {
            pageCount: number;
            pageTexts: string[];
        };

        if (canUseBrowserSearchWorker()) {
            try {
                const workerRequest = createBrowserSearchWorkerRequest(
                    'extractDocumentText',
                    { pdfPath },
                );
                if (options.requestId) {
                    activeWorkerSearchRequests.set(options.requestId, workerRequest.requestId);
                }
                extractedDocumentText = await workerRequest.promise;
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    return false;
                }
                if (!(error instanceof BrowserSearchWorkerUnavailableError)) {
                    throw error;
                }
                extractedDocumentText = await extractBrowserSearchDocumentText(pdfPath, {shouldContinue: () => !(options.requestId && canceledSearchRequests.has(options.requestId))});
            } finally {
                if (options.requestId) {
                    activeWorkerSearchRequests.delete(options.requestId);
                }
            }
        } else {
            try {
                extractedDocumentText = await extractBrowserSearchDocumentText(pdfPath, {shouldContinue: () => !(options.requestId && canceledSearchRequests.has(options.requestId))});
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    return false;
                }
                throw error;
            }
        }

        cache.pageCount = extractedDocumentText.pageCount;
        let shouldContinueCallbacks = true;
        let canceled = false;

        try {
            for (let pageNumber = 1; pageNumber <= extractedDocumentText.pageCount; pageNumber += 1) {
                if (options.requestId && canceledSearchRequests.has(options.requestId)) {
                    canceledSearchRequests.delete(options.requestId);
                    canceled = true;
                    return false;
                }

                const text = extractedDocumentText.pageTexts[pageNumber - 1] ?? '';
                rememberPageText(cache, pageNumber, text);
                if (
                    shouldContinueCallbacks
                    && await options.onPage(pageNumber, text, extractedDocumentText.pageCount) === false
                ) {
                    shouldContinueCallbacks = false;
                }

                if (options.requestId) {
                    const progress: IPdfSearchProgress = {
                        requestId: options.requestId,
                        processed: pageNumber,
                        total: extractedDocumentText.pageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                }

                await yieldAfterSearchPage(pageNumber);
            }

            return true;
        } finally {
            if (!canceled) {
                await persistSearchCacheRecord({
                    pdfPath: persistentCacheKey,
                    fileSize,
                    pageCount: extractedDocumentText.pageCount,
                    pageTexts: extractedDocumentText.pageTexts,
                });
            }
        }
    }

    const capability: ISearchCapability = {
        async run(pdfPath, query, options = {}) {
            await assertSearchWithinBrowserBudget(pdfPath);
            const { size } = await browserDocumentStore.stat(pdfPath);
            const requestId = options.requestId ?? createUuid();
            const results: IPdfSearchResult[] = [];
            const matcher = buildSearchRegex(query, {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            });

            const completed = await iterateSearchPages(pdfPath, size, {
                requestId,
                onPage: async (pageNumber, text, pageCount) => {
                    if (canceledSearchRequests.has(requestId)) {
                        canceledSearchRequests.delete(requestId);
                        return false;
                    }

                    matcher.lastIndex = 0;
                    let match = matcher.exec(text);
                    let pageMatchIndex = 0;

                    while (match) {
                        const matchedText = match[0] ?? '';
                        if (matchedText.length === 0) {
                            matcher.lastIndex = match.index + 1;
                            match = matcher.exec(text);
                            continue;
                        }

                        results.push({
                            pageNumber,
                            pageMatchIndex,
                            matchIndex: results.length,
                            startOffset: match.index,
                            endOffset: match.index + matchedText.length,
                            excerpt: buildSearchExcerpt(
                                text,
                                match.index,
                                match.index + matchedText.length,
                            ),
                        });
                        pageMatchIndex += 1;

                        if (results.length >= SEARCH_RESULT_LIMIT) {
                            return false;
                        }

                        match = matcher.exec(text);
                    }

                    const progress: IPdfSearchProgress = {
                        requestId,
                        processed: pageNumber,
                        total: pageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                    await yieldToBrowser();
                    return true;
                },
            });

            if (!completed && canceledSearchRequests.has(requestId)) {
                canceledSearchRequests.delete(requestId);
                return {
                    results: [],
                    truncated: false,
                };
            }

            return {
                results,
                truncated: results.length >= SEARCH_RESULT_LIMIT,
            } satisfies IPdfSearchResponse;
        },
        async warmIndex(pdfPath) {
            await assertSearchWithinBrowserBudget(pdfPath);
            const { size } = await browserDocumentStore.stat(pdfPath);
            await iterateSearchPages(pdfPath, size, {onPage: async () => {
                await yieldToBrowser();
            }});
            return true;
        },
        cancel(requestId) {
            if (requestId) {
                canceledSearchRequests.add(requestId);
                const workerRequestId = activeWorkerSearchRequests.get(requestId);
                if (typeof workerRequestId === 'number') {
                    void cancelBrowserSearchWorkerRequest(workerRequestId);
                }
            }
            return Promise.resolve({ canceled: true });
        },
        onProgress(callback) {
            searchProgressListeners.add(callback);
            return () => {
                searchProgressListeners.delete(callback);
            };
        },
        resetCache() {
            clearSearchCaches();
            void clearPersistedSearchCaches();
            return Promise.resolve(true);
        },
    };

    return {
        capability,
        clearSearchCaches,
    };
}
