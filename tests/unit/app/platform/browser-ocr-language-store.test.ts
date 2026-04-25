import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    cacheBrowserOcrLanguageData,
    clearBrowserOcrLanguageCache,
    getBrowserOcrCacheBackend,
    hasCachedBrowserOcrLanguage,
    hydrateBrowserOcrLanguageCache,
    listBrowserOcrLanguageCacheEntries,
    listInstalledBrowserOcrLanguages,
    markBrowserOcrLanguageInstalled,
} from '@app/platform/browser-api/browser-ocr-language-store';

function cast<T>(value: unknown): T {
    return value as T;
}

class FakeIdbRequest<T> {
    public result!: T;
    public error: Error | null = null;
    public onsuccess: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onupgradeneeded: ((event: Event) => void) | null = null;
}

class FakeObjectStore {
    public constructor(
        private readonly records: Map<string, unknown>,
        private readonly keyPath?: string,
    ) {}

    public getAll() {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.records.values());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown[]>>(request);
    }

    public get(key: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.records.get(String(key));
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public put(value: unknown, key?: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            const resolvedKey = typeof key !== 'undefined'
                ? String(key)
                : String((value as Record<string, unknown>)[this.keyPath ?? 'id']);
            this.records.set(resolvedKey, value);
            request.result = value;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public getAllKeys() {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.records.keys());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }

    public delete(key: IDBValidKey) {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.records.delete(String(key));
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<undefined>>(request);
    }

    public clear() {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.records.clear();
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<undefined>>(request);
    }
}

class FakeTransaction {
    public onabort: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public oncomplete: (() => void) | null = null;

    public constructor(private readonly stores: Map<string, FakeObjectStore>) {
        queueMicrotask(() => {
            this.oncomplete?.();
        });
    }

    public objectStore(name: string) {
        const store = this.stores.get(name);
        if (!store) {
            throw new Error(`Missing store ${name}`);
        }

        return cast<IDBObjectStore>(store);
    }
}

class FakeDatabase {
    private readonly recordsByStore = new Map<string, Map<string, unknown>>();
    private readonly keyPathByStore = new Map<string, string | undefined>();

    public readonly objectStoreNames = { contains: (name: string) => this.recordsByStore.has(name) };

    public createObjectStore(name: string, options?: { keyPath?: string }) {
        if (!this.recordsByStore.has(name)) {
            this.recordsByStore.set(name, new Map());
            this.keyPathByStore.set(name, options?.keyPath);
        }

        return cast<IDBObjectStore>(new FakeObjectStore(
            this.recordsByStore.get(name)!,
            this.keyPathByStore.get(name),
        ));
    }

    public transaction(name: string, _mode: IDBTransactionMode) {
        if (!this.recordsByStore.has(name)) {
            this.recordsByStore.set(name, new Map());
        }

        const stores = new Map<string, FakeObjectStore>([[
            name,
            new FakeObjectStore(
                this.recordsByStore.get(name)!,
                this.keyPathByStore.get(name),
            ),
        ]]);

        return cast<IDBTransaction>(new FakeTransaction(stores));
    }

    public close() {}
}

class FakeIndexedDbFactory {
    private readonly databases = new Map<string, FakeDatabase>();

    public open(name: string, _version?: number) {
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

class FakeOpfsFile {
    public constructor(private readonly data: Uint8Array) {}

    public async arrayBuffer() {
        return this.data.slice().buffer;
    }
}

class FakeOpfsWritable {
    public constructor(private readonly onClose: (data: Uint8Array) => void) {}

    private data = new Uint8Array();

    public async write(value: Uint8Array) {
        this.data = value.slice();
    }

    public async close() {
        this.onClose(this.data);
    }
}

class FakeOpfsFileHandle {
    public constructor(
        private readonly files: Map<string, Uint8Array>,
        private readonly name: string,
    ) {}

    public async createWritable() {
        return new FakeOpfsWritable((data) => {
            this.files.set(this.name, data);
        });
    }

    public async getFile() {
        return new FakeOpfsFile(this.files.get(this.name) ?? new Uint8Array());
    }
}

class FakeOpfsDirectoryHandle {
    public constructor(
        private readonly directories: Map<string, FakeOpfsDirectoryHandle>,
        private readonly files: Map<string, Uint8Array>,
    ) {}

    public async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        let directory = this.directories.get(name);
        if (!directory && options?.create) {
            directory = new FakeOpfsDirectoryHandle(new Map(), new Map());
            this.directories.set(name, directory);
        }
        if (!directory) {
            throw new Error(`Missing directory ${name}`);
        }

        return directory;
    }

    public async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!this.files.has(name) && !options?.create) {
            throw new Error(`Missing file ${name}`);
        }
        if (!this.files.has(name)) {
            this.files.set(name, new Uint8Array());
        }

        return new FakeOpfsFileHandle(this.files, name);
    }

    public async removeEntry(name: string, options?: { recursive?: boolean }) {
        if (this.files.delete(name)) {
            return;
        }

        if (options?.recursive && this.directories.delete(name)) {
            return;
        }

        throw new Error(`Missing entry ${name}`);
    }
}

describe('browser OCR language store', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        const opfsRoot = new FakeOpfsDirectoryHandle(new Map(), new Map());
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfsRoot } });
    });

    it('tracks installed OCR languages', async () => {
        await markBrowserOcrLanguageInstalled('eng');
        await markBrowserOcrLanguageInstalled('deu');

        await expect(listInstalledBrowserOcrLanguages()).resolves.toEqual(new Set([
            'eng',
            'deu',
        ]));
    });

    it('ignores empty language codes', async () => {
        await markBrowserOcrLanguageInstalled('   ');

        await expect(listInstalledBrowserOcrLanguages()).resolves.toEqual(new Set());
    });

    it('stores traineddata in the Tesseract cache store', async () => {
        await cacheBrowserOcrLanguageData('eng', new Uint8Array([
            1,
            2,
            3,
        ]));

        await expect(hasCachedBrowserOcrLanguage('eng')).resolves.toBe(true);
        await expect(hasCachedBrowserOcrLanguage('fra')).resolves.toBe(false);
    });

    it('hydrates the Tesseract cache from OPFS', async () => {
        await cacheBrowserOcrLanguageData('eng', new Uint8Array([
            4,
            5,
            6,
        ]));

        await expect(hydrateBrowserOcrLanguageCache('eng')).resolves.toBe(true);
        await expect(hasCachedBrowserOcrLanguage('eng')).resolves.toBe(true);
    });

    it('reports the active cache backend and stored pack locations', async () => {
        await cacheBrowserOcrLanguageData('eng', new Uint8Array([
            9,
            8,
            7,
        ]));
        await markBrowserOcrLanguageInstalled('eng', { sizeBytes: 3 });

        expect(getBrowserOcrCacheBackend()).toBe('opfs+indexeddb');
        await expect(listBrowserOcrLanguageCacheEntries()).resolves.toEqual([expect.objectContaining({
            code: 'eng',
            sizeBytes: 3,
            hasOpfsCopy: true,
            hasIndexedDbCopy: true,
        })]);
    });

    it('clears selected cached language packs', async () => {
        await cacheBrowserOcrLanguageData('eng', new Uint8Array([
            1,
            1,
            1,
        ]));
        await cacheBrowserOcrLanguageData('deu', new Uint8Array([
            2,
            2,
            2,
        ]));
        await markBrowserOcrLanguageInstalled('eng');
        await markBrowserOcrLanguageInstalled('deu');

        await clearBrowserOcrLanguageCache(['eng']);

        await expect(hasCachedBrowserOcrLanguage('eng')).resolves.toBe(false);
        await expect(hasCachedBrowserOcrLanguage('deu')).resolves.toBe(true);
        await expect(listInstalledBrowserOcrLanguages()).resolves.toEqual(new Set(['deu']));
    });

    it('clears all cached language packs', async () => {
        await cacheBrowserOcrLanguageData('eng', new Uint8Array([
            3,
            3,
            3,
        ]));
        await markBrowserOcrLanguageInstalled('eng');

        await clearBrowserOcrLanguageCache();

        await expect(hasCachedBrowserOcrLanguage('eng')).resolves.toBe(false);
        await expect(listInstalledBrowserOcrLanguages()).resolves.toEqual(new Set());
        await expect(listBrowserOcrLanguageCacheEntries()).resolves.toEqual([]);
    });
});
