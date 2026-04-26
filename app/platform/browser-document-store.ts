import type { IRecentFile } from '@contracts/shared';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/local-storage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browser-runtime-persistence';
import { decodeDocumentRefSegment } from '@app/utils/document-ref';
import {
    parseRecentFilesPayload,
    RECENT_FILES_COOKIE_KEY,
    RECENT_FILES_COOKIE_MAX_AGE_SECONDS,
    serializeRecentFilesCookiePayload,
    serializeRecentFilesPayload,
} from '@app/utils/recent-files-persistence';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';

const BROWSER_REF_PREFIX = 'browser://documents/';
const DB_NAME = 'evb-viewer-browser-documents';
const DB_VERSION = 2;
const DOCUMENTS_STORE = 'documents';
const DOCUMENT_CHUNKS_STORE = 'document-chunks';
export const BROWSER_DOCUMENT_CHUNK_SIZE = 4 * 1024 * 1024;
const BROWSER_INLINE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const BROWSER_MAX_FULL_READ_BYTES = 64 * 1024 * 1024;
const BROWSER_MAX_RECENT_FILES = 30;
export const BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES = 512 * 1024 * 1024;
const BROWSER_CHUNK_WRITE_YIELD_EVERY = 2;

type TBrowserDocumentStorageMode =
    | 'inline'
    | 'handle'
    | 'chunked'
    | 'source-proxy';

interface IBrowserPersistedDocumentRecord {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: 'source' | 'working' | 'output';
    retention?: 'durable' | 'transient';
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    updatedAt: number;
    saveName?: string;
    saveKind?: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
}

interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    pendingLoad: Promise<void> | null;
    retention: 'durable' | 'transient';
    saveName?: string;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount: number;
    chunkSize: number;
}

interface IRegisterFileOptions {
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    saveKind?: IBrowserDocumentEntry['saveKind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

interface ICreateStoredDocumentOptions {
    mimeType: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
}

interface IWriteDocumentOptions { unloadAfterPersist?: boolean; }

interface IBrowserDocumentChunkRecord {
    key: string;
    ref: string;
    index: number;
    data: Uint8Array;
}

interface IChunkKeyRecord {
    ref: string;
    index: number;
}

type TIndexedDbFactory = typeof indexedDB;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getIndexedDbFactory(): TIndexedDbFactory | null {
    if (typeof indexedDB === 'undefined') {
        return null;
    }

    return indexedDB;
}

function getDocumentFileName(ref: string) {
    const trimmed = ref.startsWith(BROWSER_REF_PREFIX)
        ? ref.slice(BROWSER_REF_PREFIX.length)
        : ref;

    return decodeDocumentRefSegment(trimmed.split('/').at(-1) ?? 'document');
}

function createBrowserDocumentRef(fileName: string) {
    return `${BROWSER_REF_PREFIX}${crypto.randomUUID()}/${encodeURIComponent(fileName)}`;
}

function defaultRetentionForKind(kind: IBrowserDocumentEntry['kind']) {
    return kind === 'working' ? 'transient' : 'durable';
}

function toUint8Array(data: Uint8Array | ArrayBuffer) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function normalizePersistedBytes(data: unknown) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    return null;
}

function normalizeStorageMode(value: unknown): TBrowserDocumentStorageMode {
    if (
        value === 'handle'
        || value === 'chunked'
        || value === 'source-proxy'
    ) {
        return value;
    }

    return 'inline';
}

function toPersistedDocumentRecord(
    value: unknown,
): IBrowserPersistedDocumentRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const ref = typeof value.ref === 'string' ? value.ref : null;
    const fileName = typeof value.fileName === 'string' ? value.fileName : null;
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : null;
    const kind = value.kind;
    const retention = value.retention;
    const data = normalizePersistedBytes(value.data);
    const fileSize = typeof value.fileSize === 'number' ? value.fileSize : null;
    const updatedAt =
        typeof value.updatedAt === 'number' ? value.updatedAt : null;
    const sourceRef =
        typeof value.sourceRef === 'string' ? value.sourceRef : undefined;
    const saveName =
        typeof value.saveName === 'string' ? value.saveName : undefined;
    const saveKind = value.saveKind;
    const saveHandle = 'saveHandle' in value
        ? (value.saveHandle as FileSystemFileHandle | null | undefined)
        : undefined;
    const storageMode = normalizeStorageMode(value.storageMode);
    const chunkCount =
        typeof value.chunkCount === 'number' && value.chunkCount >= 0
            ? Math.floor(value.chunkCount)
            : undefined;
    const chunkSize =
        typeof value.chunkSize === 'number' && value.chunkSize > 0
            ? Math.floor(value.chunkSize)
            : undefined;

    if (
        !ref ||
    !fileName ||
    !mimeType ||
    (kind !== 'source' && kind !== 'working' && kind !== 'output') ||
    !data ||
    fileSize === null ||
        updatedAt === null
    ) {
        return null;
    }

    return {
        ref,
        fileName,
        mimeType,
        kind,
        retention: retention === 'transient' ? 'transient' : 'durable',
        sourceRef,
        data,
        fileSize,
        updatedAt,
        saveName,
        saveKind: saveKind === 'pdf' || saveKind === 'docx' || saveKind === 'generic'
            ? saveKind
            : undefined,
        saveHandle: saveHandle ?? undefined,
        storageMode,
        chunkCount,
        chunkSize,
    };
}

function cloneBytes(data: Uint8Array) {
    return data.slice();
}

function buildBrowserDocumentFullReadError(fileName: string, fileSize: number) {
    return new Error(
        `Browser document is too large to load fully into memory (${fileName}: `
        + `${Math.floor(fileSize / (1024 * 1024))}MB > `
        + `${Math.floor(BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024))}MB limit)`,
    );
}

function normalizePersistedWriteBytes(
    data: Uint8Array | ArrayBuffer,
    cloneData = true,
) {
    const bytes = toUint8Array(data);
    return cloneData ? cloneBytes(bytes) : bytes;
}

async function openDatabase() {
    const indexedDbFactory = getIndexedDbFactory();
    if (!indexedDbFactory) {
        return null;
    }

    return new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDbFactory.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
                database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'ref' });
            }
            if (!database.objectStoreNames.contains(DOCUMENT_CHUNKS_STORE)) {
                database.createObjectStore(DOCUMENT_CHUNKS_STORE, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

async function withObjectStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
) {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    return new Promise<T | null>((resolve) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = run(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
    });
}

async function persistRecord(record: IBrowserPersistedDocumentRecord) {
    await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put(record));
}

async function loadRecord(ref: string) {
    return withObjectStore<unknown>(
        DOCUMENTS_STORE,
        'readonly',
        (store) => store.get(ref) as IDBRequest<unknown>,
    );
}

async function loadAllRecords() {
    return withObjectStore<unknown[]>(
        DOCUMENTS_STORE,
        'readonly',
        (store) => store.getAll() as IDBRequest<unknown[]>,
    );
}

async function deleteRecord(ref: string) {
    await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.delete(ref));
}

function createChunkKey(ref: string, index: number) {
    return `${ref}::${index}`;
}

function toPersistedChunkRecord(value: unknown): IBrowserDocumentChunkRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const key = typeof value.key === 'string' ? value.key : null;
    const ref = typeof value.ref === 'string' ? value.ref : null;
    const index =
        typeof value.index === 'number' && value.index >= 0
            ? Math.floor(value.index)
            : null;
    const data = normalizePersistedBytes(value.data);

    if (!key || !ref || index === null || !data) {
        return null;
    }

    return {
        key,
        ref,
        index,
        data,
    };
}

async function persistChunkRecord(record: IBrowserDocumentChunkRecord) {
    await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.put(record),
    );
}

async function loadChunkRecord(ref: string, index: number) {
    return withObjectStore<unknown>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.get(createChunkKey(ref, index)) as IDBRequest<unknown>,
    );
}

async function deleteChunkRecord(ref: string, index: number) {
    await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.delete(createChunkKey(ref, index)),
    );
}

async function loadAllChunkKeys() {
    return withObjectStore<IDBValidKey[]>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.getAllKeys(),
    );
}

async function readFileHandleBytes(
    handle: FileSystemFileHandle,
    offset?: number,
    length?: number,
) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    if (typeof offset === 'number' && typeof length === 'number') {
        const start = Math.max(0, offset);
        const end = Math.max(start, start + Math.max(0, length));
        return {
            size: file.size,
            bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()),
        };
    }

    return {
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
    };
}

async function readFileHandleSize(handle: FileSystemFileHandle) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    return file.size;
}

async function ensureFileHandleReadPermission(handle: FileSystemFileHandle) {
    type TFileSystemHandlePermissionDescriptor = { mode: 'read' };
    const permissionHandle = handle as FileSystemFileHandle & {
        queryPermission?: (descriptor?: TFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
        requestPermission?: (descriptor?: TFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
    };
    const descriptor: TFileSystemHandlePermissionDescriptor = { mode: 'read' };

    if (typeof permissionHandle.queryPermission === 'function') {
        const currentPermission = await permissionHandle.queryPermission(descriptor);
        if (currentPermission === 'granted') {
            return;
        }
    }

    if (typeof permissionHandle.requestPermission === 'function') {
        const requestedPermission = await permissionHandle.requestPermission(descriptor);
        if (requestedPermission === 'granted') {
            return;
        }
    }
}

function readRecentFilesFromStorage() {
    const raw = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    return parseRecentFilesPayload(raw);
}

function writeRecentFilesToCookie(recentFiles: IRecentFile[]) {
    if (typeof document === 'undefined') {
        return;
    }

    if (recentFiles.length === 0) {
        document.cookie = `${RECENT_FILES_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
        return;
    }

    const encodedValue = encodeURIComponent(serializeRecentFilesCookiePayload(recentFiles));
    document.cookie = `${RECENT_FILES_COOKIE_KEY}=${encodedValue}; Path=/; Max-Age=${RECENT_FILES_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function writeRecentFilesToStorage(recentFiles: IRecentFile[]) {
    const payload = serializeRecentFilesPayload(recentFiles);
    safeSetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY, payload);
    writeRecentFilesToCookie(recentFiles);
}

function normalizeRecentFileSize(fileSize: number | undefined) {
    if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
        return 0;
    }

    return Math.floor(fileSize);
}

function pruneRecentFiles(recentFiles: IRecentFile[]) {
    const keptRecentFiles: IRecentFile[] = [];
    const evictedRefs = new Set<string>();
    let totalBytes = 0;

    for (const recentFile of recentFiles) {
        const fileSize = normalizeRecentFileSize(recentFile.fileSize);
        const exceedsCountLimit = keptRecentFiles.length >= BROWSER_MAX_RECENT_FILES;
        const exceedsByteLimit = keptRecentFiles.length > 0
            && (totalBytes + fileSize) > BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES;

        if (exceedsCountLimit || exceedsByteLimit) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }

        keptRecentFiles.push({
            ...recentFile,
            fileSize,
        });
        totalBytes += fileSize;
    }

    return {
        recentFiles: keptRecentFiles,
        evictedRefs: Array.from(evictedRefs),
    };
}

function parseChunkKey(key: string): IChunkKeyRecord | null {
    const separatorIndex = key.lastIndexOf('::');
    if (separatorIndex <= 0) {
        return null;
    }

    const ref = key.slice(0, separatorIndex);
    const index = Number.parseInt(key.slice(separatorIndex + 2), 10);
    if (!ref || Number.isNaN(index) || index < 0) {
        return null;
    }

    return {
        ref,
        index,
    };
}

function shouldInlineFileBytes(fileSize: number) {
    return fileSize <= BROWSER_INLINE_FILE_THRESHOLD_BYTES;
}

function resolveByteBackedStorageMode(fileSize: number): TBrowserDocumentStorageMode {
    return shouldInlineFileBytes(fileSize) ? 'inline' : 'chunked';
}

export class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private maintenancePromise: Promise<void> | null = null;
    private maintenanceComplete = false;

    public getRefForFile(file: File) {
        const existingEntry = Array.from(this.entries.values()).find(
            (entry) =>
                entry.fileName === file.name &&
        entry.fileSize === file.size &&
        entry.kind === 'source',
        );

        if (existingEntry) {
            return existingEntry.ref;
        }

        const ref = createBrowserDocumentRef(file.name);
        const entry: IBrowserDocumentEntry = {
            ref,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            kind: 'source',
            retention: 'durable',
            data: new Uint8Array(),
            fileSize: file.size,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: file.name,
            saveKind: /\.docx$/i.test(file.name) ? 'docx' : 'generic',
            saveHandle: null,
            storageMode: shouldInlineFileBytes(file.size) ? 'inline' : 'chunked',
            chunkCount: 0,
            chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
        };

        entry.pendingLoad = this.consumeFileIntoEntry(entry, file);
        this.entries.set(ref, entry);
        return ref;
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        await this.ensureMaintenance();
        const storageMode = resolveByteBackedStorageMode(file.size);
        const ref = createBrowserDocumentRef(file.name);
        const entry: IBrowserDocumentEntry = {
            ref,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            kind: options.kind ?? 'source',
            retention: options.retention ?? defaultRetentionForKind(options.kind ?? 'source'),
            sourceRef: options.sourceRef,
            data: new Uint8Array(),
            fileSize: file.size,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: file.name,
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            storageMode,
            chunkCount: 0,
            chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
        };

        this.entries.set(ref, entry);
        await this.consumeFileIntoEntry(entry, file);
        return ref;
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ): Promise<string> {
        await this.ensureMaintenance();
        const sourceBytes = toUint8Array(data);
        const requestedStorageMode =
            options.storageMode ?? resolveByteBackedStorageMode(sourceBytes.byteLength);
        const storageMode = requestedStorageMode === 'source-proxy'
            ? 'source-proxy'
            : requestedStorageMode === 'handle'
                ? (
                    sourceBytes.byteLength > 0
                        ? resolveByteBackedStorageMode(sourceBytes.byteLength)
                        : 'handle'
                )
                : requestedStorageMode === 'inline'
                    ? resolveByteBackedStorageMode(sourceBytes.byteLength)
                    : requestedStorageMode;
        const bytes = storageMode === 'inline'
            ? cloneBytes(sourceBytes)
            : new Uint8Array();
        const ref = createBrowserDocumentRef(fileName);
        const entry: IBrowserDocumentEntry = {
            ref,
            fileName,
            mimeType: options.mimeType,
            kind: options.kind ?? 'source',
            retention: options.retention ?? defaultRetentionForKind(options.kind ?? 'source'),
            sourceRef: options.sourceRef,
            data: bytes,
            fileSize: storageMode === 'chunked'
                ? sourceBytes.byteLength
                : bytes.byteLength,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: fileName,
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            storageMode,
            chunkCount: options.chunkCount ?? 0,
            chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        };

        this.entries.set(ref, entry);
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        if (storageMode === 'chunked' && sourceBytes.byteLength > 0) {
            await this.consumeBytesIntoChunkedEntry(entry, sourceBytes);
        }
        return ref;
    }

    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string): Promise<string> {
        const sourceEntry = await this.requireEntry(sourceRef);
        const nextName = fileName ?? sourceEntry.fileName;
        return this.createStoredDocument(nextName, new Uint8Array(), {
            mimeType: sourceEntry.mimeType,
            kind: 'working',
            sourceRef,
            saveKind: 'pdf',
            storageMode: 'source-proxy',
        });
    }

    public async cloneStoredDocument(
        sourceRef: string,
        options: {
            fileName?: string;
            kind?: IBrowserDocumentEntry['kind'];
            retention?: IBrowserDocumentEntry['retention'];
            sourceRef?: string;
            saveKind?: IBrowserDocumentEntry['saveKind'];
            saveHandle?: FileSystemFileHandle | null;
        } = {},
    ): Promise<string> {
        const sourceEntry = await this.requireEntry(sourceRef);
        const nextName = options.fileName ?? sourceEntry.fileName;
        const nextKind = options.kind ?? sourceEntry.kind;
        const nextRetention = options.retention ?? defaultRetentionForKind(nextKind);
        const nextSaveKind = options.saveKind ?? sourceEntry.saveKind;
        const nextSaveHandle = options.saveHandle ?? null;
        const nextSourceRef = options.sourceRef;

        if (sourceEntry.storageMode === 'chunked') {
            const ref = createBrowserDocumentRef(nextName);
            const entry: IBrowserDocumentEntry = {
                ref,
                fileName: nextName,
                mimeType: sourceEntry.mimeType,
                kind: nextKind,
                retention: nextRetention,
                sourceRef: nextSourceRef,
                data: new Uint8Array(),
                fileSize: sourceEntry.fileSize,
                updatedAt: Date.now(),
                pendingLoad: null,
                saveName: nextName,
                saveKind: nextSaveKind,
                saveHandle: nextSaveHandle,
                storageMode: 'chunked',
                chunkCount: 0,
                chunkSize: sourceEntry.chunkSize,
            };

            this.entries.set(ref, entry);
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));

            for (let index = 0; index < sourceEntry.chunkCount; index += 1) {
                const chunk = await this.loadChunk(sourceEntry.ref, index);
                if (!chunk) {
                    throw new Error(`Browser document chunk missing: ${sourceEntry.ref}#${index}`);
                }
                await persistChunkRecord({
                    key: createChunkKey(ref, index),
                    ref,
                    index,
                    data: cloneBytes(chunk),
                });
                entry.chunkCount = index + 1;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                if (entry.chunkCount % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                    await yieldToBrowser();
                }
            }

            return ref;
        }

        const bytes = await this.readEntryBytes(sourceEntry);
        return this.createStoredDocument(nextName, bytes, {
            mimeType: sourceEntry.mimeType,
            kind: nextKind,
            retention: nextRetention,
            sourceRef: nextSourceRef,
            saveKind: nextSaveKind,
            saveHandle: nextSaveHandle,
        });
    }

    public async ensureEntry(ref: string): Promise<IBrowserDocumentEntry | null> {
        await this.ensureMaintenance();
        const inMemory = this.entries.get(ref);
        if (inMemory) {
            if (inMemory.pendingLoad) {
                await inMemory.pendingLoad;
            }
            return inMemory;
        }

        const persisted = await loadRecord(ref);
        const normalizedRecord = toPersistedDocumentRecord(persisted);
        if (!normalizedRecord) {
            return null;
        }

        const entry: IBrowserDocumentEntry = {
            ...normalizedRecord,
            data: cloneBytes(normalizedRecord.data),
            pendingLoad: null,
            retention: normalizedRecord.retention ?? defaultRetentionForKind(normalizedRecord.kind),
            saveName: normalizedRecord.saveName ?? normalizedRecord.fileName,
            saveKind: normalizedRecord.saveKind ?? (
                /\.pdf$/i.test(normalizedRecord.fileName)
                    ? 'pdf'
                    : /\.docx$/i.test(normalizedRecord.fileName)
                        ? 'docx'
                        : 'generic'
            ),
            saveHandle: normalizedRecord.saveHandle ?? null,
            storageMode: normalizedRecord.storageMode ?? 'inline',
            chunkCount: normalizedRecord.chunkCount ?? 0,
            chunkSize: normalizedRecord.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        };

        this.entries.set(ref, entry);
        return entry;
    }

    public async requireEntry(ref: string): Promise<IBrowserDocumentEntry> {
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            throw new Error(`Browser document not found: ${ref}`);
        }
        return entry;
    }

    public async read(ref: string): Promise<Uint8Array> {
        const entry = await this.requireEntry(ref);
        if (entry.fileSize > BROWSER_MAX_FULL_READ_BYTES) {
            throw buildBrowserDocumentFullReadError(entry.fileName, entry.fileSize);
        }
        return this.readEntryBytes(entry);
    }

    public async readRange(
        ref: string,
        offset: number,
        length: number,
    ): Promise<Uint8Array> {
        const entry = await this.requireEntry(ref);
        return this.readEntryRange(entry, offset, length);
    }

    public async stat(ref: string): Promise<{ size: number; }> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            return this.stat(entry.sourceRef);
        }

        if (entry.storageMode === 'handle' && entry.saveHandle) {
            const size = await readFileHandleSize(entry.saveHandle);
            if (entry.fileSize !== size) {
                entry.fileSize = size;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            }
        }

        return { size: entry.fileSize };
    }

    public async write(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ): Promise<boolean> {
        const entry = await this.requireEntry(ref);
        const bytes = options.unloadAfterPersist
            ? normalizePersistedWriteBytes(data, false)
            : normalizePersistedWriteBytes(data);
        const nextStorageMode = resolveByteBackedStorageMode(bytes.byteLength);
        await this.clearExternalStorage(entry);
        entry.storageMode = nextStorageMode;
        entry.chunkCount = 0;
        entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = bytes.byteLength;
        entry.updatedAt = Date.now();

        if (nextStorageMode === 'chunked') {
            entry.data = new Uint8Array();
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            await this.consumeBytesIntoChunkedEntry(entry, bytes);
        } else {
            await persistRecord(this.toPersistedRecord(entry, bytes, false));
            entry.data = bytes;
        }

        if (options.unloadAfterPersist) {
            this.entries.delete(ref);
            return true;
        }
        return true;
    }

    public async readText(ref: string): Promise<string> {
        const bytes = await this.read(ref);
        return new TextDecoder().decode(bytes);
    }

    public async exists(ref: string): Promise<boolean> {
        return (await this.ensureEntry(ref)) !== null;
    }

    public async remove(ref: string): Promise<void> {
        await this.ensureMaintenance();
        const entry = await this.ensureEntry(ref);
        if (entry) {
            await this.clearExternalStorage(entry);
        }
        this.entries.delete(ref);
        await deleteRecord(ref);
        await this.removeRecentFile(ref);
    }

    public unload(ref: string) {
        this.entries.delete(ref);
    }

    public async cleanupDetachedDocument(ref: string): Promise<boolean> {
        return this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
    }

    private async cleanupDetachedPersistedRecord(
        ref: string,
        options?: { allowDurable?: boolean },
    ): Promise<boolean> {
        await this.ensureMaintenance();
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            return false;
        }

        if (entry.kind === 'working') {
            await this.remove(ref);
            return true;
        }

        if (this.isRecentFileRef(ref)) {
            return false;
        }

        const records = await this.getAllPersistedRecords();
        const hasDependents = records.some((record) => (
            record.ref !== ref
            && record.sourceRef === ref
        ));
        if (hasDependents) {
            return false;
        }

        if (entry.retention !== 'transient' && options?.allowDurable !== true) {
            return false;
        }

        await this.remove(ref);
        return true;
    }

    public async replaceWorkingCopySource(
        workingRef: string,
        sourceRef: string,
        saveName: string,
        saveHandle?: FileSystemFileHandle | null,
    ): Promise<void> {
        const workingEntry = await this.requireEntry(workingRef);
        workingEntry.sourceRef = sourceRef;
        workingEntry.saveName = saveName;
        workingEntry.saveHandle = saveHandle ?? null;
        if (workingEntry.storageMode === 'handle') {
            workingEntry.storageMode = 'source-proxy';
            workingEntry.data = new Uint8Array();
        }
        await persistRecord(this.toPersistedRecord(workingEntry, workingEntry.data, false));
    }

    public async assignSaveTarget(
        ref: string,
        saveName: string,
        saveKind: IBrowserDocumentEntry['saveKind'],
        saveHandle?: FileSystemFileHandle | null,
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        entry.saveName = saveName;
        entry.saveKind = saveKind;
        entry.saveHandle = saveHandle ?? null;
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async setRetention(
        ref: string,
        retention: IBrowserDocumentEntry['retention'],
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        entry.retention = retention;
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async getSourceRef(ref: string): Promise<string> {
        const entry = await this.requireEntry(ref);
        return entry.sourceRef ?? ref;
    }

    public async ensureByteBackedSource(ref: string): Promise<void> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            await this.ensureByteBackedSource(entry.sourceRef);
            return;
        }

        if (
            entry.kind !== 'source'
            || entry.storageMode !== 'handle'
            || !entry.saveHandle
        ) {
            return;
        }

        const file = await entry.saveHandle.getFile();
        entry.storageMode = resolveByteBackedStorageMode(file.size);
        entry.chunkCount = 0;
        entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = file.size;
        await this.consumeFileIntoEntry(entry, file);
    }

    public async getFileName(ref: string): Promise<string> {
        const entry = await this.requireEntry(ref);
        return entry.fileName;
    }

    public async getMimeType(ref: string): Promise<string> {
        const entry = await this.requireEntry(ref);
        return entry.mimeType;
    }

    public async getSaveTarget(ref: string): Promise<{
        saveName: string;
        saveKind: IBrowserDocumentEntry['saveKind'];
        saveHandle: FileSystemFileHandle | null;
    }> {
        const entry = await this.requireEntry(ref);
        return {
            saveName: entry.saveName ?? entry.fileName,
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle ?? null,
        };
    }

    public async replaceWithHandleBackedDocument(
        ref: string,
        options: {
            fileSize: number;
            saveHandle?: FileSystemFileHandle | null;
            saveName?: string;
        },
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        await this.clearExternalStorage(entry);
        entry.data = new Uint8Array();
        entry.storageMode = 'handle';
        entry.chunkCount = 0;
        entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = options.fileSize;
        entry.updatedAt = Date.now();
        if (options.saveHandle !== undefined) {
            entry.saveHandle = options.saveHandle;
        }
        if (options.saveName) {
            entry.saveName = options.saveName;
            entry.fileName = options.saveName;
        }
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async prepareChunkedDocument(
        ref: string,
        options?: { chunkSize?: number },
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        await this.clearExternalStorage(entry);
        entry.data = new Uint8Array();
        entry.storageMode = 'chunked';
        entry.chunkCount = 0;
        entry.chunkSize = options?.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = 0;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async writeChunk(
        ref: string,
        index: number,
        data: Uint8Array,
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        await persistChunkRecord({
            key: createChunkKey(ref, index),
            ref,
            index,
            data: cloneBytes(data),
        });
        if (entry.storageMode !== 'chunked') {
            entry.storageMode = 'chunked';
        }
        if (entry.chunkCount < index + 1) {
            entry.chunkCount = index + 1;
            entry.updatedAt = Date.now();
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        }
    }

    public async finalizeChunkedDocument(
        ref: string,
        options: {
            fileSize: number;
            chunkCount: number;
            chunkSize?: number;
            saveName?: string;
        },
    ): Promise<void> {
        const entry = await this.requireEntry(ref);
        entry.data = new Uint8Array();
        entry.storageMode = 'chunked';
        entry.chunkCount = options.chunkCount;
        entry.chunkSize = options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = options.fileSize;
        entry.updatedAt = Date.now();
        if (options.saveName) {
            entry.saveName = options.saveName;
            entry.fileName = options.saveName;
        }
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async clearChunkedDocument(ref: string): Promise<void> {
        const entry = await this.ensureEntry(ref);
        if (!entry || entry.storageMode !== 'chunked') {
            return;
        }
        await this.clearExternalStorage(entry);
        entry.storageMode = 'inline';
        entry.chunkCount = 0;
        entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.data = new Uint8Array();
        entry.fileSize = 0;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async touchRecentFile(ref: string) {
        const entry = await this.requireEntry(ref);
        if (entry.retention === 'transient') {
            await this.removeRecentFile(ref);
            return;
        }
        const nextRecentFiles = readRecentFilesFromStorage().filter(
            (candidate) => candidate.originalPath !== ref,
        );

        nextRecentFiles.unshift({
            originalPath: ref,
            fileName: entry.saveName ?? entry.fileName,
            timestamp: Date.now(),
            fileSize: entry.fileSize,
        });

        const {
            recentFiles,
            evictedRefs,
        } = pruneRecentFiles(nextRecentFiles);
        writeRecentFilesToStorage(recentFiles);
        await this.cleanupEvictedRecentRefs(evictedRefs);
    }

    public getRecentFiles() {
        const recentFiles = readRecentFilesFromStorage();
        writeRecentFilesToCookie(recentFiles);
        return recentFiles;
    }

    public async removeRecentFile(ref: string) {
        const currentRecentFiles = readRecentFilesFromStorage();
        const nextRecentFiles = currentRecentFiles.filter(
            (candidate) => candidate.originalPath !== ref,
        );

        writeRecentFilesToStorage(nextRecentFiles);
        if (nextRecentFiles.length !== currentRecentFiles.length) {
            await this.cleanupEvictedRecentRefs([ref]);
        }
    }

    public async clearRecentFiles() {
        const evictedRefs = readRecentFilesFromStorage().map(
            (candidate) => candidate.originalPath,
        );
        writeRecentFilesToStorage([]);
        await this.cleanupEvictedRecentRefs(evictedRefs);
    }

    public static getFileNameFromRef(ref: string) {
        return getDocumentFileName(ref);
    }

    private isRecentFileRef(ref: string) {
        return readRecentFilesFromStorage().some(
            (candidate) => candidate.originalPath === ref,
        );
    }

    private async ensureMaintenance(): Promise<void> {
        if (this.maintenanceComplete) {
            return;
        }

        if (!this.maintenancePromise) {
            this.maintenancePromise = this.sweepPersistedOrphans()
                .finally(() => {
                    this.maintenancePromise = null;
                    this.maintenanceComplete = true;
                });
        }

        await this.maintenancePromise;
    }

    private async getAllPersistedRecords(): Promise<IBrowserPersistedDocumentRecord[]> {
        const rawRecords = await loadAllRecords();
        if (!Array.isArray(rawRecords)) {
            return [];
        }

        return rawRecords
            .map(record => toPersistedDocumentRecord(record))
            .filter((record): record is IBrowserPersistedDocumentRecord => record !== null);
    }

    private async sweepPersistedOrphans(): Promise<void> {
        const records = await this.getAllPersistedRecords();
        if (records.length === 0) {
            return;
        }

        const currentRecentFiles = readRecentFilesFromStorage();
        const {
            recentFiles,
            evictedRefs,
        } = pruneRecentFiles(currentRecentFiles);
        if (
            evictedRefs.length > 0
            || recentFiles.length !== currentRecentFiles.length
        ) {
            writeRecentFilesToStorage(recentFiles);
        }
        const recentRefs = new Set(recentFiles.map((file) => file.originalPath));
        const nonWorkingDependentCounts = new Map<string, number>();

        for (const record of records) {
            if (!record.sourceRef || record.kind === 'working') {
                continue;
            }

            nonWorkingDependentCounts.set(
                record.sourceRef,
                (nonWorkingDependentCounts.get(record.sourceRef) ?? 0) + 1,
            );
        }

        const refsToRemove = records
            .filter((record) => (
                record.kind === 'working'
                || (
                    !recentRefs.has(record.ref)
                    && (nonWorkingDependentCounts.get(record.ref) ?? 0) === 0
                )
            ))
            .map(record => record.ref);

        const recordsByRef = new Map(records.map((record) => [
            record.ref,
            record,
        ]));
        const rawChunkKeys = await loadAllChunkKeys();
        const chunkKeys = Array.isArray(rawChunkKeys)
            ? rawChunkKeys
                .map((key) => typeof key === 'string' ? parseChunkKey(key) : null)
                .filter((key): key is IChunkKeyRecord => key !== null)
            : [];
        const chunkIndicesByRef = new Map<string, Set<number>>();
        for (const chunkKey of chunkKeys) {
            let refChunks = chunkIndicesByRef.get(chunkKey.ref);
            if (!refChunks) {
                refChunks = new Set<number>();
                chunkIndicesByRef.set(chunkKey.ref, refChunks);
            }
            refChunks.add(chunkKey.index);
        }
        const brokenChunkRefs = records
            .filter((record) => {
                if (record.storageMode !== 'chunked' || (record.chunkCount ?? 0) <= 0) {
                    return false;
                }

                const chunkIndices = chunkIndicesByRef.get(record.ref);
                if (!chunkIndices) {
                    return true;
                }

                for (let index = 0; index < (record.chunkCount ?? 0); index += 1) {
                    if (!chunkIndices.has(index)) {
                        return true;
                    }
                }

                return false;
            })
            .map((record) => record.ref);
        const refsToRemoveSet = new Set([
            ...refsToRemove,
            ...brokenChunkRefs,
        ]);
        const chunkDeletes = chunkKeys
            .filter((chunkKey) => {
                const record = recordsByRef.get(chunkKey.ref);
                if (!record || refsToRemoveSet.has(chunkKey.ref)) {
                    return true;
                }

                if (record.storageMode !== 'chunked') {
                    return true;
                }

                return chunkKey.index >= (record.chunkCount ?? 0);
            })
            .map((chunkKey) => deleteChunkRecord(chunkKey.ref, chunkKey.index));

        if (refsToRemove.length === 0 && chunkDeletes.length === 0) {
            return;
        }

        refsToRemoveSet.forEach((ref) => {
            this.entries.delete(ref);
        });
        await Promise.all([
            ...chunkDeletes,
            ...Array.from(refsToRemoveSet, async (ref) => {
                await deleteRecord(ref);
            }),
        ]);
        if (refsToRemoveSet.size > 0) {
            const remainingRecentFiles = readRecentFilesFromStorage().filter(
                (candidate) => !refsToRemoveSet.has(candidate.originalPath),
            );
            writeRecentFilesToStorage(remainingRecentFiles);
        }
    }

    private async cleanupEvictedRecentRefs(refs: string[]) {
        const uniqueRefs = Array.from(new Set(
            refs.filter((ref) => typeof ref === 'string' && ref.length > 0),
        ));
        if (uniqueRefs.length === 0) {
            return;
        }

        await Promise.allSettled(
            uniqueRefs.map(async (ref) => {
                await this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
            }),
        );
    }

    private async consumeFileIntoEntry(
        entry: IBrowserDocumentEntry,
        file: File,
    ): Promise<void> {
        const pendingLoad = (async () => {
            if (entry.storageMode === 'chunked') {
                entry.data = new Uint8Array();
                entry.chunkCount = 0;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.fileSize = file.size;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));

                let chunkIndex = 0;
                for (
                    let offset = 0;
                    offset < file.size;
                    offset += entry.chunkSize
                ) {
                    const chunk = new Uint8Array(
                        await file.slice(offset, offset + entry.chunkSize).arrayBuffer(),
                    );
                    await persistChunkRecord({
                        key: createChunkKey(entry.ref, chunkIndex),
                        ref: entry.ref,
                        index: chunkIndex,
                        data: cloneBytes(chunk),
                    });
                    chunkIndex += 1;
                    entry.chunkCount = chunkIndex;
                    entry.updatedAt = Date.now();
                    await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                    if (chunkIndex % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                        await yieldToBrowser();
                    }
                }

                entry.fileSize = file.size;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            } else {
                const bytes = new Uint8Array(await file.arrayBuffer());
                entry.data = bytes;
                entry.fileSize = bytes.byteLength;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            }
            entry.pendingLoad = null;
        })();

        entry.pendingLoad = pendingLoad;
        await pendingLoad;
    }

    private async consumeBytesIntoChunkedEntry(
        entry: IBrowserDocumentEntry,
        bytes: Uint8Array,
    ): Promise<void> {
        entry.data = new Uint8Array();
        entry.chunkCount = 0;
        entry.chunkSize = Math.max(1, entry.chunkSize);
        entry.fileSize = bytes.byteLength;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));

        let chunkIndex = 0;
        for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += entry.chunkSize
        ) {
            const chunk = bytes.slice(offset, offset + entry.chunkSize);
            await persistChunkRecord({
                key: createChunkKey(entry.ref, chunkIndex),
                ref: entry.ref,
                index: chunkIndex,
                data: cloneBytes(chunk),
            });
            chunkIndex += 1;
            if (chunkIndex % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                await yieldToBrowser();
            }
        }

        entry.chunkCount = chunkIndex;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    private async readEntryBytes(entry: IBrowserDocumentEntry): Promise<Uint8Array> {
        switch (entry.storageMode) {
            case 'source-proxy':
                if (!entry.sourceRef) {
                    return new Uint8Array();
                }
                return this.read(entry.sourceRef);
            case 'handle': {
                if (!entry.saveHandle) {
                    return cloneBytes(entry.data);
                }
                const {
                    size,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle);
                if (entry.fileSize !== size) {
                    entry.fileSize = size;
                    entry.updatedAt = Date.now();
                    await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                }
                return bytes;
            }
            case 'chunked': {
                if (entry.fileSize === 0 || entry.chunkCount === 0) {
                    return new Uint8Array();
                }
                const bytes = new Uint8Array(entry.fileSize);
                let writeOffset = 0;
                for (let index = 0; index < entry.chunkCount; index += 1) {
                    const chunk = await this.loadChunk(entry.ref, index);
                    if (!chunk) {
                        throw new Error(`Browser document chunk missing: ${entry.ref}#${index}`);
                    }
                    bytes.set(chunk, writeOffset);
                    writeOffset += chunk.byteLength;
                }
                return bytes;
            }
            case 'inline':
            default:
                return cloneBytes(entry.data);
        }
    }

    private async readEntryRange(
        entry: IBrowserDocumentEntry,
        offset: number,
        length: number,
    ) {
        const start = Math.max(0, Math.floor(offset));
        const rangeLength = Math.max(0, Math.floor(length));
        const end = start + rangeLength;

        switch (entry.storageMode) {
            case 'source-proxy':
                if (!entry.sourceRef) {
                    return new Uint8Array();
                }
                return this.readRange(entry.sourceRef, start, rangeLength);
            case 'handle': {
                if (!entry.saveHandle) {
                    return entry.data.slice(start, end);
                }
                const {
                    size,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle, start, rangeLength);
                if (entry.fileSize !== size) {
                    entry.fileSize = size;
                    entry.updatedAt = Date.now();
                    await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                }
                return bytes;
            }
            case 'chunked': {
                if (rangeLength === 0 || entry.chunkCount === 0 || entry.fileSize === 0) {
                    return new Uint8Array();
                }
                const boundedEnd = Math.min(end, entry.fileSize);
                const boundedLength = Math.max(0, boundedEnd - start);
                if (boundedLength === 0) {
                    return new Uint8Array();
                }
                const output = new Uint8Array(boundedLength);
                const chunkSize = Math.max(1, entry.chunkSize);
                const firstChunkIndex = Math.floor(start / chunkSize);
                const lastChunkIndex = Math.floor((boundedEnd - 1) / chunkSize);
                let outputOffset = 0;

                for (
                    let chunkIndex = firstChunkIndex;
                    chunkIndex <= lastChunkIndex;
                    chunkIndex += 1
                ) {
                    const chunk = await this.loadChunk(entry.ref, chunkIndex);
                    if (!chunk) {
                        throw new Error(`Browser document chunk missing: ${entry.ref}#${chunkIndex}`);
                    }

                    const chunkStart = chunkIndex * chunkSize;
                    const sliceStart = Math.max(0, start - chunkStart);
                    const sliceEnd = Math.min(chunk.byteLength, boundedEnd - chunkStart);
                    const slice = chunk.slice(sliceStart, sliceEnd);
                    output.set(slice, outputOffset);
                    outputOffset += slice.byteLength;
                }

                return output;
            }
            case 'inline':
            default:
                return entry.data.slice(start, end);
        }
    }

    private async loadChunk(ref: string, index: number): Promise<Uint8Array | null> {
        const rawChunk = await loadChunkRecord(ref, index);
        const normalizedChunk = toPersistedChunkRecord(rawChunk);
        return normalizedChunk ? cloneBytes(normalizedChunk.data) : null;
    }

    private async deleteChunks(ref: string, chunkCount: number) {
        if (chunkCount <= 0) {
            return;
        }
        await Promise.all(Array.from({ length: chunkCount }, async (_value, index) => {
            await deleteChunkRecord(ref, index);
        }));
    }

    private async clearExternalStorage(entry: IBrowserDocumentEntry) {
        if (entry.storageMode === 'chunked' && entry.chunkCount > 0) {
            await this.deleteChunks(entry.ref, entry.chunkCount);
        }
    }

    private toPersistedRecord(
        entry: IBrowserDocumentEntry,
        data = entry.data,
        cloneData = true,
    ): IBrowserPersistedDocumentRecord {
        return {
            ref: entry.ref,
            fileName: entry.fileName,
            mimeType: entry.mimeType,
            kind: entry.kind,
            retention: entry.retention,
            sourceRef: entry.sourceRef,
            data: cloneData ? cloneBytes(data) : data,
            fileSize: entry.fileSize,
            updatedAt: entry.updatedAt,
            saveName: entry.saveName,
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle ?? null,
            storageMode: entry.storageMode,
            chunkCount: entry.chunkCount,
            chunkSize: entry.chunkSize,
        };
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
export function isBrowserDocumentRef(path: string) {
    return path.startsWith(BROWSER_REF_PREFIX);
}
export function getBrowserDocumentFileName(path: string) {
    return BrowserDocumentStore.getFileNameFromRef(path);
}
