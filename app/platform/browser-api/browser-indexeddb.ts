export function isIndexedDbAvailable() {
    return typeof indexedDB !== 'undefined';
}

export function openBrowserDatabase(
    dbName: string,
    version: number,
    upgrade: (db: IDBDatabase, transaction: IDBTransaction | null) => void,
): Promise<IDBDatabase | null> {
    if (!isIndexedDbAvailable()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
            upgrade(request.result, request.transaction);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`Failed to open ${dbName} database`));
    });
}

export function readStoreValue<T>(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
): Promise<T | null> {
    return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function readAllStoreValues<T>(
    store: IDBObjectStore,
    errorMessage: string,
): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result as T[] | undefined) ?? []);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function readAllStoreKeys(
    store: IDBObjectStore,
    errorMessage: string,
): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function writeStoreValue(
    store: IDBObjectStore,
    value: unknown,
    errorMessage: string,
    key?: IDBValidKey,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = typeof key === 'undefined'
            ? store.put(value)
            : store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function deleteStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function clearStore(
    store: IDBObjectStore,
    errorMessage: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}
