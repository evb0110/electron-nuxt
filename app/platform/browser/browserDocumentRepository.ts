import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import {
    cloneBytes,
    normalizePersistedWriteBytes,
    toUint8Array,
} from '@app/platform/browser/browserDocumentBytes';
import {
    createBrowserDocumentEntry,
    createPersistedBrowserDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import { createBrowserDocumentRef } from '@app/platform/browser/browserDocumentRefs';
import {
    defaultRetentionForKind,
    resolveByteBackedStorageMode,
    resolveStoredDocumentStorageMode,
} from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    ICreateStoredDocumentOptions,
    IRegisterFileOptions,
    IWriteDocumentOptions,
} from '@app/platform/browser/browserDocumentTypes';
import {
    deleteRecord,
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
} from '@app/platform/browser/browserDocumentChunkStorage';
import {
    createBrowserDocumentContentToken,
    updateBrowserDocumentEntryContentToken,
} from '@app/platform/browser/browserDocumentRevision';
import { emitBrowserDocumentPersistenceWarning } from '@app/platform/browser/browserDocumentPersistenceWarnings';
import { BrowserDocumentRecordStore } from '@app/platform/browser/browserDocumentRecordStore';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

export interface IBrowserDocumentMutation {
    write(
        data: Uint8Array | ArrayBuffer,
        options?: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'>,
    ): Promise<boolean>;
    replaceWorkingCopySource(
        sourceRef: string,
        saveName: string,
        saveHandle?: FileSystemFileHandle | null,
    ): Promise<void>;
}

export interface IBrowserDocumentSourceMutation extends IBrowserDocumentMutation { writeSource(data: Uint8Array | ArrayBuffer): Promise<boolean>; }

function createBrowserFileDocumentEntry(
    ref: string,
    file: File,
    options: IRegisterFileOptions = {},
): IBrowserDocumentEntry {
    const kind = options.kind ?? 'source';
    return {
        ref,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        kind,
        retention: options.retention ?? defaultRetentionForKind(kind),
        ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        data: new Uint8Array(),
        fileSize: file.size,
        updatedAt: Date.now(),
        contentToken: createBrowserDocumentContentToken(),
        pendingLoad: null,
        saveName: file.name,
        saveKind: options.saveKind ?? 'generic',
        saveHandle: options.saveHandle ?? null,
        storageMode: resolveByteBackedStorageMode(file.size),
        chunkCount: 0,
        chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
    };
}

function captureEntryStorageState(entry: IBrowserDocumentEntry) {
    return {
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
}

function restoreEntryStorageState(
    entry: IBrowserDocumentEntry,
    state: ReturnType<typeof captureEntryStorageState>,
) {
    entry.storageMode = state.storageMode;
    entry.chunkCount = state.chunkCount;
    entry.chunkSize = state.chunkSize;
    entry.fileSize = state.fileSize;
    entry.updatedAt = state.updatedAt;
    entry.data = state.data;
    if (state.chunkGeneration) {
        entry.chunkGeneration = state.chunkGeneration;
    } else {
        delete entry.chunkGeneration;
    }
    if (state.contentToken) {
        entry.contentToken = state.contentToken;
    } else {
        delete entry.contentToken;
    }
    if (state.contentRevision !== undefined) {
        entry.contentRevision = state.contentRevision;
    } else {
        delete entry.contentRevision;
    }
}

export class BrowserDocumentStore extends BrowserDocumentRecordStore {
    private readonly fileRefs = new WeakMap<File, string>();

    /**
     * Attaches a freshly built entry and persists it, rolling the attachment and
     * any staged chunk generation back when persistence fails. `stageChunkBytes`
     * is null for entries whose bytes live in the record itself.
     */
    private async persistNewEntry(
        entry: IBrowserDocumentEntry,
        stageChunkBytes: ((offset: number, length: number) => Promise<Uint8Array>) | null,
        stagedFileSize: number,
    ) {
        this.attachEntry(entry);
        let stagedGeneration: string | undefined;
        let stagedChunkCount = 0;
        try {
            if (stageChunkBytes) {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    stagedFileSize,
                    Math.max(1, entry.chunkSize),
                    stageChunkBytes,
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.data = new Uint8Array();
                entry.chunkGeneration = stagedLayout.generation;
                entry.chunkCount = stagedLayout.chunkCount;
                entry.fileSize = stagedFileSize;
                entry.updatedAt = Date.now();
            }
            await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
            stagedGeneration = undefined;
            stagedChunkCount = 0;
        } catch (error) {
            this.dropLoadedEntry(entry.ref);
            if (stagedGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                    .catch(() => undefined);
            }
            await deleteRecord(entry.ref).catch(() => undefined);
            throw error;
        }
        return entry.ref;
    }

    private async createStoredEntry(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ) {
        const sourceBytes = toUint8Array(data);
        const storageMode = resolveStoredDocumentStorageMode(sourceBytes.byteLength, options.storageMode);
        const bytes = storageMode === 'inline' ? cloneBytes(sourceBytes) : new Uint8Array();
        const kind = options.kind ?? 'source';
        const entry = createBrowserDocumentEntry({
            ref: createBrowserDocumentRef(fileName),
            fileName,
            mimeType: options.mimeType,
            kind,
            retention: options.retention ?? defaultRetentionForKind(kind),
            ...(options.sourceRef ? {sourceRef: options.sourceRef} : {}),
            data: bytes,
            fileSize: storageMode === 'chunked' ? sourceBytes.byteLength : bytes.byteLength,
            contentToken: createBrowserDocumentContentToken(),
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            storageMode,
            chunkCount: options.chunkCount ?? 0,
            chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        });

        return this.persistNewEntry(
            entry,
            storageMode === 'chunked' && sourceBytes.byteLength > 0
                ? (offset, length) => Promise.resolve(sourceBytes.slice(offset, offset + length))
                : null,
            sourceBytes.byteLength,
        );
    }

    public getRefForFile(file: File) {
        const existingRef = this.fileRefs.get(file);
        if (existingRef && this.hasLoadedEntry(existingRef)) {
            return existingRef;
        }

        const ref = createBrowserDocumentRef(file.name);
        const entry = createBrowserFileDocumentEntry(ref, file, {saveKind: /\.docx$/i.test(file.name) ? 'docx' : 'generic'});

        this.attachEntry(entry);
        this.fileRefs.set(file, ref);
        void this.consumeFileIntoEntry(entry, file)
            .catch(async (error: unknown) => {
                await this.retainFileInMemoryAfterPersistenceFailure(entry, file, error)
                    .catch(() => undefined);
            });
        return ref;
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        await this.ensureMaintenance();
        const ref = createBrowserDocumentRef(file.name);
        const entry = createBrowserFileDocumentEntry(ref, file, options);

        this.attachEntry(entry);
        this.fileRefs.set(file, ref);
        try {
            await this.consumeFileIntoEntry(entry, file);
        } catch (error) {
            await this.retainFileInMemoryAfterPersistenceFailure(entry, file, error);
        }
        return ref;
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ) {
        await this.ensureMaintenance();
        const create = () => this.createStoredEntry(fileName, data, options);
        const sourceRef = options.sourceRef;
        if (sourceRef) {
            return this.runRefMutation(sourceRef, async () => {
                await this.requireEntry(sourceRef);
                return create();
            });
        }
        return create();
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
        const nextSourceRef = options.sourceRef;
        if (nextSourceRef) {
            return this.runRefMutation(nextSourceRef, async () => {
                await this.requireEntry(nextSourceRef);
                return this.cloneStoredDocumentUnlocked(sourceRef, options);
            });
        }
        return this.cloneStoredDocumentUnlocked(sourceRef, options);
    }

    private async cloneStoredDocumentUnlocked(
        sourceRef: string,
        options: {
            fileName?: string;
            kind?: IBrowserDocumentEntry['kind'];
            retention?: IBrowserDocumentEntry['retention'];
            sourceRef?: string;
            saveKind?: IBrowserDocumentEntry['saveKind'];
            saveHandle?: FileSystemFileHandle | null;
        },
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

            return this.persistNewEntry(
                entry,
                (offset, length) => this.readEntryRange(sourceEntry, offset, length),
                sourceEntry.fileSize,
            );
        }

        const bytes = await this.readEntryBytes(sourceEntry);
        return this.createStoredEntry(nextName, bytes, {
            mimeType: sourceEntry.mimeType,
            kind: nextKind,
            retention: nextRetention,
            ...(nextSourceRef ? { sourceRef: nextSourceRef } : {}),
            saveKind: nextSaveKind,
            saveHandle: nextSaveHandle,
        });
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

    public runDocumentMutationWithSource<T>(
        ref: string,
        sourceRef: string,
        expectedRevision: TDocumentRevisionToken | null | undefined,
        operation: (mutation: IBrowserDocumentSourceMutation) => Promise<T>,
    ) {
        return this.runRefMutationMany([
            ref,
            sourceRef,
        ], async () => {
            if (await this.getSourceRef(ref) !== sourceRef) {
                throw new Error('Browser document source changed while the save target was being selected.');
            }
            await this.assertDocumentRevisionCurrent(ref, expectedRevision);
            return operation({
                write: (data, options = {}) => this.writeUnlocked(ref, data, options, true),
                replaceWorkingCopySource: (nextSourceRef, saveName, saveHandle) => (
                    this.replaceWorkingCopySourceUnlocked(ref, nextSourceRef, saveName, saveHandle)
                ),
                writeSource: data => this.writeUnlocked(sourceRef, data, {}, true),
            });
        });
    }

    private async writeUnlocked(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
        revisionAlreadyChecked = false,
    ) {
        if (!revisionAlreadyChecked && options.skipDocumentRevisionCheckForBootstrap !== true) {
            await this.assertDocumentRevisionCurrent(ref, options.expectedDocumentRevisionToken);
        }
        const entry = await this.requireEntry(ref);
        const bytes = options.unloadAfterPersist
            ? normalizePersistedWriteBytes(data, false)
            : normalizePersistedWriteBytes(data);
        const nextStorageMode = resolveByteBackedStorageMode(bytes.byteLength);
        const previousEntryState = captureEntryStorageState(entry);
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
                await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
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
                await persistRecord(createPersistedBrowserDocumentRecord(entry, bytes, false));
                entry.data = bytes;
                this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            }
            await deleteBrowserDocumentChunks(entry.ref, previousChunkCount, previousChunkGeneration)
                .catch(() => undefined);
        } catch (error) {
            restoreEntryStorageState(entry, previousEntryState);
            if (stagedGeneration && stagedGeneration !== previousChunkGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                    .catch(() => undefined);
            }
            throw error;
        }

        if (options.unloadAfterPersist) {
            this.dropLoadedEntry(ref);
            return true;
        }
        return true;
    }

    private async replaceWorkingCopySourceUnlocked(
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
        await persistRecord(createPersistedBrowserDocumentRecord(workingEntry, workingEntry.data, false));
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
        await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
    }

    public async setRetention(
        ref: string,
        retention: IBrowserDocumentEntry['retention'],
    ) {
        const entry = await this.requireEntry(ref);
        entry.retention = retention;
        await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
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
        const previousEntryState = captureEntryStorageState(entry);
        try {
            entry.storageMode = resolveByteBackedStorageMode(file.size);
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.fileSize = file.size;
            await this.consumeFileIntoEntry(entry, file, { deleteRecordOnFailure: false });
        } catch (error) {
            restoreEntryStorageState(entry, previousEntryState);
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
        await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
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
            const previousEntryState = captureEntryStorageState(entry);
            const previousFileName = entry.fileName;
            const previousSaveName = entry.saveName;
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
                await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            } catch (error) {
                restoreEntryStorageState(entry, previousEntryState);
                entry.fileName = previousFileName;
                if (previousSaveName) {
                    entry.saveName = previousSaveName;
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
            await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
            this.emitRevisionChangeForEntry(entry, previousToken, 'write');
        });
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
                await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
            } else {
                const bytes = new Uint8Array(await file.arrayBuffer());
                entry.data = bytes;
                entry.fileSize = bytes.byteLength;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
            }
            entry.memoryOnly = false;
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

    private async retainFileInMemoryAfterPersistenceFailure(
        entry: IBrowserDocumentEntry,
        file: File,
        error: unknown,
    ) {
        try {
            entry.data = new Uint8Array(await file.arrayBuffer());
        } catch {
            this.dropLoadedEntry(entry.ref, entry);
            throw error;
        }

        entry.storageMode = 'inline';
        entry.memoryOnly = true;
        entry.fileSize = entry.data.byteLength;
        entry.updatedAt = Date.now();
        entry.chunkCount = 0;
        entry.pendingLoad = null;
        delete entry.chunkGeneration;
        delete entry.pendingChunkGeneration;
        delete entry.pendingChunkCount;
        delete entry.pendingChunkSize;
        delete entry.pendingFileSize;
        emitBrowserDocumentPersistenceWarning({
            fileName: entry.fileName,
            error,
        });
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
