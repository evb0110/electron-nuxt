import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDjvuCapability,
    IDjvuPagePreviewOptions,
} from '@contracts/electronApiDjvu';
import type { IDocumentsFileIoCapability } from '@contracts/electronApiDocuments';
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

type TDjvuDocumentFileReader = Pick<IDocumentsFileIoCapability, 'statFile' | 'readFile' | 'readFileRange'>;

interface IDjvuRenderedPageObjectUrl {
    objectUrl: string;
    renderedPx: number;
}

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

    const electronAPI = (window as Window & {electronAPI?: {
        documentFiles?: TDjvuDocumentFileReader;
        documents?: TDjvuDocumentFileReader;
    };}).electronAPI;
    const documentFiles = electronAPI?.documentFiles ?? electronAPI?.documents;
    if (!documentFiles) {
        throw new Error(`Browser document not found: ${path}`);
    }
    return documentFiles;
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

function loadImageElement(url: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to decode DjVu page preview'));
        image.src = url;
    });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
                return;
            }
            reject(new Error('Failed to encode scaled DjVu page preview'));
        }, 'image/png');
    });
}

async function scaleDjvuPageObjectUrl(
    pageObject: {
        url: string;
        width: number;
        height: number;
    },
    subsample: number | undefined,
    revokeSourceUrl: (url: string) => void,
): Promise<IDjvuRenderedPageObjectUrl> {
    const normalizedSubsample = Math.max(1, Math.trunc(subsample ?? 1));
    if (
        normalizedSubsample <= 1
        || typeof document === 'undefined'
        || typeof Image === 'undefined'
        || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function'
    ) {
        return {
            objectUrl: pageObject.url,
            renderedPx: pageObject.width,
        };
    }

    try {
        const targetWidth = Math.max(1, Math.round(pageObject.width / normalizedSubsample));
        const targetHeight = Math.max(1, Math.round(pageObject.height / normalizedSubsample));
        const image = await loadImageElement(pageObject.url);
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        if (!context) {
            return {
                objectUrl: pageObject.url,
                renderedPx: pageObject.width,
            };
        }

        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        const blob = await canvasToPngBlob(canvas);
        const scaledUrl = URL.createObjectURL(blob);
        revokeSourceUrl(pageObject.url);
        return {
            objectUrl: scaledUrl,
            renderedPx: targetWidth,
        };
    } catch {
        return {
            objectUrl: pageObject.url,
            renderedPx: pageObject.width,
        };
    }
}

export async function createDjvuPagePreviewSourceFromPath(djvuPath: TDocumentRef) {
    const nativeDjvu = getDesktopDjvuPreviewCapability(djvuPath);
    if (nativeDjvu) {
        return {
            getPageSizes: () => nativeDjvu.getPageSizes(djvuPath),
            async renderPageObjectUrl(
                pageNumber: number,
                options?: IDjvuPagePreviewOptions,
            ): Promise<IDjvuRenderedPageObjectUrl> {
                const preview = await nativeDjvu.renderPagePreview(djvuPath, pageNumber, options);
                return {
                    objectUrl: createPngObjectUrl(preview.bytes),
                    renderedPx: preview.width,
                };
            },
            revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
            terminate() {},
        };
    }

    const worker = await createDjvuWorkerFromPath(djvuPath);
    return {
        getPageSizes: (): Promise<IDjvuPageSize[]> => worker.doc.getPagesSizes().run(),
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IDjvuPagePreviewOptions,
        ): Promise<IDjvuRenderedPageObjectUrl> {
            const pageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            return scaleDjvuPageObjectUrl(
                pageObject,
                options?.subsample,
                url => worker.revokeObjectURL(url),
            );
        },
        revokeObjectURL: (url: string) => worker.revokeObjectURL(url),
        terminate: () => worker.terminate(),
    };
}
