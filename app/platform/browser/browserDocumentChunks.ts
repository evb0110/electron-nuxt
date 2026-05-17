import { DOCUMENT_CHUNKS_STORE } from './browserDocumentConstants';
import { normalizePersistedBytes } from './browserDocumentBytes';
import { isRecord } from './browserDocumentRecords';
import type {
    IBrowserDocumentChunkRecord,
    IChunkKeyRecord,
} from './browserDocumentTypes';
import { withObjectStore } from './browserDocumentIdb';

export function createChunkKey(ref: string, index: number) {
    return `${ref}::${index}`;
}

export function parseChunkKey(key: string): IChunkKeyRecord | null {
    const separatorIndex = key.lastIndexOf('::');
    if (separatorIndex <= 0) {
        return null;
    }

    const ref = key.slice(0, separatorIndex);
    const index = Number.parseInt(key.slice(separatorIndex + 2), 10);
    if (!ref || Number.isNaN(index) || index < 0) {
        return null;
    }

    return {
        ref,
        index,
    };
}

export function toPersistedChunkRecord(value: unknown): IBrowserDocumentChunkRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const key = typeof value.key === 'string' ? value.key : null;
    const ref = typeof value.ref === 'string' ? value.ref : null;
    const index =
        typeof value.index === 'number' && value.index >= 0
            ? Math.floor(value.index)
            : null;
    const data = normalizePersistedBytes(value.data);

    if (!key || !ref || index === null || !data) {
        return null;
    }

    return {
        key,
        ref,
        index,
        data,
    };
}

export async function persistChunkRecord(record: IBrowserDocumentChunkRecord) {
    const result = await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.put(record),
    );
    if (result === null) {
        throw new Error('IndexedDB document chunk write did not commit.');
    }
}

export async function loadChunkRecord(ref: string, index: number) {
    return withObjectStore<unknown>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.get(createChunkKey(ref, index)) as IDBRequest<unknown>,
    );
}

export async function deleteChunkRecord(ref: string, index: number) {
    const result = await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.delete(createChunkKey(ref, index)),
    );
    if (result === null) {
        throw new Error('IndexedDB document chunk delete did not commit.');
    }
}

export async function loadAllChunkKeys() {
    return withObjectStore<IDBValidKey[]>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.getAllKeys(),
    );
}
