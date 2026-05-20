import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
} from './browserDocumentConstants';
import { uniq } from 'es-toolkit/array';
import {
    cloneBytes,
    normalizePersistedWriteBytes,
    normalizeReadRange,
    toUint8Array,
} from './browserDocumentBytes';
import { buildRecentFilesFromPersistedRecords } from './browserDocumentRecentFiles';
import {
    collectChunkIndicesByRef,
    countNonWorkingDependents,
    createBrowserDocumentEntry,
    createEntryFromPersistedRecord,
    isChunkedRecordMissingChunks,
    shouldRemovePersistedRecord,
    toPersistedDocumentRecord,
} from './browserDocumentRecords';
import { createBrowserDocumentRef } from './browserDocumentRefs';
import {
    buildBrowserDocumentFullReadError,
    defaultRetentionForKind,
    resolveByteBackedStorageMode,
    resolveStoredDocumentStorageMode,
    shouldInlineFileBytes,
} from './browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
    IChunkKeyRecord,
    ICreateStoredDocumentOptions,
    IRegisterFileOptions,
    IWriteDocumentOptions,
} from './browserDocumentTypes';
import {
    deleteRecord,
    loadAllRecords,
    loadRecord,
    persistRecord,
} from '@app/platform/browser/browserDocumentIdb';
import {
    createChunkKey,
    deleteChunkRecord,
    loadAllChunkKeys,
    loadChunkRecord,
    parseChunkKey,
    persistChunkRecord,
    toPersistedChunkRecord,
} from '@app/platform/browser/browserDocumentChunks';
import {
    readFileHandleBytes,
    readFileHandleSize,
} from '@app/platform/browser/browserFileHandleBridge';
import {
    BrowserRecentFilesStore,
    hasRecentFilesStorageSnapshot,
    pruneRecentFiles,
    readRecentFilesFromStorage,
    writeRecentFilesToStorage,
} from '@app/platform/browser/browserRecentFilesStore';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';

export class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private readonly fileRefs = new WeakMap<File, string>();
    private readonly mutationQueues = new Map<string, Promise<void>>();
    private readonly recentFilesStore = new BrowserRecentFilesStore({
        requireEntry: (ref) => this.requireEntry(ref),
        getAllPersistedRecords: () => this.getAllPersistedRecords(),
        cleanupEvictedRecentRefs: (refs) => this.cleanupEvictedRecentRefs(refs),
    });
    private maintenancePromise: Promise<void> | null = null;
    private maintenanceComplete = false;

    private createChunkGeneration() {
        const randomValue = crypto.randomUUID?.() ?? this.createFallbackChunkGenerationId();
        return `${Date.now().toString(36)}-${randomValue}`;
    }

    private createFallbackChunkGenerationId() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    public getRefForFile(file: File) {
        const existingRef = this.fileRefs.get(file);
        if (existingRef && this.entries.has(existingRef)) {
            return existingRef;
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

        this.entries.set(ref, entry);
        this.fileRefs.set(file, ref);
        void this.consumeFileIntoEntry(entry, file)
            .catch(() => {
                if (this.entries.get(ref) === entry) {
                    this.entries.delete(ref);
                }
                return undefined;
            });
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
            ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
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
        this.fileRefs.set(file, ref);
        try {
            await this.consumeFileIntoEntry(entry, file);
        } catch (error) {
            this.entries.delete(ref);
            throw error;
        }
        return ref;
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ): Promise<string> {
        await this.ensureMaintenance();
        const sourceBytes = toUint8Array(data);
        const storageMode = resolveStoredDocumentStorageMode(
            sourceBytes.byteLength,
            options.storageMode,
        );
        const bytes = storageMode === 'inline'
            ? cloneBytes(sourceBytes)
            : new Uint8Array();
        const ref = createBrowserDocumentRef(fileName);
        const kind = options.kind ?? 'source';
        const entry = createBrowserDocumentEntry({
            ref,
            fileName,
            mimeType: options.mimeType,
            kind,
            retention: options.retention ?? defaultRetentionForKind(kind),
            ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
            data: bytes,
            fileSize: storageMode === 'chunked'
                ? sourceBytes.byteLength
                : bytes.byteLength,
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            storageMode,
            chunkCount: options.chunkCount ?? 0,
            chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        });

        this.entries.set(ref, entry);
        try {
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            if (storageMode === 'chunked' && sourceBytes.byteLength > 0) {
                await this.consumeBytesIntoChunkedEntry(entry, sourceBytes);
            }
        } catch (error) {
            this.entries.delete(ref);
            if (entry.storageMode === 'chunked') {
                await this.deleteChunks(entry.ref, entry.chunkCount, entry.chunkGeneration)
                    .catch(() => undefined);
            }
            await deleteRecord(ref).catch(() => undefined);
            throw error;
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
                ...(nextSourceRef ? { sourceRef: nextSourceRef } : {}),
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
            try {
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));

                for (let index = 0; index < sourceEntry.chunkCount; index += 1) {
                    const chunk = await this.loadChunk(sourceEntry.ref, index, sourceEntry.chunkGeneration);
                    if (!chunk) {
                        throw new Error(`Browser document chunk missing: ${sourceEntry.ref}#${index}`);
                    }
                    await persistChunkRecord({
                        key: createChunkKey(ref, index, entry.chunkGeneration),
                        ref,
                        index,
                        ...(entry.chunkGeneration ? { generation: entry.chunkGeneration } : {}),
                        data: cloneBytes(chunk),
                    });
                    entry.chunkCount = index + 1;
                    entry.updatedAt = Date.now();
                    await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                    if (entry.chunkCount % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                        await yieldToBrowser();
                    }
                }
            } catch (error) {
                this.entries.delete(ref);
                await this.deleteChunks(ref, entry.chunkCount, entry.chunkGeneration)
                    .catch(() => undefined);
                await deleteRecord(ref).catch(() => undefined);
                throw error;
            }

            return ref;
        }

        const bytes = await this.readEntryBytes(sourceEntry);
        return this.createStoredDocument(nextName, bytes, {
            mimeType: sourceEntry.mimeType,
            kind: nextKind,
            retention: nextRetention,
            ...(nextSourceRef ? { sourceRef: nextSourceRef } : {}),
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

        const entry = createEntryFromPersistedRecord(normalizedRecord);

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
            await this.updateEntryFileSize(entry, size);
        }

        return { size: entry.fileSize };
    }

    public async write(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ): Promise<boolean> {
        return this.runRefMutation(ref, async () => this.writeUnlocked(ref, data, options));
    }

    private async writeUnlocked(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ): Promise<boolean> {
        const entry = await this.requireEntry(ref);
        const bytes = options.unloadAfterPersist
            ? normalizePersistedWriteBytes(data, false)
            : normalizePersistedWriteBytes(data);
        const nextStorageMode = resolveByteBackedStorageMode(bytes.byteLength);
        const previousEntryState = {
            storageMode: entry.storageMode,
            chunkCount: entry.chunkCount,
            chunkSize: entry.chunkSize,
            chunkGeneration: entry.chunkGeneration,
            fileSize: entry.fileSize,
            updatedAt: entry.updatedAt,
            data: entry.data,
        };
        const previousChunkGeneration = entry.chunkGeneration;
        const previousChunkCount = entry.storageMode === 'chunked' ? entry.chunkCount : 0;

        try {
            entry.storageMode = nextStorageMode;
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.fileSize = bytes.byteLength;
            entry.updatedAt = Date.now();

            if (nextStorageMode === 'chunked') {
                entry.data = new Uint8Array();
                entry.chunkGeneration = this.createChunkGeneration();
                await this.consumeBytesIntoChunkedEntry(entry, bytes, { publishInitialRecord: false });
            } else {
                delete entry.chunkGeneration;
                await persistRecord(this.toPersistedRecord(entry, bytes, false));
                entry.data = bytes;
            }
            await this.deleteChunks(entry.ref, previousChunkCount, previousChunkGeneration);
        } catch (error) {
            const failedGeneration = entry.chunkGeneration;
            entry.storageMode = previousEntryState.storageMode;
            entry.chunkCount = previousEntryState.chunkCount;
            entry.chunkSize = previousEntryState.chunkSize;
            entry.fileSize = previousEntryState.fileSize;
            entry.updatedAt = previousEntryState.updatedAt;
            entry.data = previousEntryState.data;
            if (previousEntryState.chunkGeneration) {
                entry.chunkGeneration = previousEntryState.chunkGeneration;
            } else {
                delete entry.chunkGeneration;
            }
            if (failedGeneration && failedGeneration !== previousChunkGeneration) {
                await this.deleteChunks(entry.ref, Math.ceil(bytes.byteLength / BROWSER_DOCUMENT_CHUNK_SIZE), failedGeneration)
                    .catch(() => undefined);
            }
            throw error;
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
        await this.runRefMutation(ref, async () => {
            await this.ensureMaintenance();
            const entry = await this.ensureEntry(ref);
            if (entry) {
                await this.clearExternalStorage(entry);
            }
            this.entries.delete(ref);
            await deleteRecord(ref);
            await this.removeRecentFile(ref);
        });
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
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            await this.clearExternalStorage(entry);
            entry.data = new Uint8Array();
            entry.storageMode = 'chunked';
            entry.chunkCount = 0;
            entry.chunkSize = options?.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.chunkGeneration = this.createChunkGeneration();
            entry.fileSize = 0;
            entry.updatedAt = Date.now();
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        });
    }

    public async writeChunk(
        ref: string,
        index: number,
        data: Uint8Array,
    ): Promise<void> {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            if (!entry.chunkGeneration) {
                entry.chunkGeneration = this.createChunkGeneration();
            }
            await persistChunkRecord({
                key: createChunkKey(ref, index, entry.chunkGeneration),
                ref,
                index,
                generation: entry.chunkGeneration,
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
        });
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
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            entry.data = new Uint8Array();
            entry.storageMode = 'chunked';
            entry.chunkCount = options.chunkCount;
            entry.chunkSize = options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            if (!entry.chunkGeneration) {
                entry.chunkGeneration = this.createChunkGeneration();
            }
            entry.fileSize = options.fileSize;
            entry.updatedAt = Date.now();
            if (options.saveName) {
                entry.saveName = options.saveName;
                entry.fileName = options.saveName;
            }
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        });
    }

    public async clearChunkedDocument(ref: string): Promise<void> {
        await this.runRefMutation(ref, async () => {
            const entry = await this.ensureEntry(ref);
            if (!entry || entry.storageMode !== 'chunked') {
                return;
            }
            await this.clearExternalStorage(entry);
            entry.storageMode = 'inline';
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            delete entry.chunkGeneration;
            entry.data = new Uint8Array();
            entry.fileSize = 0;
            entry.updatedAt = Date.now();
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        });
    }

    public async touchRecentFile(ref: string) {
        await this.recentFilesStore.touchRecentFile(ref);
    }

    public getRecentFiles() {
        return this.recentFilesStore.getRecentFiles();
    }

    public async recoverRecentFilesIfStorageMissing() {
        return this.recentFilesStore.recoverRecentFilesIfStorageMissing();
    }

    public async removeRecentFile(ref: string) {
        await this.recentFilesStore.removeRecentFile(ref);
    }

    public async clearRecentFiles() {
        await this.recentFilesStore.clearRecentFiles();
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

    private isBrokenChunkedRecord(
        record: IBrowserPersistedDocumentRecord,
        chunkIndicesByRef: Map<string, Set<number>>,
    ) {
        return (
            record.storageMode === 'chunked'
            && record.fileSize > 0
            && (
                (record.chunkCount ?? 0) <= 0
                || isChunkedRecordMissingChunks(record, chunkIndicesByRef)
            )
        );
    }

    private async sweepPersistedOrphans(): Promise<void> {
        const records = await this.getAllPersistedRecords();
        if (records.length === 0) {
            return;
        }

        const currentRecentFiles = hasRecentFilesStorageSnapshot()
            ? readRecentFilesFromStorage()
            : buildRecentFilesFromPersistedRecords(records);
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
        const recentRefs = new Set<string>(recentFiles.map((file) => file.originalPath));
        const nonWorkingDependentCounts = countNonWorkingDependents(records);
        const pendingRefs = new Set(Array.from(this.entries.values())
            .filter((entry) => Boolean(entry.pendingLoad))
            .map((entry) => entry.ref));
        const refsToRemove = records
            .filter((record) => shouldRemovePersistedRecord(
                record,
                recentRefs,
                nonWorkingDependentCounts,
            ))
            .filter((record) => !pendingRefs.has(record.ref))
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
        const chunkIndicesByRef = collectChunkIndicesByRef(chunkKeys);
        const brokenChunkRefs = records
            .filter((record) => this.isBrokenChunkedRecord(record, chunkIndicesByRef))
            .filter((record) => !pendingRefs.has(record.ref))
            .map((record) => record.ref);
        const refsToRemoveSet = new Set([
            ...refsToRemove,
            ...brokenChunkRefs,
        ]);
        const chunkDeletes = chunkKeys
            .filter((chunkKey) => {
                const record = recordsByRef.get(chunkKey.ref);
                if (pendingRefs.has(chunkKey.ref)) {
                    return false;
                }
                if (!record || refsToRemoveSet.has(chunkKey.ref)) {
                    return true;
                }

                if (record.storageMode !== 'chunked') {
                    return true;
                }

                return (
                    chunkKey.generation !== (record.chunkGeneration ?? undefined)
                    || chunkKey.index >= (record.chunkCount ?? 0)
                );
            })
            .map((chunkKey) => deleteChunkRecord(chunkKey.ref, chunkKey.index, chunkKey.generation));

        if (refsToRemoveSet.size === 0 && chunkDeletes.length === 0) {
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
        const uniqueRefs = uniq(refs.filter(ref => ref.length > 0));
        if (uniqueRefs.length === 0) {
            return;
        }

        await Promise.allSettled(
            uniqueRefs.map(async (ref) => {
                await this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
            }),
        );
    }

    private runRefMutation<T>(
        ref: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = this.mutationQueues.get(ref) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(operation);
        const tracked = run.then(
            () => undefined,
            () => undefined,
        );
        this.mutationQueues.set(ref, tracked);
        void tracked.finally(() => {
            if (this.mutationQueues.get(ref) === tracked) {
                this.mutationQueues.delete(ref);
            }
        });
        return run;
    }

    private async consumeFileIntoEntry(
        entry: IBrowserDocumentEntry,
        file: File,
    ): Promise<void> {
        const pendingLoad = (async () => {
            if (entry.storageMode === 'chunked') {
                await this.resetChunkedEntry(entry, file.size, BROWSER_DOCUMENT_CHUNK_SIZE);

                let chunkIndex = 0;
                for (
                    let offset = 0;
                    offset < file.size;
                    offset += entry.chunkSize
                ) {
                    const chunk = new Uint8Array(
                        await file.slice(offset, offset + entry.chunkSize).arrayBuffer(),
                    );
                    await this.persistEntryChunk(entry, chunkIndex, chunk);
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
        try {
            await pendingLoad;
        } catch (error) {
            if (entry.pendingLoad === pendingLoad) {
                entry.pendingLoad = null;
            }
            if (entry.storageMode === 'chunked') {
                await this.deleteChunks(entry.ref, entry.chunkCount, entry.chunkGeneration)
                    .catch(() => undefined);
                await deleteRecord(entry.ref).catch(() => undefined);
            }
            throw error;
        }
    }

    private async consumeBytesIntoChunkedEntry(
        entry: IBrowserDocumentEntry,
        bytes: Uint8Array,
        options: { publishInitialRecord?: boolean } = {},
    ): Promise<void> {
        await this.resetChunkedEntry(entry, bytes.byteLength, Math.max(1, entry.chunkSize), options.publishInitialRecord);

        let chunkIndex = 0;
        for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += entry.chunkSize
        ) {
            const chunk = bytes.slice(offset, offset + entry.chunkSize);
            await this.persistEntryChunk(entry, chunkIndex, chunk);
            chunkIndex += 1;
            entry.chunkCount = chunkIndex;
            entry.updatedAt = Date.now();
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            if (chunkIndex % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                await yieldToBrowser();
            }
        }

        entry.chunkCount = chunkIndex;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    private async resetChunkedEntry(
        entry: IBrowserDocumentEntry,
        fileSize: number,
        chunkSize: number,
        publishInitialRecord = true,
    ) {
        entry.data = new Uint8Array();
        entry.chunkCount = 0;
        entry.chunkSize = chunkSize;
        entry.chunkGeneration = this.createChunkGeneration();
        entry.fileSize = fileSize;
        entry.updatedAt = Date.now();
        if (publishInitialRecord) {
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        }
    }

    private async persistEntryChunk(
        entry: IBrowserDocumentEntry,
        index: number,
        chunk: Uint8Array,
    ) {
        await persistChunkRecord({
            key: createChunkKey(entry.ref, index, entry.chunkGeneration),
            ref: entry.ref,
            index,
            ...(entry.chunkGeneration ? { generation: entry.chunkGeneration } : {}),
            data: cloneBytes(chunk),
        });
    }

    private async updateEntryFileSize(
        entry: IBrowserDocumentEntry,
        size: number,
    ) {
        if (entry.fileSize === size) {
            return;
        }

        entry.fileSize = size;
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
                await this.updateEntryFileSize(entry, size);
                return bytes;
            }
            case 'chunked': {
                if (entry.fileSize === 0 || entry.chunkCount === 0) {
                    return new Uint8Array();
                }
                const bytes = new Uint8Array(entry.fileSize);
                let writeOffset = 0;
                for (let index = 0; index < entry.chunkCount; index += 1) {
                    const chunk = await this.loadChunk(entry.ref, index, entry.chunkGeneration);
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
        const {
            start,
            rangeLength,
            end,
        } = normalizeReadRange(offset, length);

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
                await this.updateEntryFileSize(entry, size);
                return bytes;
            }
            case 'chunked': {
                return this.readChunkedEntryRange(entry, start, rangeLength, end);
            }
            case 'inline':
            default:
                return entry.data.slice(start, end);
        }
    }

    private async readChunkedEntryRange(
        entry: IBrowserDocumentEntry,
        start: number,
        rangeLength: number,
        end: number,
    ) {
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
            const chunk = await this.loadChunk(entry.ref, chunkIndex, entry.chunkGeneration);
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

    private async loadChunk(ref: string, index: number, generation?: string): Promise<Uint8Array | null> {
        const rawChunk = await loadChunkRecord(ref, index, generation);
        const normalizedChunk = toPersistedChunkRecord(rawChunk);
        return normalizedChunk ? cloneBytes(normalizedChunk.data) : null;
    }

    private async deleteChunks(ref: string, chunkCount: number, generation?: string) {
        if (chunkCount <= 0) {
            return;
        }
        await Promise.all(Array.from({ length: chunkCount }, async (_value, index) => {
            await deleteChunkRecord(ref, index, generation);
        }));
    }

    private async clearExternalStorage(entry: IBrowserDocumentEntry) {
        if (entry.storageMode === 'chunked' && entry.chunkCount > 0) {
            await this.deleteChunks(entry.ref, entry.chunkCount, entry.chunkGeneration);
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
            ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}),
            data: cloneData ? cloneBytes(data) : data,
            fileSize: entry.fileSize,
            updatedAt: entry.updatedAt,
            ...(entry.saveName ? { saveName: entry.saveName } : {}),
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle ?? null,
            storageMode: entry.storageMode,
            chunkCount: entry.chunkCount,
            chunkSize: entry.chunkSize,
            ...(entry.chunkGeneration ? { chunkGeneration: entry.chunkGeneration } : {}),
        };
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
