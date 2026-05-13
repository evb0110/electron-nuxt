import { BROWSER_MAX_FULL_READ_BYTES } from './browserDocumentConstants';
import type {
    IBrowserDocumentEntry,
    TBrowserDocumentStorageMode,
} from './browserDocumentTypes';

const BROWSER_INLINE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;

export function defaultRetentionForKind(kind: IBrowserDocumentEntry['kind']) {
    return kind === 'working' ? 'transient' : 'durable';
}

export function shouldInlineFileBytes(fileSize: number) {
    return fileSize <= BROWSER_INLINE_FILE_THRESHOLD_BYTES;
}

export function resolveByteBackedStorageMode(fileSize: number): TBrowserDocumentStorageMode {
    return shouldInlineFileBytes(fileSize) ? 'inline' : 'chunked';
}

export function resolveStoredDocumentStorageMode(
    byteLength: number,
    requestedStorageMode?: TBrowserDocumentStorageMode,
): TBrowserDocumentStorageMode {
    const storageMode =
        requestedStorageMode ?? resolveByteBackedStorageMode(byteLength);

    if (storageMode === 'source-proxy') {
        return 'source-proxy';
    }

    if (storageMode === 'handle') {
        return byteLength > 0
            ? resolveByteBackedStorageMode(byteLength)
            : 'handle';
    }

    if (storageMode === 'inline') {
        return resolveByteBackedStorageMode(byteLength);
    }

    return storageMode;
}

export function buildBrowserDocumentFullReadError(fileName: string, fileSize: number) {
    return new Error(
        `Browser document is too large to load fully into memory (${fileName}: `
        + `${Math.floor(fileSize / (1024 * 1024))}MB > `
        + `${Math.floor(BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024))}MB limit)`,
    );
}
