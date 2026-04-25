const OCR_LANGUAGE_DB_NAME = 'evb-browser-ocr-language-cache';
const OCR_LANGUAGE_DB_VERSION = 1;
const OCR_LANGUAGE_STORE = 'language-packs';
const TESSERACT_CACHE_DB_NAME = 'keyval-store';
const TESSERACT_CACHE_STORE = 'keyval';
const TESSERACT_CACHE_PREFIX = 'evb-browser-ocr';
const OPFS_OCR_LANGUAGE_DIR = 'ocr-language-packs';

interface IBrowserOcrLanguageRecord {
    code: string;
    installedAt: number;
    sizeBytes: number | null;
    sourceUrl: string | null;
}

type TBrowserOcrCacheBackend = 'opfs+indexeddb' | 'indexeddb' | 'unavailable';

interface IBrowserOcrLanguageCacheEntry {
    code: string;
    installedAt: number | null;
    sizeBytes: number | null;
    sourceUrl: string | null;
    hasOpfsCopy: boolean;
    hasIndexedDbCopy: boolean;
}

function isIndexedDbAvailable() {
    return typeof indexedDB !== 'undefined';
}

function openDatabase(
    dbName: string,
    version: number,
    upgrade: (db: IDBDatabase, transaction: IDBTransaction | null) => void,
): Promise<IDBDatabase | null> {
    if (!isIndexedDbAvailable()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
            upgrade(request.result, request.transaction);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`Failed to open ${dbName} database`));
    });
}

function readAllStoreValues<T>(store: IDBObjectStore): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result as T[] | undefined) ?? []);
        request.onerror = () => reject(request.error ?? new Error('Failed to read OCR language records'));
    });
}

function readAllStoreKeys(store: IDBObjectStore): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve((request.result as IDBValidKey[] | undefined) ?? []);
        request.onerror = () => reject(request.error ?? new Error('Failed to read OCR language store keys'));
    });
}

function readStoreValue<T>(
    store: IDBObjectStore,
    key: IDBValidKey,
): Promise<T | null> {
    return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error('Failed to read OCR language record'));
    });
}

function writeStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
    value: unknown,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to write OCR language record'));
    });
}

function deleteStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to delete OCR language record'));
    });
}

function clearStore(store: IDBObjectStore): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to clear OCR language store'));
    });
}

function makeTesseractCacheKey(code: string) {
    return `${TESSERACT_CACHE_PREFIX}/${code}.traineddata`;
}

function getOpfsRoot() {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
        return null;
    }

    return navigator.storage.getDirectory.bind(navigator.storage);
}

async function getOpfsLanguageDirectory(create = false) {
    const getDirectory = getOpfsRoot();
    if (!getDirectory) {
        return null;
    }

    try {
        const root = await getDirectory();
        return await root.getDirectoryHandle(OPFS_OCR_LANGUAGE_DIR, { create });
    } catch {
        return null;
    }
}

async function writeOpfsLanguageData(code: string, data: Uint8Array) {
    const directory = await getOpfsLanguageDirectory(true);
    if (!directory) {
        return false;
    }

    const fileHandle = await directory.getFileHandle(`${code}.traineddata`, { create: true });
    const writable = await fileHandle.createWritable();
    const bytes = Uint8Array.from(data);
    await writable.write(bytes);
    await writable.close();
    return true;
}

async function readOpfsLanguageData(code: string): Promise<Uint8Array | null> {
    const directory = await getOpfsLanguageDirectory(false);
    if (!directory) {
        return null;
    }

    try {
        const fileHandle = await directory.getFileHandle(`${code}.traineddata`, { create: false });
        const file = await fileHandle.getFile();
        return new Uint8Array(await file.arrayBuffer());
    } catch {
        return null;
    }
}

async function deleteOpfsLanguageData(code: string): Promise<boolean> {
    const directory = await getOpfsLanguageDirectory(false);
    if (!directory) {
        return false;
    }

    try {
        await directory.removeEntry(`${code}.traineddata`);
        return true;
    } catch {
        return false;
    }
}

async function clearOpfsLanguageDirectory(): Promise<boolean> {
    const getDirectory = getOpfsRoot();
    if (!getDirectory) {
        return false;
    }

    try {
        const root = await getDirectory();
        await root.removeEntry(OPFS_OCR_LANGUAGE_DIR, { recursive: true });
        return true;
    } catch {
        return false;
    }
}

async function openBrowserOcrLanguageDb() {
    return openDatabase(OCR_LANGUAGE_DB_NAME, OCR_LANGUAGE_DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains(OCR_LANGUAGE_STORE)) {
            db.createObjectStore(OCR_LANGUAGE_STORE, { keyPath: 'code' });
        }
    });
}

async function openTesseractCacheDb() {
    return openDatabase(TESSERACT_CACHE_DB_NAME, 1, (db) => {
        if (!db.objectStoreNames.contains(TESSERACT_CACHE_STORE)) {
            db.createObjectStore(TESSERACT_CACHE_STORE);
        }
    });
}

async function hasIndexedDbLanguageData(code: string): Promise<boolean> {
    const db = await openTesseractCacheDb();
    if (!db) {
        return false;
    }

    try {
        const transaction = db.transaction(TESSERACT_CACHE_STORE, 'readonly');
        const store = transaction.objectStore(TESSERACT_CACHE_STORE);
        const value = await readStoreValue<unknown>(store, makeTesseractCacheKey(code));
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    } finally {
        db.close();
    }
}

async function readBrowserOcrLanguageRecords(): Promise<IBrowserOcrLanguageRecord[]> {
    const db = await openBrowserOcrLanguageDb();
    if (!db) {
        return [];
    }

    try {
        const transaction = db.transaction(OCR_LANGUAGE_STORE, 'readonly');
        const store = transaction.objectStore(OCR_LANGUAGE_STORE);
        return await readAllStoreValues<IBrowserOcrLanguageRecord>(store);
    } finally {
        db.close();
    }
}

export function getBrowserOcrCacheBackend(): TBrowserOcrCacheBackend {
    if (!isIndexedDbAvailable()) {
        return 'unavailable';
    }

    return getOpfsRoot() ? 'opfs+indexeddb' : 'indexeddb';
}

export async function listBrowserOcrLanguageCacheEntries(): Promise<IBrowserOcrLanguageCacheEntry[]> {
    const records = await readBrowserOcrLanguageRecords();

    const entries = await Promise.all(records.map(async (record) => ({
        code: record.code,
        installedAt: record.installedAt ?? null,
        sizeBytes: record.sizeBytes ?? null,
        sourceUrl: record.sourceUrl ?? null,
        hasOpfsCopy: (await readOpfsLanguageData(record.code))?.byteLength
            ? true
            : false,
        hasIndexedDbCopy: await hasIndexedDbLanguageData(record.code),
    } satisfies IBrowserOcrLanguageCacheEntry)));

    return entries.sort((a, b) => a.code.localeCompare(b.code));
}

export async function clearBrowserOcrLanguageCache(codes?: string[]): Promise<void> {
    const normalizedCodes = (codes ?? [])
        .map(code => code.trim())
        .filter(code => code.length > 0);

    if (normalizedCodes.length === 0) {
        await clearOpfsLanguageDirectory().catch(() => false);

        const tesseractDb = await openTesseractCacheDb();
        if (tesseractDb) {
            try {
                const transaction = tesseractDb.transaction(TESSERACT_CACHE_STORE, 'readwrite');
                const store = transaction.objectStore(TESSERACT_CACHE_STORE);
                const keys = await readAllStoreKeys(store);
                const ocrKeys = keys.filter((key): key is string =>
                    typeof key === 'string' && key.startsWith(`${TESSERACT_CACHE_PREFIX}/`),
                );

                if (ocrKeys.length === keys.length) {
                    await clearStore(store);
                } else {
                    for (const key of ocrKeys) {
                        await deleteStoreValue(store, key);
                    }
                }
            } finally {
                tesseractDb.close();
            }
        }

        const languageDb = await openBrowserOcrLanguageDb();
        if (!languageDb) {
            return;
        }

        try {
            const transaction = languageDb.transaction(OCR_LANGUAGE_STORE, 'readwrite');
            const store = transaction.objectStore(OCR_LANGUAGE_STORE);
            await clearStore(store);
        } finally {
            languageDb.close();
        }

        return;
    }

    await Promise.all(normalizedCodes.map(code => deleteOpfsLanguageData(code).catch(() => false)));

    const tesseractDb = await openTesseractCacheDb();
    if (tesseractDb) {
        try {
            const transaction = tesseractDb.transaction(TESSERACT_CACHE_STORE, 'readwrite');
            const store = transaction.objectStore(TESSERACT_CACHE_STORE);
            for (const code of normalizedCodes) {
                await deleteStoreValue(store, makeTesseractCacheKey(code));
            }
        } finally {
            tesseractDb.close();
        }
    }

    const languageDb = await openBrowserOcrLanguageDb();
    if (!languageDb) {
        return;
    }

    try {
        const transaction = languageDb.transaction(OCR_LANGUAGE_STORE, 'readwrite');
        const store = transaction.objectStore(OCR_LANGUAGE_STORE);
        for (const code of normalizedCodes) {
            await deleteStoreValue(store, code);
        }
    } finally {
        languageDb.close();
    }
}

export async function listInstalledBrowserOcrLanguages(): Promise<Set<string>> {
    const records = await readBrowserOcrLanguageRecords();
    return new Set(records
        .map(record => record.code)
        .filter((code): code is string => typeof code === 'string' && code.length > 0));
}

export async function hasCachedBrowserOcrLanguage(code: string): Promise<boolean> {
    const normalizedCode = code.trim();
    if (!normalizedCode) {
        return false;
    }

    const opfsBytes = await readOpfsLanguageData(normalizedCode);
    if (opfsBytes && opfsBytes.byteLength > 0) {
        return true;
    }

    return hasIndexedDbLanguageData(normalizedCode);
}

export async function markBrowserOcrLanguageInstalled(
    code: string,
    options?: {
        sizeBytes?: number | null;
        sourceUrl?: string | null;
    },
): Promise<void> {
    const normalizedCode = code.trim();
    if (!normalizedCode) {
        return;
    }

    const db = await openBrowserOcrLanguageDb();
    if (!db) {
        return;
    }

    try {
        const transaction = db.transaction(OCR_LANGUAGE_STORE, 'readwrite');
        const store = transaction.objectStore(OCR_LANGUAGE_STORE);
        await new Promise<void>((resolve, reject) => {
            const request = store.put({
                code: normalizedCode,
                installedAt: Date.now(),
                sizeBytes: options?.sizeBytes ?? null,
                sourceUrl: options?.sourceUrl ?? null,
            });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('Failed to write OCR language record'));
        });
    } finally {
        db.close();
    }
}

export async function cacheBrowserOcrLanguageData(
    code: string,
    data: Uint8Array,
): Promise<void> {
    const normalizedCode = code.trim();
    if (!normalizedCode || data.byteLength === 0) {
        return;
    }

    await writeOpfsLanguageData(normalizedCode, data).catch(() => false);

    const db = await openTesseractCacheDb();
    if (!db) {
        return;
    }

    try {
        const transaction = db.transaction(TESSERACT_CACHE_STORE, 'readwrite');
        const store = transaction.objectStore(TESSERACT_CACHE_STORE);
        await writeStoreValue(store, makeTesseractCacheKey(normalizedCode), data);
    } finally {
        db.close();
    }
}

export async function hydrateBrowserOcrLanguageCache(code: string): Promise<boolean> {
    const normalizedCode = code.trim();
    if (!normalizedCode) {
        return false;
    }

    const opfsBytes = await readOpfsLanguageData(normalizedCode);
    if (!opfsBytes || opfsBytes.byteLength === 0) {
        return false;
    }

    const db = await openTesseractCacheDb();
    if (!db) {
        return false;
    }

    try {
        const transaction = db.transaction(TESSERACT_CACHE_STORE, 'readwrite');
        const store = transaction.objectStore(TESSERACT_CACHE_STORE);
        await writeStoreValue(store, makeTesseractCacheKey(normalizedCode), opfsBytes);
        return true;
    } finally {
        db.close();
    }
}
