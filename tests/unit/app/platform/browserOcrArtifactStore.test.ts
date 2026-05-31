import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clearBrowserOcrArtifacts,
    readBrowserOcrArtifactJson,
    writeBrowserOcrArtifactJson,
} from '@app/platform/browser-api/browserOcrArtifactStore';
import { cast } from '../../../helpers/cast';

class FakeIdbRequest<T> {
    public result!: T;
    public error: Error | null = null;
    public onsuccess: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onupgradeneeded: ((event: Event) => void) | null = null;
}

interface IStoredRecord {
    key: string;
    documentRef: string;
    relativePath: string;
    json: string;
    updatedAt: number;
}

class FakeIndex {
    public constructor(private readonly records: Map<string, IStoredRecord>) {}

    public getAllKeys(documentRef: string) {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.records.values())
                .filter(record => record.documentRef === documentRef)
                .map(record => record.key);
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }
}

class FakeObjectStore {
    public readonly indexNames = {contains: (name: string) => name === 'by-document'};

    public constructor(private readonly records: Map<string, IStoredRecord>) {}

    public createIndex(_name: string, _keyPath: string, _options?: { unique?: boolean }) {
        return cast<IDBIndex>(new FakeIndex(this.records));
    }

    public index(_name: string) {
        return cast<IDBIndex>(new FakeIndex(this.records));
    }

    public put(record: IStoredRecord) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.records.set(record.key, record);
            request.result = record;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public get(key: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.records.get(String(key));
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public delete(key: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.records.delete(String(key));
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

    public constructor(private readonly store: FakeObjectStore) {
        queueMicrotask(() => {
            this.oncomplete?.();
        });
    }

    public objectStore(_name: string) {
        return cast<IDBObjectStore>(this.store);
    }
}

class FakeDatabase {
    private readonly records = new Map<string, IStoredRecord>();
    private hasStore = false;

    public readonly objectStoreNames = {contains: (_name: string) => this.hasStore};

    public createObjectStore(_name: string, _options?: { keyPath?: string }) {
        this.hasStore = true;
        return cast<IDBObjectStore>(new FakeObjectStore(this.records));
    }

    public transaction(_name: string, _mode: IDBTransactionMode) {
        this.hasStore = true;
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

describe('browser OCR artifact store', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    });

    it('persists manifest and page data by browser document ref', async () => {
        const workingCopyPath = 'browser://documents/test/doc.pdf';

        await writeBrowserOcrArtifactJson(workingCopyPath, 'manifest.json', {
            version: 2,
            pages: {1: { path: 'pages/1.json' }},
        });
        await writeBrowserOcrArtifactJson(workingCopyPath, 'pages/1.json', {
            pageNumber: 1,
            text: 'hello world',
        });

        await expect(
            readBrowserOcrArtifactJson(workingCopyPath, 'manifest.json'),
        ).resolves.toEqual({
            version: 2,
            pages: {1: { path: 'pages/1.json' }},
        });
        await expect(
            readBrowserOcrArtifactJson(workingCopyPath, 'pages/1.json'),
        ).resolves.toEqual({
            pageNumber: 1,
            text: 'hello world',
        });
    });

    it('clears all OCR artifacts for a document ref', async () => {
        const workingCopyPath = 'browser://documents/test/doc.pdf';

        await writeBrowserOcrArtifactJson(workingCopyPath, 'manifest.json', {version: 2});
        await writeBrowserOcrArtifactJson(workingCopyPath, 'pages/1.json', {pageNumber: 1});

        await clearBrowserOcrArtifacts(workingCopyPath);

        await expect(
            readBrowserOcrArtifactJson(workingCopyPath, 'manifest.json'),
        ).resolves.toBeNull();
        await expect(
            readBrowserOcrArtifactJson(workingCopyPath, 'pages/1.json'),
        ).resolves.toBeNull();
    });
});
