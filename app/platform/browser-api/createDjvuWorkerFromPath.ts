import type { TDocumentRef } from '@contracts/documentRef';
import type { IDjvuPagePreviewOptions } from '@contracts/electronApiDjvu';
import {
    assertDocumentAllocationSize,
    type IDocumentsFileIoCapability,
} from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    loadDjvuJs,
    type IDjvuPageSize,
} from '@app/platform/browser-api/djvujsLoader';
import { getValidatedElectronPlatformApi } from '@app/utils/electronPlatformBridge';

const DJVU_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES = 96 * 1024 * 1024;

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

    const output = new Uint8Array(assertDocumentAllocationSize(size));
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
    const platform = getValidatedElectronPlatformApi();
    if (!platform) {
        return null;
    }

    const documentFiles = platform.documentFiles ?? platform.documents;
    if (!documentFiles) {
        throw new Error(`Browser document not found: ${path}`);
    }
    return documentFiles satisfies TDjvuDocumentFileReader;
}

function getDesktopDjvuPreviewCapability(path: TDocumentRef) {
    if (isBrowserDocumentRef(path)) {
        return null;
    }

    const djvu = getValidatedElectronPlatformApi()?.djvu;
    if (
        typeof djvu?.getPageSizes !== 'function'
        || typeof djvu.renderPagePreview !== 'function'
        || typeof djvu.cancelPagePreview !== 'function'
    ) {
        return null;
    }
    return djvu;
}

async function shouldUseNativeDesktopDjvuPreview(path: TDocumentRef) {
    const nativeDjvu = getDesktopDjvuPreviewCapability(path);
    if (!nativeDjvu) {
        return null;
    }

    try {
        const documents = getDesktopDocumentsCapability(path);
        if (!documents) {
            return nativeDjvu;
        }

        const { size } = await documents.statFile(path);
        return size > DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES ? nativeDjvu : null;
    } catch {
        return nativeDjvu;
    }
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

    const output = new Uint8Array(assertDocumentAllocationSize(size));
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

function resolveScaledDjvuTargetWidth(
    pageObject: {width: number;},
    subsample: number | undefined,
    targetWidthPx: number | undefined,
) {
    if (Number.isFinite(targetWidthPx) && targetWidthPx !== undefined && targetWidthPx > 0) {
        return Math.max(1, Math.round(targetWidthPx));
    }
    const normalizedSubsample = Math.max(1, Math.trunc(subsample ?? 1));
    return Math.max(1, Math.round(pageObject.width / normalizedSubsample));
}

async function scaleDjvuPageObjectUrl(
    pageObject: {
        url: string;
        width: number;
        height: number;
    },
    subsample: number | undefined,
    targetWidthPx: number | undefined,
    revokeSourceUrl: (url: string) => void,
    registerWindowObjectUrl?: (url: string) => void,
): Promise<IDjvuRenderedPageObjectUrl> {
    const targetWidth = resolveScaledDjvuTargetWidth(pageObject, subsample, targetWidthPx);
    const targetHeight = Math.max(1, Math.round(targetWidth * pageObject.height / pageObject.width));
    if (
        targetWidth === pageObject.width
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

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        const blob = await canvasToPngBlob(canvas);
        const scaledUrl = URL.createObjectURL(blob);
        registerWindowObjectUrl?.(scaledUrl);
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
    const nativeDjvu = await shouldUseNativeDesktopDjvuPreview(djvuPath);
    if (nativeDjvu) {
        let terminated = false;
        let nextPreviewRequestId = 0;
        const activePreviewRequestIds = new Set<string>();
        const activePreviewRequestIdsByPage = new Map<number, string>();
        const cancelPreviewRequest = (requestId: string) => {
            void nativeDjvu.cancelPagePreview(requestId).catch(() => undefined);
        };
        const createPreviewRequestId = (
            pageNumber: number,
            options: IDjvuPagePreviewOptions | undefined,
        ) => {
            const requestId = options?.previewRequestId?.trim();
            if (requestId) {
                return requestId;
            }
            nextPreviewRequestId += 1;
            return `native-preview:${pageNumber}:${nextPreviewRequestId}`;
        };
        return {
            cancelPagePreview(pageNumber: number) {
                const requestId = activePreviewRequestIdsByPage.get(pageNumber);
                if (!requestId) {
                    return;
                }
                activePreviewRequestIdsByPage.delete(pageNumber);
                activePreviewRequestIds.delete(requestId);
                cancelPreviewRequest(requestId);
            },
            getPageSizes: () => nativeDjvu.getPageSizes(djvuPath),
            async renderPageObjectUrl(
                pageNumber: number,
                options?: IDjvuPagePreviewOptions,
            ): Promise<IDjvuRenderedPageObjectUrl> {
                if (terminated) {
                    throw new Error('DjVu conversion canceled');
                }
                const previewRequestId = createPreviewRequestId(pageNumber, options);
                const previousRequestId = activePreviewRequestIdsByPage.get(pageNumber);
                if (previousRequestId && previousRequestId !== previewRequestId) {
                    cancelPreviewRequest(previousRequestId);
                }
                activePreviewRequestIds.add(previewRequestId);
                activePreviewRequestIdsByPage.set(pageNumber, previewRequestId);
                const renderOptions: IDjvuPagePreviewOptions = {
                    ...options,
                    previewRequestId,
                };
                let preview;
                try {
                    preview = await nativeDjvu.renderPagePreview(djvuPath, pageNumber, renderOptions);
                } finally {
                    activePreviewRequestIds.delete(previewRequestId);
                    if (activePreviewRequestIdsByPage.get(pageNumber) === previewRequestId) {
                        activePreviewRequestIdsByPage.delete(pageNumber);
                    }
                }
                if (terminated) {
                    throw new Error('DjVu conversion canceled');
                }
                return {
                    objectUrl: createPngObjectUrl(preview.bytes),
                    renderedPx: preview.width,
                };
            },
            revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
            terminate() {
                terminated = true;
                for (const requestId of activePreviewRequestIds) {
                    cancelPreviewRequest(requestId);
                }
                activePreviewRequestIds.clear();
                activePreviewRequestIdsByPage.clear();
            },
        };
    }

    const worker = await createDjvuWorkerFromPath(djvuPath);
    let terminated = false;
    let nextPreviewRequestId = 0;
    let fallbackRenderQueue = Promise.resolve();
    const latestPreviewRequestIdsByPage = new Map<number, string>();
    const fallbackWindowObjectUrls = new Set<string>();

    const registerFallbackWindowObjectUrl = (url: string) => {
        fallbackWindowObjectUrls.add(url);
    };

    const revokeFallbackObjectUrl = (url: string) => {
        if (fallbackWindowObjectUrls.delete(url)) {
            if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(url);
            }
            return;
        }

        worker.revokeObjectURL(url);
    };

    const createFallbackPreviewRequestId = (
        pageNumber: number,
        options: IDjvuPagePreviewOptions | undefined,
    ) => {
        const requestId = options?.previewRequestId?.trim();
        if (requestId) {
            return requestId;
        }
        nextPreviewRequestId += 1;
        return `browser-preview:${pageNumber}:${nextPreviewRequestId}`;
    };

    const enqueueFallbackRender = async <T>(render: () => Promise<T>) => {
        const previousRender = fallbackRenderQueue;
        let releaseRender: () => void = () => undefined;
        fallbackRenderQueue = new Promise<void>((resolve) => {
            releaseRender = () => resolve();
        });
        await previousRender.catch(() => undefined);
        try {
            return await render();
        } finally {
            releaseRender();
        }
    };

    const throwIfFallbackRenderCanceled = (pageNumber: number, previewRequestId: string) => {
        if (
            terminated
            || latestPreviewRequestIdsByPage.get(pageNumber) !== previewRequestId
        ) {
            throw new Error('DjVu conversion canceled');
        }
    };

    return {
        cancelPagePreview(pageNumber: number) {
            latestPreviewRequestIdsByPage.delete(pageNumber);
        },
        getPageSizes: (): Promise<IDjvuPageSize[]> => worker.doc.getPagesSizes().run(),
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IDjvuPagePreviewOptions,
        ): Promise<IDjvuRenderedPageObjectUrl> {
            if (terminated) {
                throw new Error('DjVu conversion canceled');
            }
            const previewRequestId = createFallbackPreviewRequestId(pageNumber, options);
            latestPreviewRequestIdsByPage.set(pageNumber, previewRequestId);
            const pageObject = await enqueueFallbackRender(async () => {
                throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                const renderedPageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
                try {
                    throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                    return renderedPageObject;
                } catch (error) {
                    revokeFallbackObjectUrl(renderedPageObject.url);
                    throw error;
                }
            });
            let renderedPageObjectUrl: IDjvuRenderedPageObjectUrl | null = null;

            try {
                renderedPageObjectUrl = await scaleDjvuPageObjectUrl(
                    pageObject,
                    options?.subsample,
                    options?.targetWidthPx,
                    revokeFallbackObjectUrl,
                    registerFallbackWindowObjectUrl,
                );
                throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                return renderedPageObjectUrl;
            } catch (error) {
                revokeFallbackObjectUrl(renderedPageObjectUrl?.objectUrl ?? pageObject.url);
                throw error;
            }
        },
        revokeObjectURL: revokeFallbackObjectUrl,
        terminate() {
            terminated = true;
            latestPreviewRequestIdsByPage.clear();
            for (const url of fallbackWindowObjectUrls) {
                if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(url);
                }
            }
            fallbackWindowObjectUrls.clear();
            worker.terminate();
        },
    };
}
