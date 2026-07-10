import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import { createBrowserDocumentContentToken } from '@app/platform/browser/browserDocumentRevision';
import {
    defaultRetentionForKind,
    resolveByteBackedStorageMode,
} from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IRegisterFileOptions,
} from '@app/platform/browser/browserDocumentTypes';

export function createBrowserFileDocumentEntry(
    ref: string,
    file: File,
    options: IRegisterFileOptions = {},
): IBrowserDocumentEntry {
    const kind = options.kind ?? 'source';
    return {
        ref,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        kind,
        retention: options.retention ?? defaultRetentionForKind(kind),
        ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        data: new Uint8Array(),
        fileSize: file.size,
        updatedAt: Date.now(),
        contentToken: createBrowserDocumentContentToken(),
        pendingLoad: null,
        saveName: file.name,
        saveKind: options.saveKind ?? 'generic',
        saveHandle: options.saveHandle ?? null,
        storageMode: resolveByteBackedStorageMode(file.size),
        chunkCount: 0,
        chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
    };
}
