import { orderBy } from 'es-toolkit/array';
import { sumBy } from 'es-toolkit/math';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import {
    buildPdfSearchExcerpt,
    buildPdfSearchRegex,
    iteratePdfSearchMatches,
} from '@contracts/search';
import type { IBrowserOcrSearchDocumentText } from '@app/platform/browser-api/browserOcrSearchText';
import { readBrowserOcrSearchDocumentText } from '@app/platform/browser-api/browserOcrSearchText';
import type { ISearchCapability } from '@contracts/platformApi';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@app/platform/browser-api/browserSearchLimits';
import {
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
    canUseBrowserSearchWorker,
} from '@app/platform/browser-api/browserSearchWorkerClient';
import {
    extractBrowserSearchDocumentText,
    iterateBrowserSearchDocumentText,
} from '@app/platform/browser-api/browserSearchCore';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    clearStore,
    deleteStoreValue,
    isIndexedDbAvailable,
    readAllStoreValues,
    readStoreValue,
    writeStoreValue,
} from '@app/platform/browser-api/browserIndexeddb';

interface IPreparedSearchDocumentCache {
    pageCount: number | null;
    pageTexts: Map<number, string>;
    pageTextBytes: number;
    canCacheWholeDocumentText: boolean;
}

interface IPersistedSearchDocumentCacheRecord {
    version?: number;
    pdfPath: string;
    fileSize: number;
    contentSignature?: string;
    pageCount: number;
    pageTexts: string[];
    textBytes?: number;
    lastAccessedAt?: number;
    createdAt?: number;
    textSource?: ISearchDocumentTextSource;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: (pdfPath?: string) => void;
}

interface IIterateSearchPagesOptions {
    onPage: (pageNumber: number, text: string, pageCount: number) => Promise<unknown> | unknown;
    requestId?: string;
    expectedPageCount?: number;
    streamDirectExtraction?: boolean;
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
const SEARCH_CACHE_DB_VERSION = 1;
const SEARCH_CACHE_RECORD_VERSION = 6;
const SEARCH_CACHE_STORE = 'document-text';
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

function estimatePageTextBytes(pageTexts: string[]) {
    return pageTexts.reduce((total, text) => total + (text.length * 2), 0);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        || !pageTexts.every((item): item is string => typeof item === 'string')
    ) {
        return null;
    }

    const textSource = parseSearchDocumentTextSource(value.textSource);
    const textBytes = finiteNumberOrUndefined(value.textBytes);
    const lastAccessedAt = finiteNumberOrUndefined(value.lastAccessedAt);
    const createdAt = finiteNumberOrUndefined(value.createdAt);
    return {
        ...(typeof value.version === 'number' ? { version: value.version } : {}),
        pdfPath: value.pdfPath,
        fileSize: value.fileSize,
        ...(typeof value.contentSignature === 'string' ? { contentSignature: value.contentSignature } : {}),
        pageCount: value.pageCount,
        pageTexts,
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
    const record = await runSearchCacheTransaction(
        'readonly',
        (store) => readStoreValue<unknown>(
            store,
            cacheKey,
            'Failed to read search cache record',
        ),
    );
    return parsePersistedSearchCacheRecord(record);
}

async function loadAllPersistedSearchCacheRecords() {
    const records = await runSearchCacheTransaction(
        'readonly',
        (store) => readAllStoreValues<unknown>(
            store,
            'Failed to list search cache records',
        ),
    ) ?? [];
    return records
        .map(record => parsePersistedSearchCacheRecord(record))
        .filter((record): record is IPersistedSearchDocumentCacheRecord => record !== null);
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

async function clearPersistedSearchCaches() {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => clearStore(store, 'Failed to clear search cache records'),
    );
}

async function prunePersistedSearchCaches() {
    const records = await loadAllPersistedSearchCacheRecords();
    if (records.length <= SEARCH_PERSISTED_CACHE_MAX_RECORDS) {
        const totalBytes = sumBy(records, getPersistedRecordBytes);
        if (totalBytes <= SEARCH_PERSISTED_CACHE_MAX_BYTES) {
            return;
        }
    }

    const newestFirst = orderBy(records, [record => record.lastAccessedAt ?? 0], ['desc']);
    let keptRecords = 0;
    let keptBytes = 0;
    const deleteKeys: string[] = [];

    for (const record of newestFirst) {
        const nextBytes = keptBytes + getPersistedRecordBytes(record);
        if (
            keptRecords >= SEARCH_PERSISTED_CACHE_MAX_RECORDS
            || nextBytes > SEARCH_PERSISTED_CACHE_MAX_BYTES
        ) {
            deleteKeys.push(record.pdfPath);
            continue;
        }
        keptRecords += 1;
        keptBytes = nextBytes;
    }

    await Promise.all(deleteKeys.map((key) => deletePersistedSearchCacheRecord(key)));
}

async function clearPersistedSearchCacheForDocument(pdfPath: string) {
    await deletePersistedSearchCacheRecord(pdfPath);
}

function createPersistedSearchCacheRecord(
    pdfPath: string,
    fileSize: number,
    contentSignature: string,
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

    function getMemoryCacheKey(pdfPath: string, contentSignature: string) {
        return `${pdfPath}\0${contentSignature}`;
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

    function clearSearchCaches(pdfPath?: string) {
        void clearSearchCachesAsync(pdfPath);
    }

    async function assertSearchWithinBrowserBudget(pdfPath: string) {
        const { size } = await browserDocumentStore.stat(pdfPath);
        if (size > BROWSER_SEARCH_MAX_BYTES) {
            throw createBrowserSearchTooLargeError();
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
            return await runDirectExtraction(pdfPath, requestId);
        } finally {
            if (requestId) {
                activeWorkerSearchRequests.delete(requestId);
            }
        }
    }

    async function extractDocumentTextFromOcrArtifacts(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        requestId: string | undefined,
        expectedPageCount?: number,
    ): Promise<IBrowserOcrSearchDocumentText | null> {
        try {
            return await readBrowserOcrSearchDocumentText(pdfPath, {
                fileSize,
                contentSignature,
                ...(expectedPageCount !== undefined ? { expectedPageCount } : {}),
                shouldContinue: () => !isExtractionCanceled(requestId),
            });
        } catch (error) {
            if (isBrowserSearchCanceledError(error)) {
                return null;
            }
            return null;
        }
    }

    async function deliverPage(
        pageNumber: number,
        text: string,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ): Promise<TPageOutcome> {
        if (isSearchCanceled(options.requestId)) {
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
            if (isSearchCanceled(options.requestId)) {
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
        contentSignature: string,
        options: IIterateSearchPagesOptions,
    ) {
        const memoryCacheKey = getMemoryCacheKey(pdfPath, contentSignature);
        let cache = getDocumentCache(memoryCacheKey);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache) && cachedPageCount) {
            if (
                typeof options.expectedPageCount !== 'number'
                || options.expectedPageCount === cachedPageCount
            ) {
                return iterateCachedDocumentPages(cache, cachedPageCount, options);
            }
            searchDocumentCache.delete(memoryCacheKey);
            cache = getDocumentCache(memoryCacheKey);
        }

        const persistedRecord = await loadPersistedSearchCacheRecord(pdfPath);
        const validPersistedRecord = pickValidPersistedRecord(
            persistedRecord,
            fileSize,
            contentSignature,
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

        const ocrDocumentText = await extractDocumentTextFromOcrArtifacts(
            pdfPath,
            fileSize,
            contentSignature,
            options.requestId,
            options.expectedPageCount,
        );
        if (isSearchCanceled(options.requestId)) {
            return false;
        }
        if (ocrDocumentText) {
            cache.pageCount = ocrDocumentText.pageCount;
            const { canceled } = await iterateExtractedDocumentPages(cache, ocrDocumentText, options);

            if (!canceled && canPersistPageTexts(ocrDocumentText.pageTexts)) {
                await persistSearchCacheRecord(createPersistedSearchCacheRecord(
                    pdfPath,
                    fileSize,
                    contentSignature,
                    ocrDocumentText.pageCount,
                    ocrDocumentText.pageTexts,
                    ocrDocumentText.textSource,
                ));
            }

            return !canceled;
        }

        if (options.streamDirectExtraction) {
            let canceled = false;
            let stopped = false;
            let pageCount = 0;
            let pageTexts: string[] = [];
            try {
                pageCount = await iterateBrowserSearchDocumentText(
                    pdfPath,
                    async (pageNumber, text, totalPages) => {
                        if (isSearchCanceled(options.requestId)) {
                            canceled = true;
                            return;
                        }
                        pageCount = totalPages;
                        pageTexts[pageNumber - 1] = text;
                        rememberPageText(cache, pageNumber, text);
                        if (stopped) {
                            emitPageProgress(options.requestId, pageNumber, totalPages);
                            await yieldAfterSearchPage(pageNumber);
                        } else {
                            const outcome = await deliverPage(pageNumber, text, totalPages, options);
                            if (outcome === 'cancel') {
                                canceled = true;
                            } else if (outcome === 'stop') {
                                stopped = true;
                            }
                        }
                    },
                    { shouldContinue: () => !isExtractionCanceled(options.requestId) && !canceled },
                );
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    return !canceled && stopped;
                }
                throw error;
            }

            cache.pageCount = pageCount;
            pageTexts = Array.from({ length: pageCount }, (_value, index) => pageTexts[index] ?? '');
            if (!canceled && canPersistPageTexts(pageTexts)) {
                await persistSearchCacheRecord(createPersistedSearchCacheRecord(
                    pdfPath,
                    fileSize,
                    contentSignature,
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
            await persistSearchCacheRecord(createPersistedSearchCacheRecord(
                pdfPath,
                fileSize,
                contentSignature,
                extractedDocumentText.pageCount,
                extractedDocumentText.pageTexts,
            ));
        }

        return !canceled;
    }

    const capability: ISearchCapability = {
        async run(pdfPath, query, options = {}) {
            if (!query || query.trim().length === 0) {
                return {
                    results: [],
                    truncated: false,
                };
            }

            await assertSearchWithinBrowserBudget(pdfPath);
            const { size } = await browserDocumentStore.stat(pdfPath);
            const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
            const requestId = options.requestId ?? crypto.randomUUID();
            const results: IPdfSearchResult[] = [];
            const pageMatchCounts = new Map<number, number>();
            const matcher = buildPdfSearchRegex(query, {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            });

            try {
                await iterateSearchPages(pdfPath, size, contentSignature, {
                    requestId,
                    ...(options.pageCount !== undefined ? {expectedPageCount: options.pageCount} : {}),
                    streamDirectExtraction: true,
                    onPage: async (pageNumber, text, pageCount) => {
                        if (isSearchCanceled(requestId)) {
                            return false;
                        }

                        for (const match of iteratePdfSearchMatches(text, matcher)) {
                            const pageMatchIndex = pageMatchCounts.get(pageNumber) ?? 0;
                            pageMatchCounts.set(pageNumber, pageMatchIndex + 1);
                            results.push({
                                pageNumber,
                                pageMatchIndex,
                                matchIndex: results.length,
                                startOffset: match.startOffset,
                                endOffset: match.endOffset,
                                excerpt: buildPdfSearchExcerpt(text, match.startOffset, match.endOffset, SEARCH_EXCERPT_CONTEXT_CHARS),
                            });
                            if (results.length >= SEARCH_RESULT_LIMIT) {
                                emitSearchProgress({
                                    requestId,
                                    processed: pageNumber,
                                    total: pageCount,
                                    results: [...results],
                                    truncated: true,
                                });
                                return false;
                            }
                        }

                        emitSearchProgress({
                            requestId,
                            processed: pageNumber,
                            total: pageCount,
                            results: [...results],
                            truncated: false,
                        });
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
            await assertSearchWithinBrowserBudget(pdfPath);
            const { size } = await browserDocumentStore.stat(pdfPath);
            const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
            const requestId = options.requestId;
            try {
                const completed = await iterateSearchPages(pdfPath, size, contentSignature, {
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
        async resetCache() {
            await clearSearchCachesAsync();
            return true;
        },
    };

    return {
        capability,
        clearSearchCaches,
    };
}
