import type { IRecentFile } from '@contracts/shared';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/local-storage';

const BROWSER_REF_PREFIX = 'browser://documents/';
const RECENT_FILES_STORAGE_KEY = 'evb-viewer:browser:recent-files';
const DB_NAME = 'evb-viewer-browser-documents';
const DB_VERSION = 1;
const DOCUMENTS_STORE = 'documents';

interface IBrowserPersistedDocumentRecord {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: 'source' | 'working' | 'output';
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    updatedAt: number;
}

interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    pendingLoad: Promise<void> | null;
    saveName: string | null;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
}

interface IRegisterFileOptions {
    kind?: IBrowserDocumentEntry['kind'];
    saveKind?: IBrowserDocumentEntry['saveKind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

interface ICreateStoredDocumentOptions {
    mimeType: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    kind?: IBrowserDocumentEntry['kind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
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

    return decodeURIComponent(trimmed.split('/').at(-1) ?? 'document');
}

function createBrowserDocumentRef(fileName: string) {
    return `${BROWSER_REF_PREFIX}${crypto.randomUUID()}/${encodeURIComponent(fileName)}`;
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
    const data = normalizePersistedBytes(value.data);
    const fileSize = typeof value.fileSize === 'number' ? value.fileSize : null;
    const updatedAt =
        typeof value.updatedAt === 'number' ? value.updatedAt : null;
    const sourceRef =
        typeof value.sourceRef === 'string' ? value.sourceRef : undefined;

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
        sourceRef,
        data,
        fileSize,
        updatedAt,
    };
}

function cloneBytes(data: Uint8Array) {
    return data.slice();
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
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

async function withObjectStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
) {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    return new Promise<T | null>((resolve) => {
        const transaction = database.transaction(DOCUMENTS_STORE, mode);
        const store = transaction.objectStore(DOCUMENTS_STORE);
        const request = run(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
    });
}

async function persistRecord(record: IBrowserPersistedDocumentRecord) {
    await withObjectStore('readwrite', (store) => store.put(record));
}

async function loadRecord(ref: string) {
    return withObjectStore<unknown>(
        'readonly',
        (store) => store.get(ref) as IDBRequest<unknown>,
    );
}

async function deleteRecord(ref: string) {
    await withObjectStore('readwrite', (store) => store.delete(ref));
}

function normalizeRecentFile(value: unknown): IRecentFile | null {
    if (!isRecord(value)) {
        return null;
    }

    const originalPath =
        typeof value.originalPath === 'string' ? value.originalPath : null;
    const fileName = typeof value.fileName === 'string' ? value.fileName : null;
    const timestamp =
        typeof value.timestamp === 'number' ? value.timestamp : null;
    const fileSize =
        typeof value.fileSize === 'number' ? value.fileSize : undefined;

    if (!originalPath || !fileName || timestamp === null) {
        return null;
    }

    return {
        originalPath,
        fileName,
        timestamp,
        fileSize,
    };
}

function readRecentFilesFromStorage() {
    const raw = safeGetLocalStorageItem(RECENT_FILES_STORAGE_KEY);
    if (!raw) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map(normalizeRecentFile)
            .filter((entry): entry is IRecentFile => entry !== null);
    } catch {
        return [];
    }
}

function writeRecentFilesToStorage(recentFiles: IRecentFile[]) {
    safeSetLocalStorageItem(
        RECENT_FILES_STORAGE_KEY,
        JSON.stringify(recentFiles),
    );
}

class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();

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
            data: new Uint8Array(),
            fileSize: file.size,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: file.name,
            saveKind: /\.docx$/i.test(file.name) ? 'docx' : 'generic',
            saveHandle: null,
        };

        entry.pendingLoad = this.consumeFileIntoEntry(entry, file);
        this.entries.set(ref, entry);
        return ref;
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        const ref = createBrowserDocumentRef(file.name);
        const entry: IBrowserDocumentEntry = {
            ref,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            kind: options.kind ?? 'source',
            sourceRef: options.sourceRef,
            data: new Uint8Array(),
            fileSize: file.size,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: file.name,
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
        };

        this.entries.set(ref, entry);
        await this.consumeFileIntoEntry(entry, file);
        return ref;
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ) {
        const bytes = cloneBytes(toUint8Array(data));
        const ref = createBrowserDocumentRef(fileName);
        const entry: IBrowserDocumentEntry = {
            ref,
            fileName,
            mimeType: options.mimeType,
            kind: options.kind ?? 'source',
            sourceRef: options.sourceRef,
            data: bytes,
            fileSize: bytes.byteLength,
            updatedAt: Date.now(),
            pendingLoad: null,
            saveName: fileName,
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
        };

        this.entries.set(ref, entry);
        await persistRecord(this.toPersistedRecord(entry));
        return ref;
    }

    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string) {
        const sourceEntry = await this.requireEntry(sourceRef);
        const nextName = fileName ?? sourceEntry.fileName;
        return this.createStoredDocument(nextName, sourceEntry.data, {
            mimeType: sourceEntry.mimeType,
            kind: 'working',
            sourceRef,
            saveKind: 'pdf',
        });
    }

    public async ensureEntry(ref: string) {
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
            saveName: normalizedRecord.fileName,
            saveKind: /\.pdf$/i.test(normalizedRecord.fileName)
                ? 'pdf'
                : /\.docx$/i.test(normalizedRecord.fileName)
                    ? 'docx'
                    : 'generic',
            saveHandle: null,
        };

        this.entries.set(ref, entry);
        return entry;
    }

    public async requireEntry(ref: string) {
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            throw new Error(`Browser document not found: ${ref}`);
        }
        return entry;
    }

    public async read(ref: string) {
        const entry = await this.requireEntry(ref);
        return cloneBytes(entry.data);
    }

    public async stat(ref: string) {
        const entry = await this.requireEntry(ref);
        return { size: entry.fileSize };
    }

    public async write(ref: string, data: Uint8Array | ArrayBuffer) {
        const entry = await this.requireEntry(ref);
        const bytes = cloneBytes(toUint8Array(data));
        entry.data = bytes;
        entry.fileSize = bytes.byteLength;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry));
        return true;
    }

    public async readText(ref: string) {
        const bytes = await this.read(ref);
        return new TextDecoder().decode(bytes);
    }

    public async exists(ref: string) {
        return (await this.ensureEntry(ref)) !== null;
    }

    public async remove(ref: string) {
        this.entries.delete(ref);
        await deleteRecord(ref);
    }

    public async replaceWorkingCopySource(
        workingRef: string,
        sourceRef: string,
        saveName: string,
        saveHandle?: FileSystemFileHandle | null,
    ) {
        const workingEntry = await this.requireEntry(workingRef);
        workingEntry.sourceRef = sourceRef;
        workingEntry.saveName = saveName;
        workingEntry.saveHandle = saveHandle ?? null;
        await persistRecord(this.toPersistedRecord(workingEntry));
    }

    public async assignSaveTarget(
        ref: string,
        saveName: string,
        saveKind: IBrowserDocumentEntry['saveKind'],
        saveHandle?: FileSystemFileHandle | null,
    ) {
        const entry = await this.requireEntry(ref);
        entry.saveName = saveName;
        entry.saveKind = saveKind;
        entry.saveHandle = saveHandle ?? null;
        await persistRecord(this.toPersistedRecord(entry));
    }

    public async getSourceRef(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.sourceRef ?? ref;
    }

    public async getFileName(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.fileName;
    }

    public async getMimeType(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.mimeType;
    }

    public async getSaveTarget(ref: string) {
        const entry = await this.requireEntry(ref);
        return {
            saveName: entry.saveName ?? entry.fileName,
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle ?? null,
        };
    }

    public async touchRecentFile(ref: string) {
        const entry = await this.requireEntry(ref);
        const recentFiles = readRecentFilesFromStorage().filter(
            (candidate) => candidate.originalPath !== ref,
        );

        recentFiles.unshift({
            originalPath: ref,
            fileName: entry.fileName,
            timestamp: Date.now(),
            fileSize: entry.fileSize,
        });

        writeRecentFilesToStorage(recentFiles.slice(0, 30));
    }

    public getRecentFiles() {
        return readRecentFilesFromStorage();
    }

    public removeRecentFile(ref: string) {
        const nextRecentFiles = readRecentFilesFromStorage().filter(
            (candidate) => candidate.originalPath !== ref,
        );

        writeRecentFilesToStorage(nextRecentFiles);
    }

    public clearRecentFiles() {
        writeRecentFilesToStorage([]);
    }

    public static getFileNameFromRef(ref: string) {
        return getDocumentFileName(ref);
    }

    private async consumeFileIntoEntry(entry: IBrowserDocumentEntry, file: File) {
        const pendingLoad = (async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            entry.data = bytes;
            entry.fileSize = bytes.byteLength;
            entry.updatedAt = Date.now();
            entry.pendingLoad = null;
            await persistRecord(this.toPersistedRecord(entry));
        })();

        entry.pendingLoad = pendingLoad;
        await pendingLoad;
    }

    private toPersistedRecord(
        entry: IBrowserDocumentEntry,
    ): IBrowserPersistedDocumentRecord {
        return {
            ref: entry.ref,
            fileName: entry.fileName,
            mimeType: entry.mimeType,
            kind: entry.kind,
            sourceRef: entry.sourceRef,
            data: cloneBytes(entry.data),
            fileSize: entry.fileSize,
            updatedAt: entry.updatedAt,
        };
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
export { BROWSER_REF_PREFIX };
export function isBrowserDocumentRef(path: string) {
    return path.startsWith(BROWSER_REF_PREFIX);
}
export function getBrowserDocumentFileName(path: string) {
    return BrowserDocumentStore.getFileNameFromRef(path);
}
