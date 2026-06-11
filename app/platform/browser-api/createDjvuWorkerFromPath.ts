import type { TDocumentRef } from '@contracts/documentRef';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type { IDocumentsCapability } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    loadDjvuJs,
    type IDjvuPageSize,
} from '@app/platform/browser-api/djvujsLoader';

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

function getDesktopDjvuPreviewCapability(path: TDocumentRef) {
    if (isBrowserDocumentRef(path) || typeof window === 'undefined') {
        return null;
    }

    const djvu = (window as Window & {electronAPI?: { djvu?: IDjvuCapability };}).electronAPI?.djvu;
    if (typeof djvu?.getPageSizes !== 'function' || typeof djvu.renderPagePreview !== 'function') {
        return null;
    }
    return djvu;
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

function createPngObjectUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
}

export async function createDjvuPagePreviewSourceFromPath(djvuPath: TDocumentRef) {
    const nativeDjvu = getDesktopDjvuPreviewCapability(djvuPath);
    if (nativeDjvu) {
        return {
            getPageSizes: () => nativeDjvu.getPageSizes(djvuPath),
            async renderPageObjectUrl(pageNumber: number) {
                const preview = await nativeDjvu.renderPagePreview(djvuPath, pageNumber);
                return createPngObjectUrl(preview.bytes);
            },
            revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
            terminate() {},
        };
    }

    const worker = await createDjvuWorkerFromPath(djvuPath);
    return {
        getPageSizes: (): Promise<IDjvuPageSize[]> => worker.doc.getPagesSizes().run(),
        async renderPageObjectUrl(pageNumber: number) {
            const pageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            return pageObject.url;
        },
        revokeObjectURL: (url: string) => worker.revokeObjectURL(url),
        terminate: () => worker.terminate(),
    };
}
