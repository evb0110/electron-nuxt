import {BROWSER_DOCUMENT_CHUNK_SIZE} from '@app/platform/browser/browserDocumentConstants';
import {
    cloneBytes,
    toUint8Array,
} from '@app/platform/browser/browserDocumentBytes';
import {
    createBrowserDocumentEntry,
    createPersistedBrowserDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import {createBrowserDocumentRef} from '@app/platform/browser/browserDocumentRefs';
import {
    defaultRetentionForKind,
    resolveStoredDocumentStorageMode,
} from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    ICreateStoredDocumentOptions,
} from '@app/platform/browser/browserDocumentTypes';
import {
    deleteRecord,
    persistRecord,
} from '@app/platform/browser/browserDocumentIdb';
import {
    deleteBrowserDocumentChunks,
    persistBrowserDocumentChunkGeneration,
} from '@app/platform/browser/browserDocumentChunkStorage';
import {createBrowserDocumentContentToken} from '@app/platform/browser/browserDocumentRevision';

export async function createStoredBrowserDocument(
    entries: Map<string, IBrowserDocumentEntry>,
    fileName: string,
    data: Uint8Array | ArrayBuffer,
    options: ICreateStoredDocumentOptions,
) {
    const sourceBytes = toUint8Array(data);
    const storageMode = resolveStoredDocumentStorageMode(sourceBytes.byteLength, options.storageMode);
    const bytes = storageMode === 'inline' ? cloneBytes(sourceBytes) : new Uint8Array();
    const ref = createBrowserDocumentRef(fileName);
    const kind = options.kind ?? 'source';
    const entry = createBrowserDocumentEntry({
        ref,
        fileName,
        mimeType: options.mimeType,
        kind,
        retention: options.retention ?? defaultRetentionForKind(kind),
        ...(options.sourceRef ? {sourceRef: options.sourceRef} : {}),
        data: bytes,
        fileSize: storageMode === 'chunked' ? sourceBytes.byteLength : bytes.byteLength,
        contentToken: createBrowserDocumentContentToken(),
        saveKind: options.saveKind ?? 'generic',
        saveHandle: options.saveHandle ?? null,
        storageMode,
        chunkCount: options.chunkCount ?? 0,
        chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
    });

    entries.set(ref, entry);
    let stagedGeneration: string | undefined;
    let stagedChunkCount = 0;
    try {
        if (storageMode === 'chunked' && sourceBytes.byteLength > 0) {
            const stagedLayout = await persistBrowserDocumentChunkGeneration(
                entry.ref,
                sourceBytes.byteLength,
                Math.max(1, entry.chunkSize),
                (offset, length) => Promise.resolve(sourceBytes.slice(offset, offset + length)),
            );
            stagedGeneration = stagedLayout.generation;
            stagedChunkCount = stagedLayout.chunkCount;
            entry.data = new Uint8Array();
            entry.chunkGeneration = stagedLayout.generation;
            entry.chunkCount = stagedLayout.chunkCount;
            entry.fileSize = sourceBytes.byteLength;
            entry.updatedAt = Date.now();
        }
        await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
        if (storageMode === 'chunked') {
            stagedGeneration = undefined;
            stagedChunkCount = 0;
        }
    } catch (error) {
        entries.delete(ref);
        if (stagedGeneration) {
            await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                .catch(() => undefined);
        }
        await deleteRecord(ref).catch(() => undefined);
        throw error;
    }
    return ref;
}
