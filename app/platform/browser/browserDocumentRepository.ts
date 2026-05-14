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
    private readonly recentFilesStore = new BrowserRecentFilesStore({
        requireEntry: (ref) => this.requireEntry(ref),
        getAllPersistedRecords: () => this.getAllPersistedRecords(),
        cleanupEvictedRecentRefs: (refs) => this.cleanupEvictedRecentRefs(refs),
    });
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
        const recentRefs = new Set(recentFiles.map((file) => file.originalPath));
        const nonWorkingDependentCounts = countNonWorkingDependents(records);
        const refsToRemove = records
            .filter((record) => shouldRemovePersistedRecord(
                record,
                recentRefs,
                nonWorkingDependentCounts,
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
        const chunkIndicesByRef = collectChunkIndicesByRef(chunkKeys);
        const brokenChunkRefs = records
            .filter((record) => isChunkedRecordMissingChunks(record, chunkIndicesByRef))
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
        await pendingLoad;
    }

    private async consumeBytesIntoChunkedEntry(
        entry: IBrowserDocumentEntry,
        bytes: Uint8Array,
    ): Promise<void> {
        await this.resetChunkedEntry(entry, bytes.byteLength, Math.max(1, entry.chunkSize));

        let chunkIndex = 0;
        for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += entry.chunkSize
        ) {
            const chunk = bytes.slice(offset, offset + entry.chunkSize);
            await this.persistEntryChunk(entry, chunkIndex, chunk);
            chunkIndex += 1;
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
    ) {
        entry.data = new Uint8Array();
        entry.chunkCount = 0;
        entry.chunkSize = chunkSize;
        entry.fileSize = fileSize;
        entry.updatedAt = Date.now();
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    private async persistEntryChunk(
        entry: IBrowserDocumentEntry,
        index: number,
        chunk: Uint8Array,
    ) {
        await persistChunkRecord({
            key: createChunkKey(entry.ref, index),
            ref: entry.ref,
            index,
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
        };
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
