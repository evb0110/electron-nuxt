import { DOCUMENT_CHUNKS_STORE } from '@app/platform/browser/browserDocumentConstants';
import { normalizePersistedBytes } from '@app/platform/browser/browserDocumentBytes';
import { isRecord } from '@app/platform/browser/browserDocumentRecords';
import type {
    IBrowserDocumentChunkRecord,
    IChunkKeyRecord,
} from '@app/platform/browser/browserDocumentTypes';
import {
    withObjectStore,
    withObjectStoreReadResult,
} from '@app/platform/browser/browserDocumentIdb';

export function createChunkKey(ref: string, index: number, generation?: string) {
    return generation
        ? `${ref}::${generation}::${index}`
        : `${ref}::${index}`;
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

    const generationSeparatorIndex = ref.lastIndexOf('::');
    if (generationSeparatorIndex <= 0) {
        return {
            ref,
            index,
        };
    }

    return {
        ref: ref.slice(0, generationSeparatorIndex),
        generation: ref.slice(generationSeparatorIndex + 2),
        index,
    };
}

export function toPersistedChunkRecord(value: unknown): IBrowserDocumentChunkRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const key = typeof value.key === 'string' ? value.key : null;
    const ref = typeof value.ref === 'string' ? value.ref : null;
    const generation = typeof value.generation === 'string' ? value.generation : undefined;
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
        ...(generation ? { generation } : {}),
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

export async function loadChunkRecord(ref: string, index: number, generation?: string) {
    return withObjectStore<unknown>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.get(createChunkKey(ref, index, generation)) as IDBRequest<unknown>,
    );
}

export async function deleteChunkRecord(ref: string, index: number, generation?: string) {
    const result = await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.delete(createChunkKey(ref, index, generation)),
    );
    if (result === null) {
        throw new Error('IndexedDB document chunk delete did not commit.');
    }
}

export async function loadAllChunkKeys() {
    return (await loadAllChunkKeysAvailability()).value;
}

export async function loadAllChunkKeysAvailability() {
    return withObjectStoreReadResult<IDBValidKey[]>(
        DOCUMENT_CHUNKS_STORE,
        (store) => store.getAllKeys(),
    );
}
