import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    BrowserDocumentStore,
} from '@app/platform/browser-document-store';

function cast<T>(value: unknown): T {
    return value as T;
}

class MemoryStorage {
    private readonly data = new Map<string, string>();

    public getItem(key: string) {
        return this.data.get(key) ?? null;
    }

    public setItem(key: string, value: string) {
        this.data.set(key, value);
    }
}

class FakeIdbRequest<T> {
    public result!: T;
    public onsuccess: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onupgradeneeded: ((event: Event) => void) | null = null;
    public onblocked: ((event: Event) => void) | null = null;
}

class FakeObjectStore {
    public constructor(
        private readonly records: Map<string, unknown>,
        private readonly keyPath: string,
    ) {}

    public put(record: Record<string, unknown>) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.records.set(String(record[this.keyPath]), record);
            request.result = record;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public get(ref: string) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.records.get(ref);
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public delete(ref: string) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.records.delete(ref);
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public getAll() {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.records.values());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown[]>>(request);
    }

    public getAllKeys() {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.records.keys());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }
}

class FakeTransaction {
    public onabort: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public oncomplete: (() => void) | null = null;

    public constructor(private readonly store: FakeObjectStore) {}

    public objectStore(_name: string) {
        queueMicrotask(() => {
            this.oncomplete?.();
        });
        return cast<IDBObjectStore>(this.store);
    }
}

class FakeDatabase {
    private readonly storesByName = new Map<string, {
        records: Map<string, unknown>;
        keyPath: string;
    }>();
    private readonly storeNames = new Set<string>();

    public readonly objectStoreNames = { contains: (name: string) => this.storeNames.has(name) };

    public createObjectStore(name: string, options?: { keyPath?: string }) {
        this.storeNames.add(name);
        const store = {
            records: new Map<string, unknown>(),
            keyPath: options?.keyPath ?? 'ref',
        };
        this.storesByName.set(name, store);
        return cast<IDBObjectStore>(new FakeObjectStore(store.records, store.keyPath));
    }

    public transaction(name: string, _mode: IDBTransactionMode) {
        const store = this.storesByName.get(name) ?? {
            records: new Map<string, unknown>(),
            keyPath: 'ref',
        };
        this.storesByName.set(name, store);
        return cast<IDBTransaction>(new FakeTransaction(new FakeObjectStore(store.records, store.keyPath)));
    }

    public getStoreRecords(name: string) {
        const store = this.storesByName.get(name);
        return store?.records ?? new Map<string, unknown>();
    }

    public close() {}
}

class FakeIndexedDbFactory {
    private readonly databases = new Map<string, FakeDatabase>();

    public open(name: string, _version: number) {
        const request = new FakeIdbRequest<IDBDatabase>();
        queueMicrotask(() => {
            let database = this.databases.get(name);
            const isNew = !database;
            if (!database) {
                database = new FakeDatabase();
                this.databases.set(name, database);
            }

            request.result = cast<IDBDatabase>(database);
            if (isNew) {
                request.onupgradeneeded?.(new Event('upgradeneeded'));
            }
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBOpenDBRequest>(request);
    }

    public getDatabase(name: string) {
        return this.databases.get(name) ?? null;
    }
}

describe('BrowserDocumentStore', () => {
    let indexedDbFactory: FakeIndexedDbFactory;

    beforeEach(() => {
        vi.unstubAllGlobals();
        indexedDbFactory = new FakeIndexedDbFactory();
        vi.stubGlobal('indexedDB', indexedDbFactory);
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
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
});
