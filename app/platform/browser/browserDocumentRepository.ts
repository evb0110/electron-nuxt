import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
} from '@app/platform/browser/browserDocumentConstants';
import {
    cloneBytes,
    normalizePersistedWriteBytes,
    normalizeReadRange,
    toUint8Array,
} from '@app/platform/browser/browserDocumentBytes';
import {
    createBrowserDocumentEntry,
    createEntryFromPersistedRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import { createBrowserDocumentRef } from '@app/platform/browser/browserDocumentRefs';
import {
    buildBrowserDocumentFullReadError,
    defaultRetentionForKind,
    resolveByteBackedStorageMode,
    resolveStoredDocumentStorageMode,
    shouldInlineFileBytes,
} from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
    ICreateStoredDocumentOptions,
    IRegisterFileOptions,
    IWriteDocumentOptions,
} from '@app/platform/browser/browserDocumentTypes';
import {
    deleteRecord,
    loadRecord,
    persistRecord,
} from '@app/platform/browser/browserDocumentIdb';
import {
    assertBrowserDocumentChunkGenerationComplete,
    clearBrowserDocumentExternalChunkStorage,
    clearPendingBrowserDocumentChunkMetadata,
    clearPendingBrowserDocumentChunks,
    createBrowserDocumentChunkGeneration,
    deleteBrowserDocumentChunks,
    persistBrowserDocumentChunk,
    persistBrowserDocumentChunkGeneration,
    readBrowserDocumentChunkedEntryBytes,
    readBrowserDocumentChunkedEntryRange,
} from '@app/platform/browser/browserDocumentChunkStorage';
import {
    cleanupBrowserEvictedRecentRefs,
    isBrowserRecentFileRef,
    loadBrowserPersistedDocumentRecords,
    loadBrowserPersistedDocumentRecordsResult,
    sweepBrowserDocumentMaintenance,
} from '@app/platform/browser/browserDocumentMaintenance';
import {
    readFileHandleBytes,
    readFileHandleMetadata,
} from '@app/platform/browser/browserFileHandleBridge';
import {
    createBrowserDocumentContentToken,
    createBrowserDocumentRevisionInfo,
    getBrowserDocumentEntryContentRevision,
    updateBrowserDocumentEntryContentToken,
} from '@app/platform/browser/browserDocumentRevision';
import { BrowserRecentFilesStore } from '@app/platform/browser/browserRecentFilesStore';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';

export class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private readonly fileRefs = new WeakMap<File, string>();
    private readonly mutationQueues = new Map<string, Promise<void>>();
    private readonly revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
    private readonly recentFilesStore = new BrowserRecentFilesStore({
        requireEntry: (ref) => this.requireEntry(ref),
        getAllPersistedRecords: () => loadBrowserPersistedDocumentRecordsResult(),
        cleanupEvictedRecentRefs: (refs) => cleanupBrowserEvictedRecentRefs(
            refs,
            async (ref) => {
                await this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
            },
        ),
    });
    private maintenancePromise: Promise<void> | null = null;
    private maintenanceComplete = false;

    private emitDocumentRevisionChanged(event: IDocumentRevisionChangedEvent) {
        for (const listener of this.revisionListeners) {
            listener(event);
        }
    }

    private emitRevisionChangeForEntry(
        entry: IBrowserDocumentEntry,
        previousToken: TDocumentRevisionToken | undefined,
        reason: TDocumentRevisionChangeReason,
    ) {
        this.emitDocumentRevisionChanged({
            ...createBrowserDocumentRevisionInfo(entry),
            ...(previousToken ? { previousToken } : {}),
            reason,
        });
        for (const dependentEntry of this.entries.values()) {
            if (
                dependentEntry.ref !== entry.ref
                && dependentEntry.storageMode === 'source-proxy'
                && dependentEntry.sourceRef === entry.ref
            ) {
                this.emitDocumentRevisionChanged({
                    ...createBrowserDocumentRevisionInfo(entry, dependentEntry.ref),
                    ...(previousToken ? { previousToken } : {}),
                    reason,
                });
            }
        }
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
            contentToken: createBrowserDocumentContentToken(),
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
            contentToken: createBrowserDocumentContentToken(),
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
    ) {
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
            contentToken: createBrowserDocumentContentToken(),
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            storageMode,
            chunkCount: options.chunkCount ?? 0,
            chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        });

        this.entries.set(ref, entry);
        let stagedGeneration: string | undefined;
        let stagedChunkCount = 0;
        try {
            if (storageMode === 'chunked' && sourceBytes.byteLength > 0) {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    sourceBytes.byteLength,
                    Math.max(1, entry.chunkSize),
                    (offset, length) => Promise.resolve(sourceBytes.slice(offset, offset + length)),
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.data = new Uint8Array();
                entry.chunkGeneration = stagedLayout.generation;
                entry.chunkCount = stagedLayout.chunkCount;
                entry.fileSize = sourceBytes.byteLength;
                entry.updatedAt = Date.now();
            }
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            if (storageMode === 'chunked') {
                stagedGeneration = undefined;
                stagedChunkCount = 0;
            }
        } catch (error) {
            this.entries.delete(ref);
            if (stagedGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                    .catch(() => undefined);
            }
            await deleteRecord(ref).catch(() => undefined);
            throw error;
        }
        return ref;
    }

    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string) {
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
    ) {
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
                contentToken: createBrowserDocumentContentToken(),
                pendingLoad: null,
                saveName: nextName,
                saveKind: nextSaveKind,
                saveHandle: nextSaveHandle,
                storageMode: 'chunked',
                chunkCount: 0,
                chunkSize: sourceEntry.chunkSize,
            };

            this.entries.set(ref, entry);
            let stagedGeneration: string | undefined;
            let stagedChunkCount = 0;
            try {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    sourceEntry.fileSize,
                    Math.max(1, sourceEntry.chunkSize),
                    (offset, length) => this.readEntryRange(sourceEntry, offset, length),
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.chunkGeneration = stagedLayout.generation;
                entry.chunkCount = stagedLayout.chunkCount;
                entry.fileSize = sourceEntry.fileSize;
                entry.updatedAt = Date.now();
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                stagedGeneration = undefined;
                stagedChunkCount = 0;
            } catch (error) {
                this.entries.delete(ref);
                if (stagedGeneration) {
                    await deleteBrowserDocumentChunks(ref, stagedChunkCount, stagedGeneration)
                        .catch(() => undefined);
                }
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
            await this.refreshHandleBackedEntry(entry);
        }

        return { size: entry.fileSize };
    }

    public async getContentSignature(ref: string): Promise<string> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            return this.getContentSignature(entry.sourceRef);
        }

        if (entry.storageMode === 'handle' && entry.saveHandle) {
            await this.refreshHandleBackedEntry(entry);
        }

        return [
            entry.storageMode,
            entry.fileSize,
            entry.contentToken ?? 'legacy',
            entry.chunkGeneration ?? '',
            entry.chunkCount,
            entry.chunkSize,
        ].join(':');
    }

    public async getDocumentRevision(ref: string): Promise<IDocumentRevisionInfo> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            const sourceEntry = await this.requireEntry(entry.sourceRef);
            if (sourceEntry.storageMode === 'handle' && sourceEntry.saveHandle) {
                await this.refreshHandleBackedEntry(sourceEntry);
            }
            return createBrowserDocumentRevisionInfo(sourceEntry, ref);
        }

        if (entry.storageMode === 'handle' && entry.saveHandle) {
            await this.refreshHandleBackedEntry(entry);
        }

        return createBrowserDocumentRevisionInfo(entry);
    }

    public async assertDocumentRevisionCurrent(
        ref: string,
        expectedRevision: TDocumentRevisionToken | null | undefined,
    ) {
        const entry = await this.requireEntry(ref);
        if (!expectedRevision) {
            if (entry.kind === 'working') {
                throw createMissingRevisionError({documentRef: ref});
            }
            return;
        }
        const actualRevision = await this.getDocumentRevision(ref);
        if (actualRevision.token !== expectedRevision) {
            throw createStaleRevisionError({
                documentRef: ref,
                expectedRevision,
                actualRevision: actualRevision.token,
            });
        }
    }

    public onDocumentRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
        this.revisionListeners.add(listener);
        return () => {
            this.revisionListeners.delete(listener);
        };
    }

    public async write(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ) {
        return this.runRefMutation(ref, async () => this.writeUnlocked(ref, data, options));
    }

    public async writeForBootstrap(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        reason: string,
        options: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'> = {},
    ) {
        if (reason.trim().length === 0) {
            throw new TypeError('bootstrap write reason must be a non-empty string');
        }
        return this.runRefMutation(ref, async () => this.writeUnlocked(ref, data, {
            ...options,
            skipDocumentRevisionCheckForBootstrap: true,
        }));
    }

    private async writeUnlocked(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ) {
        if (options.skipDocumentRevisionCheckForBootstrap !== true) {
            await this.assertDocumentRevisionCurrent(ref, options.expectedDocumentRevisionToken);
        }
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
            contentToken: entry.contentToken,
            contentRevision: entry.contentRevision,
            data: entry.data,
        };
        const previousChunkGeneration = entry.chunkGeneration;
        const previousChunkCount = entry.storageMode === 'chunked' ? entry.chunkCount : 0;
        let stagedGeneration: string | undefined;
        let stagedChunkCount = 0;

        try {
            if (nextStorageMode === 'chunked') {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    bytes.byteLength,
                    BROWSER_DOCUMENT_CHUNK_SIZE,
                    (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.storageMode = 'chunked';
                entry.data = new Uint8Array();
                entry.chunkCount = stagedLayout.chunkCount;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.chunkGeneration = stagedLayout.generation;
                entry.fileSize = bytes.byteLength;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'write');
                stagedGeneration = undefined;
                stagedChunkCount = 0;
            } else {
                entry.storageMode = nextStorageMode;
                entry.chunkCount = 0;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.fileSize = bytes.byteLength;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                delete entry.chunkGeneration;
                await persistRecord(this.toPersistedRecord(entry, bytes, false));
                entry.data = bytes;
                this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            }
            await deleteBrowserDocumentChunks(entry.ref, previousChunkCount, previousChunkGeneration)
                .catch(() => undefined);
        } catch (error) {
            entry.storageMode = previousEntryState.storageMode;
            entry.chunkCount = previousEntryState.chunkCount;
            entry.chunkSize = previousEntryState.chunkSize;
            entry.fileSize = previousEntryState.fileSize;
            entry.updatedAt = previousEntryState.updatedAt;
            if (previousEntryState.contentToken) {
                entry.contentToken = previousEntryState.contentToken;
            } else {
                delete entry.contentToken;
            }
            if (previousEntryState.contentRevision !== undefined) {
                entry.contentRevision = previousEntryState.contentRevision;
            } else {
                delete entry.contentRevision;
            }
            entry.data = previousEntryState.data;
            if (previousEntryState.chunkGeneration) {
                entry.chunkGeneration = previousEntryState.chunkGeneration;
            } else {
                delete entry.chunkGeneration;
            }
            if (stagedGeneration && stagedGeneration !== previousChunkGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
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

    public async readText(ref: string) {
        const bytes = await this.read(ref);
        return new TextDecoder().decode(bytes);
    }

    public async exists(ref: string) {
        return (await this.ensureEntry(ref)) !== null;
    }

    public async remove(ref: string) {
        await this.runRefMutation(ref, async () => {
            await this.ensureMaintenance();
            const entry = await this.ensureEntry(ref);
            if (entry) {
                await clearPendingBrowserDocumentChunks(entry);
                await clearBrowserDocumentExternalChunkStorage(entry);
            }
            this.entries.delete(ref);
            await deleteRecord(ref);
            await this.removeRecentFile(ref);
        });
    }

    public unload(ref: string) {
        this.entries.delete(ref);
    }

    public async cleanupDetachedDocument(ref: string) {
        return this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
    }

    private async cleanupDetachedPersistedRecord(
        ref: string,
        options?: { allowDurable?: boolean },
    ) {
        await this.ensureMaintenance();
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            return false;
        }

        if (entry.kind === 'working') {
            await this.remove(ref);
            return true;
        }

        if (isBrowserRecentFileRef(ref)) {
            return false;
        }

        const records = await loadBrowserPersistedDocumentRecords();
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
    ) {
        const previousRevision = await this.getDocumentRevision(workingRef);
        const workingEntry = await this.requireEntry(workingRef);
        workingEntry.sourceRef = sourceRef;
        workingEntry.saveName = saveName;
        workingEntry.saveHandle = saveHandle ?? null;
        if (workingEntry.storageMode === 'handle') {
            workingEntry.storageMode = 'source-proxy';
            workingEntry.data = new Uint8Array();
        }
        await persistRecord(this.toPersistedRecord(workingEntry, workingEntry.data, false));
        const nextRevision = await this.getDocumentRevision(workingRef);
        if (nextRevision.token !== previousRevision.token) {
            this.emitDocumentRevisionChanged({
                ...nextRevision,
                previousToken: previousRevision.token,
                reason: 'replace-working-copy',
            });
        }
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
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async setRetention(
        ref: string,
        retention: IBrowserDocumentEntry['retention'],
    ) {
        const entry = await this.requireEntry(ref);
        entry.retention = retention;
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
    }

    public async getSourceRef(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.sourceRef ?? ref;
    }

    public async ensureByteBackedSource(ref: string) {
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
        const previousEntryState = {
            storageMode: entry.storageMode,
            chunkCount: entry.chunkCount,
            chunkSize: entry.chunkSize,
            chunkGeneration: entry.chunkGeneration,
            fileSize: entry.fileSize,
            updatedAt: entry.updatedAt,
            contentToken: entry.contentToken,
            contentRevision: entry.contentRevision,
            data: entry.data,
        };
        try {
            entry.storageMode = resolveByteBackedStorageMode(file.size);
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.fileSize = file.size;
            await this.consumeFileIntoEntry(entry, file, { deleteRecordOnFailure: false });
        } catch (error) {
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
            if (previousEntryState.contentToken) {
                entry.contentToken = previousEntryState.contentToken;
            } else {
                delete entry.contentToken;
            }
            if (previousEntryState.contentRevision !== undefined) {
                entry.contentRevision = previousEntryState.contentRevision;
            } else {
                delete entry.contentRevision;
            }
            throw error;
        }
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
    ) {
        const entry = await this.requireEntry(ref);
        await clearBrowserDocumentExternalChunkStorage(entry);
        entry.data = new Uint8Array();
        entry.storageMode = 'handle';
        entry.chunkCount = 0;
        entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
        entry.fileSize = options.fileSize;
        entry.updatedAt = Date.now();
        const previousToken = updateBrowserDocumentEntryContentToken(entry);
        if (options.saveHandle !== undefined) {
            entry.saveHandle = options.saveHandle;
        }
        if (options.saveName) {
            entry.saveName = options.saveName;
            entry.fileName = options.saveName;
        }
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        this.emitRevisionChangeForEntry(entry, previousToken, 'replace-working-copy');
    }

    public async prepareChunkedDocument(
        ref: string,
        options?: { chunkSize?: number },
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            await clearPendingBrowserDocumentChunks(entry);
            entry.pendingChunkGeneration = createBrowserDocumentChunkGeneration();
            entry.pendingChunkCount = 0;
            entry.pendingChunkSize = options?.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.pendingFileSize = 0;
        });
    }

    public async writeChunk(
        ref: string,
        index: number,
        data: Uint8Array,
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            if (!entry.pendingChunkGeneration) {
                entry.pendingChunkGeneration = createBrowserDocumentChunkGeneration();
                entry.pendingChunkCount = 0;
                entry.pendingChunkSize = entry.pendingChunkSize ?? entry.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.pendingFileSize = 0;
            }
            const generation = entry.pendingChunkGeneration;
            await persistBrowserDocumentChunk(ref, index, generation, data);
            entry.pendingChunkCount = Math.max(entry.pendingChunkCount ?? 0, index + 1);
            entry.pendingFileSize = Math.max(
                entry.pendingFileSize ?? 0,
                (index * Math.max(1, entry.pendingChunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE)) + data.byteLength,
            );
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
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            const stagedGeneration = entry.pendingChunkGeneration;
            if (!stagedGeneration) {
                throw new Error(`No staged browser document chunks available: ${ref}`);
            }
            const chunkSize = options.chunkSize ?? entry.pendingChunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            await assertBrowserDocumentChunkGenerationComplete(
                ref,
                stagedGeneration,
                options.chunkCount,
            );
            const previousEntryState = {
                storageMode: entry.storageMode,
                chunkCount: entry.chunkCount,
                chunkSize: entry.chunkSize,
                chunkGeneration: entry.chunkGeneration,
                fileSize: entry.fileSize,
                updatedAt: entry.updatedAt,
                contentToken: entry.contentToken,
                contentRevision: entry.contentRevision,
                data: entry.data,
                fileName: entry.fileName,
                saveName: entry.saveName,
            };
            const previousChunkCount = entry.storageMode === 'chunked' ? entry.chunkCount : 0;
            const previousChunkGeneration = entry.chunkGeneration;
            entry.data = new Uint8Array();
            entry.storageMode = 'chunked';
            entry.chunkCount = options.chunkCount;
            entry.chunkSize = chunkSize;
            entry.chunkGeneration = stagedGeneration;
            entry.fileSize = options.fileSize;
            entry.updatedAt = Date.now();
            const previousToken = updateBrowserDocumentEntryContentToken(entry);
            if (options.saveName) {
                entry.saveName = options.saveName;
                entry.fileName = options.saveName;
            }
            try {
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            } catch (error) {
                entry.storageMode = previousEntryState.storageMode;
                entry.chunkCount = previousEntryState.chunkCount;
                entry.chunkSize = previousEntryState.chunkSize;
                entry.fileSize = previousEntryState.fileSize;
                entry.updatedAt = previousEntryState.updatedAt;
                if (previousEntryState.chunkGeneration) {
                    entry.chunkGeneration = previousEntryState.chunkGeneration;
                } else {
                    delete entry.chunkGeneration;
                }
                if (previousEntryState.contentToken) {
                    entry.contentToken = previousEntryState.contentToken;
                } else {
                    delete entry.contentToken;
                }
                if (previousEntryState.contentRevision !== undefined) {
                    entry.contentRevision = previousEntryState.contentRevision;
                } else {
                    delete entry.contentRevision;
                }
                entry.data = previousEntryState.data;
                entry.fileName = previousEntryState.fileName;
                if (previousEntryState.saveName) {
                    entry.saveName = previousEntryState.saveName;
                } else {
                    delete entry.saveName;
                }
                throw error;
            }
            const extraPendingChunks = Math.max(0, (entry.pendingChunkCount ?? 0) - options.chunkCount);
            if (extraPendingChunks > 0) {
                await deleteBrowserDocumentChunks(
                    ref,
                    extraPendingChunks,
                    stagedGeneration,
                    options.chunkCount,
                ).catch(() => undefined);
            }
            clearPendingBrowserDocumentChunkMetadata(entry);
            await deleteBrowserDocumentChunks(ref, previousChunkCount, previousChunkGeneration)
                .catch(() => undefined);
        });
    }

    public async clearChunkedDocument(ref: string) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.ensureEntry(ref);
            if (!entry) {
                return;
            }
            if (entry.pendingChunkGeneration) {
                await clearPendingBrowserDocumentChunks(entry);
                return;
            }
            if (entry.storageMode !== 'chunked') {
                return;
            }
            await clearBrowserDocumentExternalChunkStorage(entry);
            entry.storageMode = 'inline';
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            delete entry.chunkGeneration;
            entry.data = new Uint8Array();
            entry.fileSize = 0;
            entry.updatedAt = Date.now();
            const previousToken = updateBrowserDocumentEntryContentToken(entry);
            await persistRecord(this.toPersistedRecord(entry, entry.data, false));
            this.emitRevisionChangeForEntry(entry, previousToken, 'write');
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

    private async ensureMaintenance() {
        if (this.maintenanceComplete) {
            return;
        }

        this.maintenancePromise ??= sweepBrowserDocumentMaintenance(this.entries)
            .finally(() => {
                this.maintenancePromise = null;
                this.maintenanceComplete = true;
            });

        await this.maintenancePromise;
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
        options: { deleteRecordOnFailure?: boolean } = {},
    ) {
        const pendingLoad = (async () => {
            if (entry.storageMode === 'chunked') {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    file.size,
                    BROWSER_DOCUMENT_CHUNK_SIZE,
                    async (offset, length) => new Uint8Array(
                        await file.slice(offset, offset + length).arrayBuffer(),
                    ),
                );
                entry.data = new Uint8Array();
                entry.chunkCount = stagedLayout.chunkCount;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.chunkGeneration = stagedLayout.generation;
                entry.fileSize = file.size;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
            } else {
                const bytes = new Uint8Array(await file.arrayBuffer());
                entry.data = bytes;
                entry.fileSize = bytes.byteLength;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                await persistRecord(this.toPersistedRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
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
                await clearPendingBrowserDocumentChunks(entry)
                    .catch(() => undefined);
                if (options.deleteRecordOnFailure !== false) {
                    await deleteRecord(entry.ref).catch(() => undefined);
                }
            }
            throw error;
        }
    }

    private async refreshHandleBackedEntry(
        entry: IBrowserDocumentEntry,
        metadata?: {
            size: number;
            lastModified: number;
        },
    ) {
        if (!entry.saveHandle && !metadata) {
            return;
        }

        const saveHandle = entry.saveHandle;
        const resolvedMetadata = metadata ?? (saveHandle
            ? await readFileHandleMetadata(saveHandle)
            : null);
        if (!resolvedMetadata) {
            return;
        }
        const contentToken = `handle:${resolvedMetadata.size}:${resolvedMetadata.lastModified}`;
        if (
            entry.fileSize === resolvedMetadata.size
            && entry.contentToken === contentToken
        ) {
            return;
        }

        const previousToken = createBrowserDocumentRevisionInfo(entry).token;
        entry.fileSize = resolvedMetadata.size;
        entry.updatedAt = Date.now();
        entry.contentToken = contentToken;
        entry.contentRevision = getBrowserDocumentEntryContentRevision(entry) + 1;
        await persistRecord(this.toPersistedRecord(entry, entry.data, false));
        this.emitRevisionChangeForEntry(entry, previousToken, 'browser-handle-refresh');
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
                    lastModified,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle);
                await this.refreshHandleBackedEntry(entry, {
                    size,
                    lastModified,
                });
                return bytes;
            }
            case 'chunked': {
                return readBrowserDocumentChunkedEntryBytes(entry);
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
                    lastModified,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle, start, rangeLength);
                await this.refreshHandleBackedEntry(entry, {
                    size,
                    lastModified,
                });
                return bytes;
            }
            case 'chunked': {
                return readBrowserDocumentChunkedEntryRange(entry, start, rangeLength, end);
            }
            case 'inline':
            default:
                return entry.data.slice(start, end);
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
            ...(entry.contentToken ? { contentToken: entry.contentToken } : {}),
            contentRevision: getBrowserDocumentEntryContentRevision(entry),
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
