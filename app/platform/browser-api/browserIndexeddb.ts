export function isIndexedDbAvailable() {
    return typeof indexedDB !== 'undefined';
}

function idbRequestToPromise<T>(
    request: IDBRequest<T>,
    errorMessage: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

export function openBrowserDatabase(
    dbName: string,
    version: number,
    upgrade: (db: IDBDatabase, transaction: IDBTransaction | null) => void,
): Promise<IDBDatabase | null> {
    if (!isIndexedDbAvailable()) {
        return Promise.resolve(null);
    }

    const request = indexedDB.open(dbName, version);
    request.onupgradeneeded = () => {
        upgrade(request.result, request.transaction);
    };

    return idbRequestToPromise(request, `Failed to open ${dbName} database`);
}

export function readStoreValue<T>(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
): Promise<T | null> {
    return idbRequestToPromise(store.get(key), errorMessage)
        .then((value) => (value as T | undefined) ?? null);
}

export function readAllStoreValues<T>(
    store: IDBObjectStore,
    errorMessage: string,
): Promise<T[]> {
    return idbRequestToPromise(store.getAll(), errorMessage)
        .then((values) => (values as T[] | undefined) ?? []);
}

export function readAllStoreKeys(
    store: IDBObjectStore,
    errorMessage: string,
): Promise<IDBValidKey[]> {
    return idbRequestToPromise(store.getAllKeys(), errorMessage)
        .then((keys) => keys ?? []);
}

export function writeStoreValue(
    store: IDBObjectStore,
    value: unknown,
    errorMessage: string,
    key?: IDBValidKey,
) {
    const request = typeof key === 'undefined'
        ? store.put(value)
        : store.put(value, key);

    return idbRequestToPromise(request, errorMessage)
        .then(() => undefined);
}

export function deleteStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
) {
    return idbRequestToPromise(store.delete(key), errorMessage)
        .then(() => undefined);
}

export function clearStore(
    store: IDBObjectStore,
    errorMessage: string,
) {
    return idbRequestToPromise(store.clear(), errorMessage)
        .then(() => undefined);
}
