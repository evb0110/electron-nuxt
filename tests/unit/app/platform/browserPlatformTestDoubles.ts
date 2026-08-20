import { cast } from '@tests/helpers/cast';

export { cast };

export class MemoryStorage {
    private readonly data = new Map<string, string>();

    public clear() {
        this.data.clear();
    }

    // Required by the Storage-shaped object consumed structurally by the browser capabilities.
    public getItem(key: string) {
        return this.data.get(key) ?? null;
    }

    public setItem(key: string, value: string) {
        this.data.set(key, value);
    }
}

class FakeIdbRequest<T> {
    public result!: T;
    public error: Error | null = null;
    public onsuccess: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onupgradeneeded: ((event: Event) => void) | null = null;
    public onblocked: ((event: Event) => void) | null = null;
}

interface IFakeStoreState {
    records: Map<string, unknown>;
    keyPath: string;
    indexes: Map<string, string>;
}

class FakeIndex {
    public constructor(
        private readonly state: IFakeStoreState,
        private readonly keyPath: string,
    ) {}

    public getAllKeys(value: IDBValidKey) {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.entries())
                .filter(([
                    , record,
                ]) => (
                    typeof record === 'object'
                    && record !== null
                    && !Array.isArray(record)
                    && String((record as Record<string, unknown>)[this.keyPath]) === String(value)
                ))
                .map(([key]) => key);
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }

    public openCursor(_query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) {
        const request = new FakeIdbRequest<IDBCursorWithValue | null>();
        const entries = Array.from(this.state.records.entries()).sort((first, second) => (
            Number((first[1] as Record<string, unknown>)[this.keyPath])
            - Number((second[1] as Record<string, unknown>)[this.keyPath])
        ));
        if (direction === 'prev' || direction === 'prevunique') {
            entries.reverse();
        }
        let cursorIndex = 0;
        const advance = () => queueMicrotask(() => {
            const entry = entries[cursorIndex];
            if (!entry) {
                request.result = null;
                request.onsuccess?.(new Event('success'));
                return;
            }
            const [
                key,
                value,
            ] = entry;
            request.result = cast<IDBCursorWithValue>({
                key,
                primaryKey: key,
                value,
                continue: () => {
                    cursorIndex += 1;
                    advance();
                },
                delete: () => {
                    this.state.records.delete(key);
                    return new FakeIdbRequest<undefined>();
                },
            });
            request.onsuccess?.(new Event('success'));
        });
        advance();
        return cast<IDBRequest<IDBCursorWithValue | null>>(request);
    }
}

class FakeObjectStore {
    public readonly indexNames = { contains: (name: string) => this.state.indexes.has(name) };

    public constructor(
        private readonly state: IFakeStoreState,
    ) {}

    public createIndex(name: string, keyPath: string, _options?: { unique?: boolean }) {
        this.state.indexes.set(name, keyPath);
        return cast<IDBIndex>(new FakeIndex(this.state, keyPath));
    }

    public index(name: string) {
        const keyPath = this.state.indexes.get(name);
        if (!keyPath) {
            throw new Error(`Missing fake IndexedDB index: ${name}`);
        }
        return cast<IDBIndex>(new FakeIndex(this.state, keyPath));
    }

    public put(record: unknown, key?: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            const recordKey = key ?? (
                typeof record === 'object' && record !== null && !Array.isArray(record)
                    ? (record as Record<string, unknown>)[this.state.keyPath]
                    : undefined
            );
            if (recordKey === undefined) {
                request.error = new Error('Fake IndexedDB record key is missing');
                request.onerror?.(new Event('error'));
                return;
            }
            this.state.records.set(String(recordKey), record);
            request.result = record;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public get(ref: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.state.records.get(String(ref));
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public delete(ref: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.state.records.delete(String(ref));
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public clear() {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.state.records.clear();
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<undefined>>(request);
    }

    public getAll() {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.values());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown[]>>(request);
    }

    public getAllKeys() {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.keys());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }
}

class FakeTransaction {
    public onabort: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public oncomplete: (() => void) | null = null;

    private completionScheduled = false;

    public constructor(private readonly stores: Map<string, FakeObjectStore>) {}

    public objectStore(name: string) {
        const store = this.stores.get(name);
        if (!store) {
            throw new Error(`Unknown IndexedDB test store: ${name}`);
        }
        if (!this.completionScheduled) {
            this.completionScheduled = true;
            queueMicrotask(() => {
                queueMicrotask(() => this.oncomplete?.());
            });
        }
        return cast<IDBObjectStore>(store);
    }
}

class FakeDatabase {
    private readonly storesByName = new Map<string, IFakeStoreState>();
    private readonly storeNames = new Set<string>();

    public readonly objectStoreNames = { contains: (name: string) => this.storeNames.has(name) };

    public createObjectStore(name: string, options?: { keyPath?: string }) {
        this.storeNames.add(name);
        const store = {
            records: new Map<string, unknown>(),
            keyPath: options?.keyPath ?? 'ref',
            indexes: new Map<string, string>(),
        };
        this.storesByName.set(name, store);
        return cast<IDBObjectStore>(new FakeObjectStore(store));
    }

    public transaction(nameOrNames: string | string[], _mode: IDBTransactionMode) {
        const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
        if (names.length === 0) {
            throw new Error('The IndexedDB test double requires at least one store name.');
        }
        const stores = new Map(names.map((name) => {
            const store = this.storesByName.get(name) ?? {
                records: new Map<string, unknown>(),
                keyPath: 'ref',
                indexes: new Map<string, string>(),
            };
            this.storesByName.set(name, store);
            return [
                name,
                new FakeObjectStore(store),
            ];
        }));
        return cast<IDBTransaction>(new FakeTransaction(stores));
    }

    public getStoreRecords(name: string) {
        const store = this.storesByName.get(name);
        return store?.records ?? new Map<string, unknown>();
    }

    public close() {}

    public rejectNextTransaction(error: Error) {
        const transaction = this.transaction.bind(this);
        this.transaction = ((_nameOrNames: string | string[], _mode: IDBTransactionMode) => {
            this.transaction = transaction;
            throw error;
        }) as typeof this.transaction;
    }
}

export class FakeIndexedDbFactory {
    private readonly databases = new Map<string, FakeDatabase>();

    // Required by the IDBFactory-shaped object consumed structurally by the browser document store.
    // fallow-ignore-next-line unused-class-member
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
