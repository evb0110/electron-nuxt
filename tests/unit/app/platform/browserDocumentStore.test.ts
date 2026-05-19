import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES,
    BROWSER_MAX_FULL_READ_BYTES,
    BrowserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {
    FakeIndexedDbFactory,
    MemoryStorage,
    cast,
} from './browserPlatformTestDoubles';

describe('BrowserDocumentStore', () => {
    let indexedDbFactory: FakeIndexedDbFactory;
    let localStorage: MemoryStorage;

    beforeEach(() => {
        vi.unstubAllGlobals();
        indexedDbFactory = new FakeIndexedDbFactory();
        localStorage = new MemoryStorage();
        vi.stubGlobal('indexedDB', indexedDbFactory);
        vi.stubGlobal('window', {localStorage});
        vi.stubGlobal('document', {cookie: ''});
    });

    it('rehydrates persisted save targets with the original file handle', async () => {
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'saved-report.pdf',
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );

        await store.assignSaveTarget(ref, 'saved-report.pdf', 'pdf', handle);
        await store.touchRecentFile(ref);

        const rehydratedStore = new BrowserDocumentStore();
        await expect(rehydratedStore.getSaveTarget(ref)).resolves.toEqual({
            saveName: 'saved-report.pdf',
            saveKind: 'pdf',
            saveHandle: handle,
        });
    });

    it('uses the latest save name when refreshing recent files', async () => {
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'saved-report.pdf',
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );

        await store.assignSaveTarget(ref, 'saved-report.pdf', 'pdf', handle);
        await store.touchRecentFile(ref);

        expect(store.getRecentFiles()).toEqual([expect.objectContaining({
            originalPath: ref,
            fileName: 'saved-report.pdf',
        })]);
    });

    it('dedupes stored recent files by original path', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        localStorage.setItem('evb-viewer:browser:recentFiles', JSON.stringify([
            {
                originalPath: ref,
                fileName: 'report-new.pdf',
                timestamp: 3,
                fileSize: 1,
            },
            {
                originalPath: ref,
                fileName: 'report-old.pdf',
                timestamp: 1,
                fileSize: 1,
            },
        ]));

        expect(store.getRecentFiles()).toEqual([expect.objectContaining({
            originalPath: ref,
            fileName: 'report-new.pdf',
        })]);
    });

    it('rehydrates persisted bytes after unloading in-memory data', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            new Uint8Array([
                4,
                5,
                6,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(new Uint8Array([
            4,
            5,
            6,
        ]));
    });

    it('rehydrates persisted bytes after write with unloadAfterPersist', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            new Uint8Array([
                1,
                1,
                1,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        await store.write(ref, new Uint8Array([
            7,
            8,
            9,
        ]), { unloadAfterPersist: true });

        await expect(store.read(ref)).resolves.toEqual(new Uint8Array([
            7,
            8,
            9,
        ]));
    });

    it('rejects document creation when durable IndexedDB writes cannot commit', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const store = new BrowserDocumentStore();

        await expect(store.createStoredDocument(
            'failed.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        )).rejects.toThrow('IndexedDB document write did not commit');

        expect(store.getRecentFiles()).toEqual([]);
    });

    it('sweeps stale working copies and detached records on the next session', async () => {
        const store = new BrowserDocumentStore();
        const recentSourceRef = await store.createStoredDocument(
            'recent.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        await store.touchRecentFile(recentSourceRef);
        const staleWorkingRef = await store.cloneAsWorkingCopy(recentSourceRef);
        const orphanSourceRef = await store.createStoredDocument(
            'orphan.pdf',
            new Uint8Array([2]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        const orphanOutputRef = await store.createStoredDocument(
            'orphan-output.pdf',
            new Uint8Array([3]),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(recentSourceRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(staleWorkingRef)).resolves.toBe(false);
        await expect(rehydratedStore.exists(orphanSourceRef)).resolves.toBe(false);
        await expect(rehydratedStore.exists(orphanOutputRef)).resolves.toBe(false);
    });

    it('sweeps durable non-recent source blobs on the next session', async () => {
        const store = new BrowserDocumentStore();
        const recentSourceRef = await store.createStoredDocument(
            'recent.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const staleDurableRef = await store.createStoredDocument(
            'stale.pdf',
            new Uint8Array([2]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        await store.touchRecentFile(recentSourceRef);

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(recentSourceRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(staleDurableRef)).resolves.toBe(false);
    });

    it('recovers recent files from durable persisted documents when browser recent storage is missing', async () => {
        const store = new BrowserDocumentStore();
        const firstRef = await store.createStoredDocument(
            'first.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const secondRef = await store.createStoredDocument(
            'second.pdf',
            new Uint8Array([2]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        await store.touchRecentFile(firstRef);
        await store.touchRecentFile(secondRef);
        localStorage.clear();

        const rehydratedStore = new BrowserDocumentStore();
        const recoveredFiles = await rehydratedStore.recoverRecentFilesIfStorageMissing();

        expect(recoveredFiles.map(file => file.originalPath).sort()).toEqual([
            firstRef,
            secondRef,
        ].sort());
        await expect(rehydratedStore.exists(firstRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(secondRef)).resolves.toBe(true);
    });

    it('does not recover persisted documents after recent files are intentionally cleared', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'cleared.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        await store.touchRecentFile(ref);
        await store.clearRecentFiles();

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.recoverRecentFilesIfStorageMissing()).resolves.toEqual([]);
        await expect(rehydratedStore.exists(ref)).resolves.toBe(false);
    });

    it('evicts old recent blobs once the persisted recent-file budget is exceeded', async () => {
        const firstHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'first.pdf',
        });
        const secondHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'second.pdf',
        });
        const thirdHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'third.pdf',
        });
        const fileSize = Math.floor(BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES / 2) + 1;
        const store = new BrowserDocumentStore();

        const firstRef = await store.createStoredDocument(
            'first.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: firstHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(firstRef, {
            fileSize,
            saveHandle: firstHandle,
            saveName: 'first.pdf',
        });
        await store.touchRecentFile(firstRef);

        const secondRef = await store.createStoredDocument(
            'second.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: secondHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(secondRef, {
            fileSize,
            saveHandle: secondHandle,
            saveName: 'second.pdf',
        });
        await store.touchRecentFile(secondRef);

        const thirdRef = await store.createStoredDocument(
            'third.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: thirdHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(thirdRef, {
            fileSize,
            saveHandle: thirdHandle,
            saveName: 'third.pdf',
        });
        await store.touchRecentFile(thirdRef);

        expect(store.getRecentFiles().map((file) => file.originalPath)).toEqual([thirdRef]);
        await expect(store.exists(firstRef)).resolves.toBe(false);
        await expect(store.exists(secondRef)).resolves.toBe(false);
        await expect(store.exists(thirdRef)).resolves.toBe(true);
    });

    it('removes a detached generated source after its working copy is cleaned up', async () => {
        const store = new BrowserDocumentStore();
        const generatedSourceRef = await store.createStoredDocument(
            'generated.pdf',
            new Uint8Array([
                4,
                5,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        const workingRef = await store.cloneAsWorkingCopy(generatedSourceRef);

        await store.remove(workingRef);
        await expect(store.cleanupDetachedDocument(generatedSourceRef)).resolves.toBe(true);
        await expect(store.exists(generatedSourceRef)).resolves.toBe(false);
    });

    it('removes a durable source after it falls out of recents and loses its working copy', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'saved.pdf',
            new Uint8Array([
                7,
                8,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);

        await store.touchRecentFile(sourceRef);
        await store.removeRecentFile(sourceRef);
        await store.remove(workingRef);

        await expect(store.cleanupDetachedDocument(sourceRef)).resolves.toBe(true);
        await expect(store.exists(sourceRef)).resolves.toBe(false);
    });

    it('keeps a source while a working copy still depends on it', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'source.pdf',
            new Uint8Array([9]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        await store.cloneAsWorkingCopy(sourceRef);

        await expect(store.cleanupDetachedDocument(sourceRef)).resolves.toBe(false);
        await expect(store.exists(sourceRef)).resolves.toBe(true);
    });

    it('serves range reads through source-proxy working copies', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'large.pdf',
            new Uint8Array([
                1,
                2,
                3,
                4,
                5,
                6,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);

        await expect(store.readRange(workingRef, 2, 3)).resolves.toEqual(new Uint8Array([
            3,
            4,
            5,
        ]));
        await expect(store.stat(workingRef)).resolves.toEqual({ size: 6 });
    });

    it('persists chunked documents and supports range reads without inline bytes', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'chunked.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, new Uint8Array([
            1,
            2,
            3,
            4,
        ]));
        await store.writeChunk(ref, 1, new Uint8Array([
            5,
            6,
            7,
        ]));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 7,
            chunkCount: 2,
            chunkSize: 4,
        });

        await expect(store.readRange(ref, 3, 3)).resolves.toEqual(new Uint8Array([
            4,
            5,
            6,
        ]));
        await expect(store.read(ref)).resolves.toEqual(new Uint8Array([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
        ]));
    });

    it('clones chunked documents without materializing them into inline storage', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'chunked.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, new Uint8Array([
            1,
            2,
            3,
            4,
        ]));
        await store.writeChunk(ref, 1, new Uint8Array([
            5,
            6,
            7,
            8,
        ]));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 8,
            chunkCount: 2,
            chunkSize: 4,
        });

        const cloneRef = await store.cloneStoredDocument(ref, {
            fileName: 'clone.pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        });
        const cloneEntry = await store.requireEntry(cloneRef);

        expect(cloneEntry.storageMode).toBe('chunked');
        expect(cloneEntry.chunkCount).toBe(2);
        await expect(store.readRange(cloneRef, 2, 4)).resolves.toEqual(new Uint8Array([
            3,
            4,
            5,
            6,
        ]));
    });

    it('reads handle-backed documents lazily', async () => {
        const bytes = new Uint8Array([
            9,
            8,
            7,
            6,
            5,
        ]);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'lazy.pdf',
            getFile: vi.fn(async () => new File([bytes], 'lazy.pdf', { type: 'application/pdf' })),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'lazy.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await store.replaceWithHandleBackedDocument(ref, {
            fileSize: bytes.byteLength,
            saveHandle: handle,
            saveName: 'lazy.pdf',
        });

        await expect(store.readRange(ref, 1, 3)).resolves.toEqual(new Uint8Array([
            8,
            7,
            6,
        ]));
        await expect(store.stat(ref)).resolves.toEqual({ size: 5 });
    });

    it('mirrors picked source bytes even when a save handle is present', async () => {
        const bytes = new Uint8Array([
            3,
            1,
            4,
        ]);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'picked.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const file = new File([bytes], 'picked.pdf', { type: 'application/pdf' });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
        expect(handle.getFile).not.toHaveBeenCalled();
    });

    it('keeps source bytes readable after save-handle-backed source creation', async () => {
        const bytes = new Uint8Array([
            6,
            2,
            5,
        ]);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'saved.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'saved.pdf',
            bytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
        expect(handle.getFile).not.toHaveBeenCalled();
    });

    it('hydrates legacy handle-backed sources before reopening them', async () => {
        const bytes = new Uint8Array([
            8,
            9,
            7,
        ]);
        const getFile = vi.fn(async () => new File([bytes], 'legacy.pdf', { type: 'application/pdf' }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'legacy.pdf',
            getFile,
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'legacy.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await store.ensureByteBackedSource(ref);
        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        getFile.mockImplementation(async () => {
            throw new DOMException('Not allowed', 'NotAllowedError');
        });
        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
    });

    it('stores large file-only sources as chunked records', async () => {
        const bytes = new Uint8Array((16 * 1024 * 1024) + 1);
        bytes[0] = 4;
        bytes[bytes.byteLength - 1] = 9;
        const file = new File([bytes], 'large.pdf', { type: 'application/pdf' });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
        });

        const entry = await store.requireEntry(ref);

        expect(entry.storageMode).toBe('chunked');
        expect(entry.data.byteLength).toBe(0);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(new Uint8Array([4]));
        await expect(store.readRange(ref, bytes.byteLength - 1, 1)).resolves.toEqual(new Uint8Array([9]));
    });

    it('keeps large writes chunked instead of collapsing back to inline storage', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'rewrite.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );
        const largeBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        largeBytes[0] = 3;
        largeBytes[largeBytes.byteLength - 1] = 7;

        await store.write(ref, largeBytes);

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('chunked');
        expect(entry.data.byteLength).toBe(0);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(new Uint8Array([3]));
        await expect(store.readRange(ref, largeBytes.byteLength - 1, 1)).resolves.toEqual(new Uint8Array([7]));
    });

    it('replaces chunk generations after a large rewrite and removes superseded chunks', async () => {
        const store = new BrowserDocumentStore();
        const firstBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        firstBytes[0] = 1;
        firstBytes[firstBytes.byteLength - 1] = 2;
        const ref = await store.createStoredDocument('rewrite-generations.pdf', firstBytes, {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const firstChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);

        const secondBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        secondBytes[0] = 3;
        secondBytes[secondBytes.byteLength - 1] = 4;
        await store.write(ref, secondBytes);

        const secondChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);
        expect(secondChunkKeys).not.toEqual(firstChunkKeys);
        expect(secondChunkKeys.some(key => firstChunkKeys.includes(key))).toBe(false);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(new Uint8Array([3]));
        await expect(store.readRange(ref, secondBytes.byteLength - 1, 1)).resolves.toEqual(new Uint8Array([4]));
    });

    it('rejects full reads for browser documents above the in-memory safety limit', async () => {
        const bytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        bytes[0] = 5;
        bytes[bytes.byteLength - 1] = 8;
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'huge.pdf',
            bytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        await expect(store.read(ref)).rejects.toThrow('Browser document is too large to load fully into memory');
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(new Uint8Array([5]));
        await expect(store.readRange(ref, bytes.byteLength - 1, 1)).resolves.toEqual(new Uint8Array([8]));
    });

    it('clears partial chunk records when chunked output is aborted', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'partial.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, new Uint8Array([
            1,
            2,
            3,
            4,
        ]));
        await store.clearChunkedDocument(ref);

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        expect(database?.getStoreRecords('document-chunks').size ?? 0).toBe(0);
        await expect(store.read(ref)).resolves.toEqual(new Uint8Array());
    });

    it('sweeps corrupt recent chunked documents with positive size and no chunk records', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'corrupt.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        await store.touchRecentFile(ref);

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const documents = database?.getStoreRecords('documents');
        const record = documents?.get(ref);
        expect(record).toBeTruthy();
        documents?.set(ref, {
            ...(record as Record<string, unknown>),
            data: new Uint8Array(),
            storageMode: 'chunked',
            fileSize: 8,
            chunkCount: 0,
            chunkSize: 4,
        });

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(ref)).resolves.toBe(false);
        expect(rehydratedStore.getRecentFiles()).toEqual([]);
    });
});
