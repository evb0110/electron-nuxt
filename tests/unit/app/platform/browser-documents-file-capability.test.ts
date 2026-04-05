import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';

function cast<T>(value: unknown): T {
    return value as T;
}

class MemoryStorage {
    private readonly data = new Map<string, string>();

    public clear() {
        this.data.clear();
    }

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
}

async function createPdfBytes() {
    const document = await PDFDocument.create();
    document.addPage();
    return new Uint8Array(await document.save());
}

function createMockElement(tagName: string) {
    return {
        tagName: tagName.toUpperCase(),
        style: {},
        files: null,
        content: {
            firstChild: null,
            appendChild() {},
        },
        relList: { supports() { return true; } },
        setAttribute() {},
        appendChild() {},
        append() {},
        remove() {},
        click() {},
        addEventListener() {},
        removeEventListener() {},
        getContext() {
            return null;
        },
    };
}

interface ILoadBrowserDocumentsFileCapabilityOptions { windowOverrides?: Record<string, unknown>; }

async function loadBrowserDocumentsFileCapability(options?: ILoadBrowserDocumentsFileCapabilityOptions) {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    const localStorage = new MemoryStorage();
    vi.stubGlobal('window', {
        localStorage,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        ...options?.windowOverrides,
    });
    vi.stubGlobal('document', {
        cookie: '',
        body: {
            append() {},
            appendChild() {},
            removeChild() {},
        },
        createElement(tagName: string) {
            return createMockElement(tagName);
        },
        createElementNS(_namespace: string, tagName: string) {
            return createMockElement(tagName);
        },
        createTextNode(text: string) {
            return { nodeValue: text };
        },
        createComment(text: string) {
            return { nodeValue: text };
        },
        querySelector() {
            return null;
        },
    });

    const [
        { createBrowserDocumentsFileCapability },
        {
            BROWSER_MAX_FULL_READ_BYTES,
            browserDocumentStore,
        },
    ] = await Promise.all([
        import('@app/platform/browser-api/documents-file-capability'),
        import('@app/platform/browser-document-store'),
    ]);

    return {
        BROWSER_MAX_FULL_READ_BYTES,
        capability: createBrowserDocumentsFileCapability({ clearSearchCaches: () => {} }),
        browserDocumentStore,
    };
}

describe('createBrowserDocumentsFileCapability', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('cleans up transient source refs via cleanupFile', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const ref = await browserDocumentStore.createStoredDocument(
            'picked-image.png',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'image/png',
                kind: 'source',
                retention: 'transient',
                saveKind: 'generic',
            },
        );

        await capability.cleanupFile(ref);

        await expect(browserDocumentStore.exists(ref)).resolves.toBe(false);
    });

    it('does not expose DjVu files in the browser combine picker', async () => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(capability.openCombineDialog()).resolves.toBeNull();

        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({
            multiple: true,
            types: [expect.objectContaining({ accept: expect.not.objectContaining({'application/octet-stream': expect.anything()}) })],
        }));
    });

    it('rejects oversized browser combine rewrites before reading the input PDFs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            new Uint8Array([2]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({ size: 20 * 1024 * 1024 });
        const readSpy = vi.spyOn(browserDocumentStore, 'read');

        await expect(createCombinedPdfFromPaths([
            firstRef,
            secondRef,
        ])).rejects.toThrow(
            'Combining documents is unavailable in the browser for inputs larger than 32MB',
        );

        expect(readSpy).not.toHaveBeenCalled();
        statSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('creates transient working copies from raw browser data without durable recents', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await capability.createWorkingCopyFromData(
            'draft.pdf',
            await createPdfBytes(),
        );

        const workingEntry = await browserDocumentStore.requireEntry(workingRef);

        expect(workingEntry.kind).toBe('working');
        expect(workingEntry.sourceRef).toBeUndefined();
        await expect(capability.recentFiles.get()).resolves.toEqual([]);

        await capability.cleanupFile(workingRef);
        await expect(browserDocumentStore.exists(workingRef)).resolves.toBe(false);
    });

    it('keeps the original source when cloning a working copy snapshot', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            pdfBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const snapshotRef = await capability.createWorkingCopyFromPath(
            workingRef,
            sourceRef,
        );

        const snapshotEntry = await browserDocumentStore.requireEntry(snapshotRef);

        expect(snapshotEntry.sourceRef).toBe(sourceRef);

        await capability.cleanupFile(snapshotRef);
        await capability.cleanupFile(workingRef);

        await expect(browserDocumentStore.exists(sourceRef)).resolves.toBe(true);
    });

    it('clones chunked working-copy snapshots without forcing a full read', async () => {
        const {
            capability,
            browserDocumentStore,
            BROWSER_MAX_FULL_READ_BYTES,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.write(workingRef, oversizedBytes);

        const snapshotRef = await capability.createWorkingCopyFromPath(
            workingRef,
            sourceRef,
        );
        const snapshotEntry = await browserDocumentStore.requireEntry(snapshotRef);

        expect(snapshotEntry.storageMode).toBe('chunked');
        expect(snapshotEntry.sourceRef).toBe(sourceRef);
        await expect(browserDocumentStore.stat(snapshotRef)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        await expect(browserDocumentStore.readRange(snapshotRef, 0, 4)).resolves.toEqual(new Uint8Array([
            37,
            80,
            68,
            70,
        ]));
    });

    it('creates source-proxy working copies when reopening a persisted source path', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            await createPdfBytes(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        const workingRef = await capability.createWorkingCopyFromPath(sourceRef);
        const workingEntry = await browserDocumentStore.requireEntry(workingRef);

        expect(workingEntry.kind).toBe('working');
        expect(workingEntry.sourceRef).toBe(sourceRef);
        expect(workingEntry.storageMode).toBe('source-proxy');
    });

    it('hydrates legacy handle-backed browser sources during direct open', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const getFile = vi.fn(async () => new File([pdfBytes], 'legacy.pdf', { type: 'application/pdf' }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'legacy.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
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

        const result = await capability.openPdfDirect(sourceRef);
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('pdf');

        getFile.mockImplementation(async () => {
            throw new DOMException('Not allowed', 'NotAllowedError');
        });
        browserDocumentStore.unload(sourceRef);

        await expect(browserDocumentStore.read(sourceRef)).resolves.toEqual(pdfBytes);
    });

    it('keeps oversized handle-backed sources lazy during direct open', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const getFile = vi.fn(async () => ({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            slice(start?: number, end?: number) {
                const requestedLength = Math.max(0, (end ?? 0) - (start ?? 0));
                return new Blob([new Uint8Array(requestedLength)], { type: 'application/pdf' });
            },
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'huge.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'huge.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        const result = await capability.openPdfDirect(sourceRef);
        const sourceEntry = await browserDocumentStore.requireEntry(sourceRef);
        const workingEntry = result
            ? await browserDocumentStore.requireEntry(result.workingPath)
            : null;

        expect(result?.kind).toBe('pdf');
        expect(sourceEntry.storageMode).toBe('handle');
        expect(workingEntry?.storageMode).toBe('source-proxy');
        expect(workingEntry?.sourceRef).toBe(sourceRef);
    });

    it('streams oversized browser saves to an existing file handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'large-save.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'large-save.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'large-save.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.write(workingRef, oversizedBytes);

        await expect(capability.saveFile(workingRef)).resolves.toBe(true);

        const savedEntry = await browserDocumentStore.requireEntry(sourceRef);
        expect(savedEntry.storageMode).toBe('handle');
        await expect(browserDocumentStore.stat(sourceRef)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        expect(writes.length).toBeGreaterThan(1);
        expect(writes[0]?.slice(0, 4)).toEqual(new Uint8Array([
            37,
            80,
            68,
            70,
        ]));
    });

    it('streams oversized browser save-as to a picked file handle', async () => {
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array((64 * 1024 * 1024) + 1);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'exported-large.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'exported-large.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker: vi.fn(async () => handle) } });
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const sourceRef = await capability.savePdfAs(workingRef);

        expect(sourceRef).not.toBeNull();
        const sourceEntry = sourceRef
            ? await browserDocumentStore.requireEntry(sourceRef)
            : null;
        expect(sourceEntry?.storageMode).toBe('handle');
        expect(sourceEntry?.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef!)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        expect(writes.length).toBeGreaterThan(1);
    });

    it('blocks browser save-as when a working copy exceeds the full-read budget', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        await expect(capability.savePdfAs(workingRef)).rejects.toThrow(
            'Saving documents is unavailable in the browser for inputs larger than 64MB',
        );
    });
});
