import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentsCapability } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import { loadDjvuJs } from '@app/platform/browser-api/djvujsLoader';

const DJVU_READ_CHUNK_BYTES = 4 * 1024 * 1024;

interface IDjvuWorkerReadOptions {signal?: AbortSignal;}

function toOwnedArrayBuffer(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }

    return bytes.slice().buffer;
}

async function readBrowserDocumentBytes(
    path: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    throwIfCanceled(options.signal);
    const { size } = await browserDocumentStore.stat(path);
    throwIfCanceled(options.signal);
    if (size <= 0) {
        return new Uint8Array();
    }

    if (size <= DJVU_READ_CHUNK_BYTES) {
        const bytes = await browserDocumentStore.read(path);
        throwIfCanceled(options.signal);
        return bytes;
    }

    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        throwIfCanceled(options.signal);
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await browserDocumentStore.readRange(path, offset, chunkLength);
        throwIfCanceled(options.signal);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) {
            break;
        }
    }

    return offset === size ? output : output.slice(0, offset);
}

function getDesktopDocumentsCapability(path: TDocumentRef) {
    if (typeof window === 'undefined') {
        return null;
    }

    const documents = (window as Window & {electronAPI?: { documents?: IDocumentsCapability };}).electronAPI?.documents;
    if (!documents) {
        throw new Error(`Browser document not found: ${path}`);
    }
    return documents;
}

async function readDesktopDocumentBytes(
    path: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    const documents = getDesktopDocumentsCapability(path);
    if (!documents) {
        return readBrowserDocumentBytes(path, options);
    }

    throwIfCanceled(options.signal);
    const { size } = await documents.statFile(path);
    throwIfCanceled(options.signal);
    if (size <= 0) {
        return new Uint8Array();
    }

    if (size <= DJVU_READ_CHUNK_BYTES) {
        const bytes = await documents.readFile(path);
        throwIfCanceled(options.signal);
        return bytes;
    }

    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        throwIfCanceled(options.signal);
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await documents.readFileRange(path, offset, chunkLength);
        throwIfCanceled(options.signal);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) {
            break;
        }
    }

    return offset === size ? output : output.slice(0, offset);
}

function throwIfCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error('DjVu conversion canceled');
    }
}

export async function createDjvuWorkerFromPath(
    djvuPath: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    const djvuGlobal = await loadDjvuJs();
    const worker = new djvuGlobal.Worker();
    const isBrowserRef = isBrowserDocumentRef(djvuPath);
    let abortHandler: (() => void) | null = null;

    try {
        if (options.signal) {
            abortHandler = () => {
                worker.terminate();
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }
        throwIfCanceled(options.signal);
        const bytes = isBrowserRef
            ? await readBrowserDocumentBytes(djvuPath, options)
            : await readDesktopDocumentBytes(djvuPath, options);
        throwIfCanceled(options.signal);
        const buffer = toOwnedArrayBuffer(bytes);

        await worker.createDocument(buffer, {});
        throwIfCanceled(options.signal);
    } catch (error) {
        worker.terminate();
        throw error;
    } finally {
        if (options.signal && abortHandler) {
            options.signal.removeEventListener('abort', abortHandler);
        }
        if (isBrowserRef) {
            browserDocumentStore.unload(djvuPath);
        }
    }

    return worker;
}
