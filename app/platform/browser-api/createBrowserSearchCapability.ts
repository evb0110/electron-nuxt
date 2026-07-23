import {isRecord} from '@contracts/runtimeGuards';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import {
    buildPdfSearchExcerpt,
    collectSearchMatchWords,
    iteratePdfSearchMatches,
} from '@pdf-core';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    SEARCH_PLATFORM_FEATURE,
    ISearchCapability,
} from '@contracts/searchPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@app/platform/browser-api/browserSearchLimits';
import {
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
} from '@app/platform/browser-api/browserSearchWorkerClient';
import {
    extractBrowserSearchDocumentText,
    iterateBrowserSearchDocumentPages,
} from '@app/platform/browser-api/browserSearchCore';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import type { IOcrWord } from '@contracts/shared';
import {
    clearStore,
    deleteStoreValue,
    isIndexedDbAvailable,
    readStoreValue,
    writeStoreValue,
} from '@app/platform/browser-api/browserIndexeddb';
import { createBrowserSafeId } from '@app/utils/browserSafe';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IPreparedSearchDocumentCache {
    pageCount: number | null;
    pageTexts: Map<number, string>;
    pageGeometries: Map<number, ISearchPageGeometry>;
    pageTextBytes: number;
    canCacheWholeDocumentText: boolean;
}

interface IPersistedSearchDocumentCacheRecord {
    version?: number;
    pdfPath: string;
    fileSize: number;
    contentSignature?: string;
    documentRevision?: string;
    pageCount: number;
    pageTexts: string[];
    textBytes?: number;
    lastAccessedAt?: number;
    createdAt?: number;
    textSource?: ISearchDocumentTextSource;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: (pdfPath?: string) => Promise<void>;
}

interface IIterateSearchPagesOptions {
    onPage: (page: ISearchPageData, pageCount: number) => Promise<unknown> | unknown;
    requestId?: string;
    expectedPageCount?: number;
    streamDirectExtraction?: boolean;
    continueExtractionAfterStop?: boolean;
    requireGeometry?: boolean;
}

interface IExtractedDocumentText {
    pageCount: number;
    pageTexts: string[];
    textSource?: ISearchDocumentTextSource;
}

interface ISearchDocumentTextSource {
    kind: string;
    version: number;
}

interface ISearchPageGeometry {
    words: readonly IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

interface ISearchPageData {
    pageNumber: number;
    text: string;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;
type TPageOutcome = 'continue' | 'stop' | 'cancel';

const SEARCH_PAGE_CACHE_LIMIT = 24;
const SEARCH_DOCUMENT_CACHE_LIMIT = 4;
const SEARCH_YIELD_INTERVAL = 1;
const BROWSER_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
const SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SEARCH_PERSISTED_CACHE_MAX_RECORDS = 16;
const SEARCH_PERSISTED_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const SEARCH_CACHE_DB_NAME = 'evb-browser-search-cache';
const SEARCH_CACHE_DB_VERSION = 2;
const SEARCH_CACHE_RECORD_VERSION = 7;
const SEARCH_CACHE_STORE = 'document-text';
const SEARCH_CACHE_LAST_ACCESSED_INDEX = 'last-accessed-at';
const PDFJS_TEXT_SOURCE: ISearchDocumentTextSource = {
    kind: 'pdfjs-text-content',
    version: 1,
};
let searchCacheAccessSequence = 0;

function createBrowserSearchTooLargeError() {
    return new Error('ERR_BROWSER_SEARCH_TOO_LARGE');
}

function isBrowserSearchCanceledError(error: unknown) {
    return error instanceof Error && error.message === 'ERR_BROWSER_SEARCH_CANCELED';
}

function hasCachedGeometryForEveryPage(cache: IPreparedSearchDocumentCache) {
    if (typeof cache.pageCount !== 'number' || cache.pageCount <= 0) {
        return false;
    }
    for (let pageNumber = 1; pageNumber <= cache.pageCount; pageNumber += 1) {
        if (!cache.pageGeometries.has(pageNumber)) {
            return false;
        }
    }
    return true;
}

function isRecordCacheReady(
    cache: IPreparedSearchDocumentCache,
    requireGeometry = false,
) {
    return typeof cache.pageCount === 'number'
        && cache.pageCount > 0
        && cache.canCacheWholeDocumentText
        && cache.pageTexts.size >= cache.pageCount
        && (!requireGeometry || hasCachedGeometryForEveryPage(cache));
}

function createDocumentCache(): IPreparedSearchDocumentCache {
    return {
        pageCount: null,
        pageTexts: new Map<number, string>(),
        pageGeometries: new Map<number, ISearchPageGeometry>(),
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
            const store = db.objectStoreNames.contains(SEARCH_CACHE_STORE)
                ? request.transaction?.objectStore(SEARCH_CACHE_STORE)
                : db.createObjectStore(SEARCH_CACHE_STORE, { keyPath: 'pdfPath' });
            if (store && !store.indexNames.contains(SEARCH_CACHE_LAST_ACCESSED_INDEX)) {
                store.createIndex(SEARCH_CACHE_LAST_ACCESSED_INDEX, 'lastAccessedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open search cache database'));
    });
}

function estimatePageTextBytes(pageTexts: string[]) {
    return pageTexts.reduce((total, text) => total + (text.length * 2), 0);
}


function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function parseSearchDocumentTextSource(value: unknown): ISearchDocumentTextSource | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (typeof value.kind !== 'string' || typeof value.version !== 'number' || !Number.isInteger(value.version)) {
        return undefined;
    }
    return {
        kind: value.kind,
        version: value.version,
    };
}

function parsePersistedSearchCacheRecord(value: unknown): IPersistedSearchDocumentCacheRecord | null {
    if (!isRecord(value)) {
        return null;
    }
    const pageTexts = value.pageTexts;
    if (
        typeof value.pdfPath !== 'string'
        || typeof value.fileSize !== 'number'
        || !Number.isFinite(value.fileSize)
        || value.fileSize < 0
        || !isPositiveInteger(value.pageCount)
        || !Array.isArray(pageTexts)
        || pageTexts.some(item => typeof item !== 'string')
    ) {
        return null;
    }

    const textSource = parseSearchDocumentTextSource(value.textSource);
    const textBytes = finiteNumberOrUndefined(value.textBytes);
    const lastAccessedAt = finiteNumberOrUndefined(value.lastAccessedAt);
    const createdAt = finiteNumberOrUndefined(value.createdAt);
    const parsedPageTexts: string[] = [];
    for (const item of pageTexts) {
        if (typeof item === 'string') {
            parsedPageTexts.push(item);
        }
    }
    return {
        ...(typeof value.version === 'number' ? { version: value.version } : {}),
        pdfPath: value.pdfPath,
        fileSize: value.fileSize,
        ...(typeof value.contentSignature === 'string' ? { contentSignature: value.contentSignature } : {}),
        ...(typeof value.documentRevision === 'string' ? { documentRevision: value.documentRevision } : {}),
        pageCount: value.pageCount,
        pageTexts: parsedPageTexts,
        ...(textBytes !== undefined ? { textBytes } : {}),
        ...(lastAccessedAt !== undefined ? { lastAccessedAt } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(textSource !== undefined ? { textSource } : {}),
    };
}

function getPersistedRecordBytes(record: IPersistedSearchDocumentCacheRecord) {
    return typeof record.textBytes === 'number'
        ? record.textBytes
        : estimatePageTextBytes(record.pageTexts);
}

function createSearchCacheAccessTimestamp() {
    searchCacheAccessSequence += 1;
    return (Date.now() * 1000) + searchCacheAccessSequence;
}

function waitForTransaction(transaction: IDBTransaction, errorMessage: string) {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error(errorMessage));
        transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
    });
}

async function runSearchCacheTransaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
) {
    const db = await openSearchCacheDb();
    if (!db) {
        return null;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, mode);
        let transactionError: unknown = null;
        const done = waitForTransaction(tx, 'Search cache transaction failed')
            .catch((error: unknown) => {
                transactionError = error;
            });
        try {
            const result = await run(tx.objectStore(SEARCH_CACHE_STORE));
            await done;
            if (transactionError) {
                throw transactionError instanceof Error
                    ? transactionError
                    : new Error(String(transactionError));
            }
            return result;
        } catch (error) {
            await done;
            throw error instanceof Error
                ? error
                : new Error(String(error));
        }
    } finally {
        db.close();
    }
}

async function loadPersistedSearchCacheRecord(cacheKey: string) {
    return runSearchCacheTransaction(
        'readonly',
        (store) => readStoreValue(
            store,
            cacheKey,
            'Failed to read search cache record',
            parsePersistedSearchCacheRecord,
        ),
    );
}

async function deletePersistedSearchCacheRecord(cacheKey: string) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => deleteStoreValue(store, cacheKey, 'Failed to delete search cache record'),
    );
}

async function touchPersistedSearchCacheRecord(record: IPersistedSearchDocumentCacheRecord) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => writeStoreValue(
            store,
            {
                ...record,
                textBytes: getPersistedRecordBytes(record),
                lastAccessedAt: createSearchCacheAccessTimestamp(),
            },
            'Failed to touch search cache record',
        ),
    );
}

async function persistSearchCacheRecord(
    record: IPersistedSearchDocumentCacheRecord,
) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => writeStoreValue(
            store,
            {
                ...record,
                textBytes: estimatePageTextBytes(record.pageTexts),
                lastAccessedAt: createSearchCacheAccessTimestamp(),
            },
            'Failed to write search cache record',
        ),
    );
    await prunePersistedSearchCaches();
}

async function persistSearchCacheRecordBestEffort(
    record: IPersistedSearchDocumentCacheRecord,
) {
    try {
        await persistSearchCacheRecord(record);
    } catch (error) {
        BrowserLogger.warn('search', 'Search completed but cache persistence failed', {
            pdfPath: record.pdfPath,
            pageCount: record.pageCount,
            error,
        });
    }
}

async function clearPersistedSearchCaches() {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => clearStore(store, 'Failed to clear search cache records'),
    );
}

async function prunePersistedSearchCaches() {
    await runSearchCacheTransaction('readwrite', store => new Promise<void>((resolve, reject) => {
        let keptRecords = 0;
        let keptBytes = 0;
        const request = store.index(SEARCH_CACHE_LAST_ACCESSED_INDEX).openCursor(null, 'prev');
        request.onerror = () => reject(request.error ?? new Error('Failed to prune search cache records'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            const record = parsePersistedSearchCacheRecord(cursor.value);
            const recordBytes = record === null ? 0 : getPersistedRecordBytes(record);
            const shouldDelete = record === null
                || keptRecords >= SEARCH_PERSISTED_CACHE_MAX_RECORDS
                || keptBytes + recordBytes > SEARCH_PERSISTED_CACHE_MAX_BYTES;
            if (shouldDelete) {
                cursor.delete();
            } else {
                keptRecords += 1;
                keptBytes += recordBytes;
            }
            cursor.continue();
        };
    }));
}

async function clearPersistedSearchCacheForDocument(pdfPath: string) {
    await deletePersistedSearchCacheRecord(pdfPath);
}

function createPersistedSearchCacheRecord(
    pdfPath: string,
    fileSize: number,
    contentSignature: string,
    documentRevision: string,
    pageCount: number,
    pageTexts: string[],
    textSource: ISearchDocumentTextSource = PDFJS_TEXT_SOURCE,
): IPersistedSearchDocumentCacheRecord {
    const now = createSearchCacheAccessTimestamp();
    return {
        version: SEARCH_CACHE_RECORD_VERSION,
        pdfPath,
        fileSize,
        contentSignature,
        documentRevision,
        pageCount,
        pageTexts,
        textBytes: estimatePageTextBytes(pageTexts),
        createdAt: now,
        lastAccessedAt: now,
        textSource,
    };
}

function canPersistPageTexts(pageTexts: string[]) {
    return estimatePageTextBytes(pageTexts) <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES;
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
    cache.pageGeometries = new Map();
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
        cache.pageGeometries.delete(oldestPage);
    }
}

function hasSearchPageGeometry(page: ISearchPageData): page is ISearchPageData & ISearchPageGeometry {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0;
}

function rememberPageData(
    cache: IPreparedSearchDocumentCache,
    page: ISearchPageData,
) {
    rememberPageText(cache, page.pageNumber, page.text);
    if (hasSearchPageGeometry(page)) {
        cache.pageGeometries.set(page.pageNumber, {
            words: page.words,
            pageWidth: page.pageWidth,
            pageHeight: page.pageHeight,
        });
    } else {
        cache.pageGeometries.delete(page.pageNumber);
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

function getCachedPageData(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
    requireGeometry: boolean,
): ISearchPageData | null {
    const text = getCachedPageText(cache, pageNumber);
    if (typeof text !== 'string') {
        return null;
    }
    const geometry = cache.pageGeometries.get(pageNumber);
    if (requireGeometry && !geometry) {
        return null;
    }
    return {
        pageNumber,
        text,
        ...(geometry ? {
            words: geometry.words,
            pageWidth: geometry.pageWidth,
            pageHeight: geometry.pageHeight,
        } : {}),
    };
}

function resetExtractedPageCache(cache: IPreparedSearchDocumentCache) {
    cache.pageTexts.clear();
    cache.pageGeometries.clear();
    cache.pageTextBytes = 0;
    cache.canCacheWholeDocumentText = true;
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const searchDocumentCache = new Map<string, IPreparedSearchDocumentCache>();
    const canceledSearchRequests = new Set<string>();
    const activeSearchRequests = new Set<string>();
    const activeWorkerSearchRequests = new Map<string, number>();

    function getMemoryCacheKey(pdfPath: string, documentRevision: string) {
        return `${pdfPath}\0${documentRevision}`;
    }

    function deleteDocumentMemoryCaches(pdfPath: string) {
        searchDocumentCache.delete(pdfPath);
        const prefix = `${pdfPath}\0`;
        for (const key of Array.from(searchDocumentCache.keys())) {
            if (key.startsWith(prefix)) {
                searchDocumentCache.delete(key);
            }
        }
    }

    function getDocumentCache(cacheKey: string) {
        let cache = searchDocumentCache.get(cacheKey);
        if (!cache) {
            while (searchDocumentCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT) {
                const oldestKey = searchDocumentCache.keys().next().value;
                if (typeof oldestKey !== 'string') {
                    break;
                }
                searchDocumentCache.delete(oldestKey);
            }
            cache = createDocumentCache();
            searchDocumentCache.set(cacheKey, cache);
        }
        return cache;
    }

    async function clearSearchCachesAsync(pdfPath?: string) {
        if (pdfPath) {
            deleteDocumentMemoryCaches(pdfPath);
            await clearPersistedSearchCacheForDocument(pdfPath);
            return;
        }

        searchDocumentCache.clear();
        await clearPersistedSearchCaches();
    }

    const clearSearchCaches = clearSearchCachesAsync;

    async function assertSearchWithinBrowserBudget(pdfPath: string) {
        const { size } = await browserDocumentStore.stat(pdfPath);
        if (size > BROWSER_SEARCH_MAX_BYTES) {
            throw createBrowserSearchTooLargeError();
        }
    }

    function startSearchRequest(requestId: string | undefined) {
        if (requestId) {
            activeSearchRequests.add(requestId);
        }
    }

    function consumeCancellation(requestId: string | undefined) {
        if (requestId && canceledSearchRequests.has(requestId)) {
            return true;
        }
        return false;
    }

    function finishSearchRequest(requestId: string | undefined) {
        if (requestId) {
            canceledSearchRequests.delete(requestId);
            activeSearchRequests.delete(requestId);
            activeWorkerSearchRequests.delete(requestId);
        }
    }

    function isExtractionCanceled(requestId: string | undefined) {
        return Boolean(requestId && canceledSearchRequests.has(requestId));
    }

    function isSearchCanceled(requestId: string | undefined) {
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

    function emitSearchProgress(progress: IPdfSearchProgress) {
        searchProgressListeners.forEach((listener) => listener(progress));
    }

    function pickValidPersistedRecord(
        record: IPersistedSearchDocumentCacheRecord | null,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        expectedPageCount?: number,
    ) {
        if (!record) {
            return null;
        }
        if (record.version !== SEARCH_CACHE_RECORD_VERSION) {
            return null;
        }
        if (record.fileSize !== fileSize) {
            return null;
        }
        if (record.contentSignature !== contentSignature) {
            return null;
        }
        if (record.documentRevision !== documentRevision) {
            return null;
        }
        if (
            typeof expectedPageCount === 'number'
            && expectedPageCount > 0
            && record.pageCount !== expectedPageCount
        ) {
            return null;
        }
        if (record.pageCount !== record.pageTexts.length) {
            return null;
        }
        if (record.pageTexts.some(text => typeof text !== 'string')) {
            return null;
        }
        const textBytes = estimatePageTextBytes(record.pageTexts);
        if (record.textBytes !== textBytes) {
            return null;
        }
        if (getPersistedRecordBytes(record) > SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES) {
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
            return await runDirectExtraction(pdfPath, requestId);
        } finally {
            if (requestId) {
                activeWorkerSearchRequests.delete(requestId);
            }
        }
    }

    async function deliverPage(
        page: ISearchPageData,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ): Promise<TPageOutcome> {
        if (isSearchCanceled(options.requestId)) {
            return 'cancel';
        }
        const result = await options.onPage(page, pageCount);
        if (result === false) {
            return 'stop';
        }
        emitPageProgress(options.requestId, page.pageNumber, pageCount);
        await yieldAfterSearchPage(page.pageNumber);
        return 'continue';
    }

    async function iterateCachedDocumentPages(
        cache: IPreparedSearchDocumentCache,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ) {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            const cachedPage = getCachedPageData(cache, pageNumber, Boolean(options.requireGeometry)) ?? {
                pageNumber,
                text: '',
            };
            const outcome = await deliverPage(cachedPage, pageCount, options);
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
            const outcome = await deliverPage({
                pageNumber,
                text,
            }, record.pageCount, options);
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
            if (isSearchCanceled(options.requestId)) {
                return { canceled: true };
            }

            const text = extracted.pageTexts[pageNumber - 1] ?? '';
            const page = {
                pageNumber,
                text,
            };
            rememberPageData(cache, page);

            if (
                shouldContinueCallbacks
                && await options.onPage(page, extracted.pageCount) === false
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
        contentSignature: string,
        documentRevision: string,
        options: IIterateSearchPagesOptions,
    ) {
        const memoryCacheKey = getMemoryCacheKey(pdfPath, documentRevision);
        let cache = getDocumentCache(memoryCacheKey);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache, Boolean(options.requireGeometry)) && cachedPageCount) {
            if (
                typeof options.expectedPageCount !== 'number'
                || options.expectedPageCount === cachedPageCount
            ) {
                return iterateCachedDocumentPages(cache, cachedPageCount, options);
            }
            searchDocumentCache.delete(memoryCacheKey);
            cache = getDocumentCache(memoryCacheKey);
        }

        const persistedRecord = options.requireGeometry
            ? null
            : await loadPersistedSearchCacheRecord(pdfPath);
        const validPersistedRecord = pickValidPersistedRecord(
            persistedRecord,
            fileSize,
            contentSignature,
            documentRevision,
            options.expectedPageCount,
        );
        if (validPersistedRecord) {
            void touchPersistedSearchCacheRecord(validPersistedRecord);
            hydrateCacheFromPersistedRecord(cache, validPersistedRecord);
            return iteratePersistedDocumentPages(validPersistedRecord, options);
        }
        if (persistedRecord) {
            await clearPersistedSearchCacheForDocument(pdfPath);
        }

        if (options.streamDirectExtraction) {
            let canceled = false;
            let stopped = false;
            let pageCount = 0;
            let pageTexts: string[] = [];
            try {
                pageCount = await iterateBrowserSearchDocumentPages(
                    pdfPath,
                    async (page, totalPages) => {
                        if (isSearchCanceled(options.requestId)) {
                            canceled = true;
                            return;
                        }
                        pageCount = totalPages;
                        pageTexts[page.pageNumber - 1] = page.text;
                        rememberPageData(cache, page);
                        if (stopped) {
                            emitPageProgress(options.requestId, page.pageNumber, totalPages);
                            await yieldAfterSearchPage(page.pageNumber);
                        } else {
                            const outcome = await deliverPage(page, totalPages, options);
                            if (outcome === 'cancel') {
                                canceled = true;
                            } else if (outcome === 'stop') {
                                stopped = true;
                            }
                        }
                    },
                    {shouldContinue: () => (
                        !isExtractionCanceled(options.requestId)
                            && !canceled
                            && (options.continueExtractionAfterStop === true || !stopped)
                    )},
                );
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    pageTexts.length = 0;
                    resetExtractedPageCache(cache);
                    if (stopped && !canceled && !isExtractionCanceled(options.requestId)) {
                        cache.pageCount = pageCount > 0 ? pageCount : cache.pageCount;
                        return true;
                    }
                    return !canceled && stopped;
                }
                throw error;
            }

            cache.pageCount = pageCount;
            pageTexts = Array.from({ length: pageCount }, (_value, index) => pageTexts[index] ?? '');
            if (!canceled && canPersistPageTexts(pageTexts)) {
                await persistSearchCacheRecordBestEffort(createPersistedSearchCacheRecord(
                    pdfPath,
                    fileSize,
                    contentSignature,
                    documentRevision,
                    pageCount,
                    pageTexts,
                ));
            }
            return !canceled;
        }

        const extractedDocumentText = await extractDocumentTextWithFallback(pdfPath, options.requestId);
        if (!extractedDocumentText) {
            return false;
        }

        cache.pageCount = extractedDocumentText.pageCount;
        const { canceled } = await iterateExtractedDocumentPages(cache, extractedDocumentText, options);

        if (!canceled && canPersistPageTexts(extractedDocumentText.pageTexts)) {
            await persistSearchCacheRecordBestEffort(createPersistedSearchCacheRecord(
                pdfPath,
                fileSize,
                contentSignature,
                documentRevision,
                extractedDocumentText.pageCount,
                extractedDocumentText.pageTexts,
            ));
        }

        return !canceled;
    }

    async function resolveSearchDocumentRevision(pdfPath: string, requestedRevision: string | undefined) {
        const currentRevision = await browserDocumentStore.getDocumentRevision(pdfPath);
        return requestedRevision === currentRevision.token
            ? requestedRevision
            : currentRevision.token;
    }

    const capability = {
        async run(pdfPath, query, options = {}) {
            if (query.length === 0) {
                return {
                    results: [],
                    truncated: false,
                };
            }

            const requestId = options.requestId ?? createBrowserSafeId();
            const results: IPdfSearchResult[] = [];
            let emittedResultCount = 0;
            const pageMatchCounts = new Map<number, number>();
            const matchOptions = {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            };

            startSearchRequest(requestId);
            try {
                await assertSearchWithinBrowserBudget(pdfPath);
                const { size } = await browserDocumentStore.stat(pdfPath);
                const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                await iterateSearchPages(pdfPath, size, contentSignature, documentRevision, {
                    requestId,
                    ...(options.pageCount !== undefined ? {expectedPageCount: options.pageCount} : {}),
                    streamDirectExtraction: true,
                    requireGeometry: true,
                    onPage: async (page, pageCount) => {
                        if (isSearchCanceled(requestId)) {
                            return false;
                        }

                        for (const match of iteratePdfSearchMatches(page.text, query, matchOptions)) {
                            const pageMatchIndex = pageMatchCounts.get(page.pageNumber) ?? 0;
                            pageMatchCounts.set(page.pageNumber, pageMatchIndex + 1);
                            const words = collectSearchMatchWords(page, match.startOffset, match.endOffset);
                            results.push({
                                pageNumber: requirePageNumber(page.pageNumber),
                                pageMatchIndex,
                                matchIndex: results.length,
                                startOffset: match.startOffset,
                                endOffset: match.endOffset,
                                excerpt: buildPdfSearchExcerpt(
                                    page.text,
                                    match.startOffset,
                                    match.endOffset,
                                    SEARCH_EXCERPT_CONTEXT_CHARS,
                                ),
                                ...(words !== undefined ? {words} : {}),
                                ...(words !== undefined && page.pageWidth !== undefined ? {pageWidth: page.pageWidth} : {}),
                                ...(words !== undefined && page.pageHeight !== undefined ? {pageHeight: page.pageHeight} : {}),
                            });
                            if (results.length >= SEARCH_RESULT_LIMIT) {
                                const delta = results.slice(emittedResultCount);
                                emitSearchProgress({
                                    requestId,
                                    processed: page.pageNumber,
                                    total: pageCount,
                                    results: delta,
                                    resultsStartIndex: emittedResultCount,
                                    truncated: true,
                                });
                                emittedResultCount = results.length;
                                return false;
                            }
                        }

                        const delta = results.slice(emittedResultCount);
                        emitSearchProgress({
                            requestId,
                            processed: page.pageNumber,
                            total: pageCount,
                            results: delta,
                            resultsStartIndex: emittedResultCount,
                            truncated: false,
                        });
                        emittedResultCount = results.length;
                        await yieldToBrowser();
                        return true;
                    },
                });

                if (consumeCancellation(requestId)) {
                    return {
                        results: [],
                        truncated: false,
                    };
                }

                return {
                    results,
                    truncated: results.length >= SEARCH_RESULT_LIMIT,
                } satisfies IPdfSearchResponse;
            } finally {
                finishSearchRequest(requestId);
            }
        },
        async warmIndex(pdfPath, options = {}) {
            const requestId = options.requestId;
            startSearchRequest(requestId);
            try {
                await assertSearchWithinBrowserBudget(pdfPath);
                const { size } = await browserDocumentStore.stat(pdfPath);
                const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const completed = await iterateSearchPages(pdfPath, size, contentSignature, documentRevision, {
                    ...(requestId !== undefined ? {requestId} : {}),
                    ...(options.pageCount !== undefined ? {expectedPageCount: options.pageCount} : {}),
                    onPage: async () => {
                        await yieldToBrowser();
                    },
                });
                return completed && !consumeCancellation(requestId);
            } finally {
                finishSearchRequest(requestId);
            }
        },
        cancel(requestId) {
            if (requestId) {
                const workerRequestId = activeWorkerSearchRequests.get(requestId);
                if (typeof workerRequestId === 'number') {
                    void cancelBrowserSearchWorkerRequest(workerRequestId);
                }
                if (activeSearchRequests.has(requestId)) {
                    canceledSearchRequests.add(requestId);
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
        async resetCache() {
            await clearSearchCachesAsync();
            return true;
        },
    } satisfies TFeatureBrowserBindings<typeof SEARCH_PLATFORM_FEATURE>;

    return {
        capability,
        clearSearchCaches,
    };
}
