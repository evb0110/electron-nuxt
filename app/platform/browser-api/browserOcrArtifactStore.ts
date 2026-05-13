import type { TDocumentRef } from '@contracts/platformApi';
import {
    deleteStoreValue,
    isIndexedDbAvailable,
    readStoreValue,
    writeStoreValue,
} from '@app/platform/browser-api/browserIndexeddb';

const OCR_ARTIFACT_DB_NAME = 'evb-browser-ocr-artifacts';
const OCR_ARTIFACT_DB_VERSION = 1;
const OCR_ARTIFACT_STORE = 'ocr-artifacts';
const OCR_ARTIFACT_DOCUMENT_INDEX = 'by-document';

interface IBrowserOcrArtifactRecord {
    key: string;
    documentRef: string;
    relativePath: string;
    json: string;
    updatedAt: number;
}

function makeArtifactKey(documentRef: string, relativePath: string) {
    return `${documentRef}\u0000${relativePath}`;
}

function openBrowserOcrArtifactDb(): Promise<IDBDatabase | null> {
    if (!isIndexedDbAvailable()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(OCR_ARTIFACT_DB_NAME, OCR_ARTIFACT_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(OCR_ARTIFACT_STORE)
                ? request.transaction?.objectStore(OCR_ARTIFACT_STORE)
                : db.createObjectStore(OCR_ARTIFACT_STORE, { keyPath: 'key' });

            if (store && !store.indexNames.contains(OCR_ARTIFACT_DOCUMENT_INDEX)) {
                store.createIndex(OCR_ARTIFACT_DOCUMENT_INDEX, 'documentRef', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open OCR artifact database'));
    });
}

function readAllKeysForDocument(
    index: IDBIndex,
    documentRef: string,
): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const request = index.getAllKeys(documentRef);
        request.onsuccess = () => {
            const keys = Array.isArray(request.result)
                ? request.result.filter((value): value is string => typeof value === 'string')
                : [];
            resolve(keys);
        };
        request.onerror = () => reject(request.error ?? new Error('Failed to list OCR artifact keys'));
    });
}

export async function readBrowserOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
): Promise<T | null> {
    const db = await openBrowserOcrArtifactDb();
    if (!db) {
        return null;
    }

    try {
        const transaction = db.transaction(OCR_ARTIFACT_STORE, 'readonly');
        const store = transaction.objectStore(OCR_ARTIFACT_STORE);
        const record = await readStoreValue<IBrowserOcrArtifactRecord>(
            store,
            makeArtifactKey(workingCopyPath, relativePath),
            'Failed to read OCR artifact',
        );
        if (!record) {
            return null;
        }

        return JSON.parse(record.json) as T;
    } finally {
        db.close();
    }
}

export async function writeBrowserOcrArtifactJson(
    workingCopyPath: TDocumentRef,
    relativePath: string,
    value: unknown,
): Promise<void> {
    const db = await openBrowserOcrArtifactDb();
    if (!db) {
        return;
    }

    try {
        const transaction = db.transaction(OCR_ARTIFACT_STORE, 'readwrite');
        const store = transaction.objectStore(OCR_ARTIFACT_STORE);
        await writeStoreValue(store, {
            key: makeArtifactKey(workingCopyPath, relativePath),
            documentRef: workingCopyPath,
            relativePath,
            json: JSON.stringify(value),
            updatedAt: Date.now(),
        }, 'Failed to write OCR artifact');
    } finally {
        db.close();
    }
}

export async function clearBrowserOcrArtifacts(
    workingCopyPath: TDocumentRef,
): Promise<void> {
    const db = await openBrowserOcrArtifactDb();
    if (!db) {
        return;
    }

    try {
        const transaction = db.transaction(OCR_ARTIFACT_STORE, 'readwrite');
        const store = transaction.objectStore(OCR_ARTIFACT_STORE);
        const index = store.index(OCR_ARTIFACT_DOCUMENT_INDEX);
        const keys = await readAllKeysForDocument(index, workingCopyPath);

        for (const key of keys) {
            await deleteStoreValue(store, key, 'Failed to delete OCR artifact');
        }
    } finally {
        db.close();
    }
}
