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
    public constructor(private readonly records: Map<string, unknown>) {}

    public put(record: { ref: string }) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.records.set(record.ref, record);
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
    private readonly records = new Map<string, unknown>();
    private readonly stores = new Set<string>();

    public readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

    public createObjectStore(name: string) {
        this.stores.add(name);
        return cast<IDBObjectStore>(new FakeObjectStore(this.records));
    }

    public transaction(_name: string, _mode: IDBTransactionMode) {
        return cast<IDBTransaction>(new FakeTransaction(new FakeObjectStore(this.records)));
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

async function loadBrowserDocumentsFileCapability() {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    const localStorage = new MemoryStorage();
    vi.stubGlobal('window', {
        localStorage,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
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
        { browserDocumentStore },
    ] = await Promise.all([
        import('@app/platform/browser-api/documents-file-capability'),
        import('@app/platform/browser-document-store'),
    ]);

    return {
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
});
