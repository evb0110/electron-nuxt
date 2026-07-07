import {
    DB_NAME,
    DB_VERSION,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import type { IBrowserPersistedDocumentRecord } from '@app/platform/browser/browserDocumentTypes';

type TIndexedDbFactory = typeof indexedDB;

interface IIndexedDbReadResult<T> {
    available: boolean;
    value: T | null;
}

function getIndexedDbFactory(): TIndexedDbFactory | null {
    if (typeof indexedDB === 'undefined') {
        return null;
    }

    return indexedDB;
}

async function openDatabase() {
    const indexedDbFactory = getIndexedDbFactory();
    if (!indexedDbFactory) {
        return null;
    }

    return new Promise<IDBDatabase | null>((resolve) => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDbFactory.open(DB_NAME, DB_VERSION);
        } catch {
            resolve(null);
            return;
        }

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
                database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'ref' });
            }
            if (!database.objectStoreNames.contains(DOCUMENT_CHUNKS_STORE)) {
                database.createObjectStore(DOCUMENT_CHUNKS_STORE, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

function assertWriteCommitted(result: unknown, operation: string) {
    if (result === null) {
        throw new Error(`IndexedDB ${operation} did not commit.`);
    }
}

export async function withObjectStoreReadResult<T>(
    storeName: string,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<IIndexedDbReadResult<T>> {
    const database = await openDatabase();
    if (!database) {
        return {
            available: false,
            value: null,
        };
    }

    return new Promise<IIndexedDbReadResult<T>>((resolve) => {
        let requestResult: T | null = null;
        let requestSucceeded = false;
        let transactionCompleted = false;
        let settled = false;

        const cleanup = (available: boolean, value: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            database.close();
            resolve({
                available,
                value,
            });
        };

        try {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = run(store);

            request.onsuccess = () => {
                requestResult = request.result;
                requestSucceeded = true;
                if (transactionCompleted) {
                    cleanup(true, requestResult);
                }
            };
            request.onerror = () => cleanup(false, null);
            transaction.onabort = () => cleanup(false, null);
            transaction.onerror = () => cleanup(false, null);
            transaction.oncomplete = () => {
                transactionCompleted = true;
                if (requestSucceeded) {
                    cleanup(true, requestResult);
                }
            };
        } catch {
            cleanup(false, null);
        }
    });
}

export async function withObjectStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
) {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    return new Promise<T | null>((resolve) => {
        let requestResult: T | null = null;
        let requestSucceeded = false;
        let transactionCompleted = false;
        let settled = false;

        const cleanup = (result: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            database.close();
            resolve(result);
        };

        try {
            const transaction = database.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            const request = run(store);

            request.onsuccess = () => {
                requestResult = request.result;
                requestSucceeded = true;
                if (transactionCompleted) {
                    cleanup(requestResult);
                }
            };
            request.onerror = () => cleanup(null);
            transaction.onabort = () => cleanup(null);
            transaction.onerror = () => cleanup(null);
            transaction.oncomplete = () => {
                transactionCompleted = true;
                if (requestSucceeded) {
                    cleanup(requestResult);
                }
            };
        } catch {
            cleanup(null);
        }
    });
}

export async function persistRecord(record: IBrowserPersistedDocumentRecord) {
    const result = await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put(record));
    assertWriteCommitted(result, 'document write');
}

export async function loadRecord(ref: string) {
    return (await loadRecordAvailability(ref)).value;
}

export async function loadRecordAvailability(ref: string) {
    return withObjectStoreReadResult<unknown>(
        DOCUMENTS_STORE,
        (store) => store.get(ref) as IDBRequest<unknown>,
    );
}

export async function loadAllRecordKeys() {
    return (await loadAllRecordKeysAvailability()).value;
}

export async function loadAllRecordKeysAvailability() {
    return withObjectStoreReadResult<IDBValidKey[]>(
        DOCUMENTS_STORE,
        (store) => store.getAllKeys(),
    );
}

export async function deleteRecord(ref: string) {
    const result = await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.delete(ref));
    assertWriteCommitted(result, 'document delete');
}
