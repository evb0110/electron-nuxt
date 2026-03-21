import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserDocumentStore } from '@app/platform/browser-document-store';

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

describe('BrowserDocumentStore', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
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
});
