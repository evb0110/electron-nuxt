import {
    DB_NAME,
    DB_VERSION,
    DOCUMENT_CHUNKS_STORE,
    DOCUMENTS_STORE,
    type IBrowserPersistedDocumentRecord,
} from './browserDocumentTypes';

type TIndexedDbFactory = typeof indexedDB;

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
        const request = indexedDbFactory.open(DB_NAME, DB_VERSION);

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
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = run(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
    });
}

export async function persistRecord(record: IBrowserPersistedDocumentRecord) {
    await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put(record));
}

export async function loadRecord(ref: string) {
    return withObjectStore<unknown>(
        DOCUMENTS_STORE,
        'readonly',
        (store) => store.get(ref) as IDBRequest<unknown>,
    );
}

export async function loadAllRecords() {
    return withObjectStore<unknown[]>(
        DOCUMENTS_STORE,
        'readonly',
        (store) => store.getAll() as IDBRequest<unknown[]>,
    );
}

export async function deleteRecord(ref: string) {
    await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.delete(ref));
}
