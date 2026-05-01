import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import {
    buildPdfSearchExcerpt,
    buildPdfSearchRegex,
    findPdfSearchMatches,
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
import {
    deleteStoreValue,
    isIndexedDbAvailable,
    readAllStoreKeys,
    readStoreValue,
    writeStoreValue,
} from '@app/platform/browser-api/browser-indexeddb';

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

interface IIterateSearchPagesOptions {
    onPage: (pageNumber: number, text: string, pageCount: number) => Promise<unknown> | unknown;
    requestId?: string;
}

interface IExtractedDocumentText {
    pageCount: number;
    pageTexts: string[];
}

type TSearchListener = (progress: IPdfSearchProgress) => void;
type TPageOutcome = 'continue' | 'stop' | 'cancel';

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

async function loadPersistedSearchCacheRecord(cacheKey: string) {
    const db = await openSearchCacheDb();
    if (!db) {
        return null;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, 'readonly');
        const store = tx.objectStore(SEARCH_CACHE_STORE);
        return await readStoreValue<IPersistedSearchDocumentCacheRecord>(store, cacheKey, 'Failed to read search cache record');
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
        await writeStoreValue(store, record, 'Failed to write search cache record');
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
        const keys = await readAllStoreKeys(store, 'Failed to list search cache records');
        for (const key of keys) {
            await deleteStoreValue(store, key, 'Failed to delete search cache record');
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

    function consumeCancellation(requestId: string | undefined) {
        if (requestId && canceledSearchRequests.has(requestId)) {
            canceledSearchRequests.delete(requestId);
            return true;
        }
        return false;
    }

    function isExtractionCanceled(requestId: string | undefined) {
        return Boolean(requestId && canceledSearchRequests.has(requestId));
    }

    function emitPageProgress(requestId: string | undefined, processed: number, total: number) {
        if (!requestId) {
            return;
        }
        const progress: IPdfSearchProgress = {
            requestId,
            processed,
            total,
        };
        searchProgressListeners.forEach((listener) => listener(progress));
    }

    function pickValidPersistedRecord(
        record: IPersistedSearchDocumentCacheRecord | null,
        fileSize: number,
    ) {
        if (!record) {
            return null;
        }
        if (record.fileSize !== fileSize) {
            return null;
        }
        if (record.pageCount !== record.pageTexts.length) {
            return null;
        }
        return record;
    }

    async function runDirectExtraction(pdfPath: string, requestId: string | undefined) {
        return extractBrowserSearchDocumentText(pdfPath, {shouldContinue: () => !isExtractionCanceled(requestId)});
    }

    async function extractDocumentTextWithFallback(
        pdfPath: string,
        requestId: string | undefined,
    ): Promise<IExtractedDocumentText | null> {
        if (!canUseBrowserSearchWorker()) {
            try {
                return await runDirectExtraction(pdfPath, requestId);
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    return null;
                }
                throw error;
            }
        }

        try {
            const workerRequest = createBrowserSearchWorkerRequest(
                'extractDocumentText',
                { pdfPath },
            );
            if (requestId) {
                activeWorkerSearchRequests.set(requestId, workerRequest.requestId);
            }
            return await workerRequest.promise;
        } catch (error) {
            if (isBrowserSearchCanceledError(error)) {
                return null;
            }
            if (!(error instanceof BrowserSearchWorkerUnavailableError)) {
                throw error;
            }
            return runDirectExtraction(pdfPath, requestId);
        } finally {
            if (requestId) {
                activeWorkerSearchRequests.delete(requestId);
            }
        }
    }

    async function deliverPage(
        pageNumber: number,
        text: string,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ): Promise<TPageOutcome> {
        if (consumeCancellation(options.requestId)) {
            return 'cancel';
        }
        const result = await options.onPage(pageNumber, text, pageCount);
        if (result === false) {
            return 'stop';
        }
        emitPageProgress(options.requestId, pageNumber, pageCount);
        await yieldAfterSearchPage(pageNumber);
        return 'continue';
    }

    async function iterateCachedDocumentPages(
        cache: IPreparedSearchDocumentCache,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ) {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            const cachedText = getCachedPageText(cache, pageNumber) ?? '';
            const outcome = await deliverPage(pageNumber, cachedText, pageCount, options);
            if (outcome === 'cancel' || outcome === 'stop') {
                return false;
            }
        }
        return true;
    }

    async function iteratePersistedDocumentPages(
        record: IPersistedSearchDocumentCacheRecord,
        options: IIterateSearchPagesOptions,
    ) {
        for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
            const text = record.pageTexts[pageNumber - 1] ?? '';
            const outcome = await deliverPage(pageNumber, text, record.pageCount, options);
            if (outcome === 'cancel') {
                return false;
            }
            if (outcome === 'stop') {
                return true;
            }
        }
        return true;
    }

    async function iterateExtractedDocumentPages(
        cache: IPreparedSearchDocumentCache,
        extracted: IExtractedDocumentText,
        options: IIterateSearchPagesOptions,
    ) {
        let shouldContinueCallbacks = true;
        for (let pageNumber = 1; pageNumber <= extracted.pageCount; pageNumber += 1) {
            if (consumeCancellation(options.requestId)) {
                return { canceled: true };
            }

            const text = extracted.pageTexts[pageNumber - 1] ?? '';
            rememberPageText(cache, pageNumber, text);

            if (
                shouldContinueCallbacks
                && await options.onPage(pageNumber, text, extracted.pageCount) === false
            ) {
                shouldContinueCallbacks = false;
            }

            emitPageProgress(options.requestId, pageNumber, extracted.pageCount);
            await yieldAfterSearchPage(pageNumber);
        }
        return { canceled: false };
    }

    async function iterateSearchPages(
        pdfPath: string,
        fileSize: number,
        options: IIterateSearchPagesOptions,
    ) {
        const cache = getDocumentCache(pdfPath);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache) && cachedPageCount) {
            return iterateCachedDocumentPages(cache, cachedPageCount, options);
        }

        const persistedRecord = await loadPersistedSearchCacheRecord(pdfPath);
        const validPersistedRecord = pickValidPersistedRecord(persistedRecord, fileSize);
        if (validPersistedRecord) {
            hydrateCacheFromPersistedRecord(cache, validPersistedRecord);
            return iteratePersistedDocumentPages(validPersistedRecord, options);
        }

        const extractedDocumentText = await extractDocumentTextWithFallback(pdfPath, options.requestId);
        if (!extractedDocumentText) {
            return false;
        }

        cache.pageCount = extractedDocumentText.pageCount;
        const { canceled } = await iterateExtractedDocumentPages(cache, extractedDocumentText, options);

        if (!canceled) {
            await persistSearchCacheRecord({
                pdfPath,
                fileSize,
                pageCount: extractedDocumentText.pageCount,
                pageTexts: extractedDocumentText.pageTexts,
            });
        }

        return !canceled;
    }

    const capability: ISearchCapability = {
        async run(pdfPath, query, options = {}) {
            await assertSearchWithinBrowserBudget(pdfPath);
            const { size } = await browserDocumentStore.stat(pdfPath);
            const requestId = options.requestId ?? crypto.randomUUID();
            const results: IPdfSearchResult[] = [];
            const matcher = buildPdfSearchRegex(query, {
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

                    const pageMatches = findPdfSearchMatches(text, matcher);
                    for (const match of pageMatches) {
                        results.push({
                            pageNumber,
                            pageMatchIndex: results.filter(result => result.pageNumber === pageNumber).length,
                            matchIndex: results.length,
                            startOffset: match.startOffset,
                            endOffset: match.endOffset,
                            excerpt: buildPdfSearchExcerpt(text, match.startOffset, match.endOffset, SEARCH_EXCERPT_CONTEXT_CHARS),
                        });
                        if (results.length >= SEARCH_RESULT_LIMIT) {
                            return false;
                        }
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
