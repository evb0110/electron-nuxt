import type { PDFDocument } from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import { iterateDecodedTiffFrames } from '@pdf-core';
import {
    ensurePdfExtension,
    getExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    buildBrowserByteLimitError,
    toBrowserOwnedArrayBuffer,
} from '@app/platform/browser-api/browserPlatformHelpers';
import { appendPdfImagePage } from '@app/platform/browser-api/appendPdfImagePage';
import {
    BrowserPdfCombineWorkerUnavailableError,
    canUseBrowserPdfCombineWorker,
    cloneCombineWorkerInput,
    runBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { browserDjvuCapability } from '@app/platform/browser-api/browserDjvuCapability';
import { emitBrowserOpenDocumentDirectBatchProgress } from '@app/platform/browser-api/documentsMenuCapability';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';

export interface IBrowserBatchOpenProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface IBrowserBatchOpenProgressOptions {
    requestId?: string;
    onProgress?: (progress: IBrowserBatchOpenProgress) => void;
}

const BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES = 32 * 1024 * 1024;

function buildBrowserLargeJobError(label: string, maxBytes: number) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
    );
}

function emitBatchOpenProgress(
    options: IBrowserBatchOpenProgressOptions | undefined,
    processed: number,
    total: number,
    startedAt: number,
) {
    const requestId = options?.requestId?.trim();
    const safeTotal = Math.max(total, 0);
    const safeProcessed = safeTotal > 0
        ? clamp(processed, 0, safeTotal)
        : 0;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const percent = safeTotal > 0
        ? (safeProcessed / safeTotal) * 100
        : 100;
    const estimatedRemainingMs = safeProcessed > 0 && safeProcessed < safeTotal
        ? Math.max(
            0,
            Math.round((elapsedMs / safeProcessed) * (safeTotal - safeProcessed)),
        )
        : null;
    const progress = {
        processed: safeProcessed,
        total: safeTotal,
        percent,
        elapsedMs,
        estimatedRemainingMs,
    };

    options?.onProgress?.(progress);

    if (!requestId) {
        return;
    }

    emitBrowserOpenDocumentDirectBatchProgress({
        requestId,
        ...progress,
    });
}

async function ensureBrowserCombinedPdfBudget(paths: string[], maxBytes: number) {
    let totalBytes = 0;

    for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
            await yieldToBrowser();
        }

        const { size } = await browserDocumentStore.stat(paths[index]!);
        totalBytes += size;
        if (totalBytes > maxBytes) {
            throw buildBrowserLargeJobError(
                'Combining documents',
                maxBytes,
            );
        }
    }
}

async function ensureBrowserCombinedPdfInputBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES);
}

async function ensureBrowserCombinedPdfRewriteBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES);
}

function canCombineBrowserPathsOffThread(paths: string[]) {
    return paths.length > 0 && paths.every((path) => {
        const fileName = getBrowserDocumentFileName(path);
        return isPdfFileName(fileName) || BROWSER_COMBINE_IMAGE_EXTENSIONS.has(getExtension(fileName));
    });
}

async function createBrowserPdfFromDjvuForCombine(path: string) {
    const fileName = getBrowserDocumentFileName(path);
    const outputName = ensurePdfExtension(fileName.replace(/\.[^.]+$/u, ''));
    const outputRef = await browserDocumentStore.createStoredDocument(
        outputName,
        new Uint8Array(),
        {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'output',
            retention: 'transient',
        },
    );
    const result = await browserDjvuCapability.convertToPdf(
        path,
        outputRef,
        {
            subsample: 1,
            preserveBookmarks: true,
        },
    );

    if (!result.success) {
        await browserDocumentStore.remove(outputRef).catch(() => undefined);
        throw new Error(result.error ?? `Failed to convert DjVu file: ${fileName}`);
    }

    return outputRef;
}

async function createBrowserCombineInputPaths(paths: string[]) {
    const convertedRefs: string[] = [];
    const combinePaths: string[] = [];

    try {
        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const fileName = getBrowserDocumentFileName(path);
            if (!isDjvuFileName(fileName)) {
                combinePaths.push(path);
                continue;
            }

            const convertedRef = await createBrowserPdfFromDjvuForCombine(path);
            convertedRefs.push(convertedRef);
            combinePaths.push(convertedRef);
        }

        return {
            combinePaths,
            convertedRefs,
        };
    } catch (error) {
        await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        throw error;
    }
}

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

async function canvasToPngBytes(canvas: HTMLCanvasElement) {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
            if (!nextBlob) {
                reject(new Error('Failed to convert image to PNG'));
                return;
            }

            resolve(nextBlob);
        }, 'image/png');
    });

    return new Uint8Array(await pngBlob.arrayBuffer());
}

async function normalizeImageBytesToPng(fileName: string, bytes: Uint8Array) {
    const extension = getExtension(fileName);
    if (extension === '.png') {
        return bytes;
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error(
            `Image format is not available in the current browser runtime: ${fileName}`,
        );
    }

    const blob = new Blob([toBrowserOwnedArrayBuffer(bytes)]);
    const objectUrl = URL.createObjectURL(blob);

    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const nextImage = new Image();
            nextImage.onload = () => resolve(nextImage);
            nextImage.onerror = () =>
                reject(new Error(`Failed to load image: ${fileName}`));
            nextImage.src = objectUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        context.drawImage(image, 0, 0);
        try {
            return await canvasToPngBytes(canvas);
        } finally {
            releaseCanvas(canvas);
        }
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function createClampedImageData(rgba: Uint8Array, width: number, height: number) {
    if (typeof ImageData === 'undefined') {
        throw new Error('ImageData is unavailable in the current browser runtime');
    }

    const clamped = new Uint8ClampedArray(rgba.byteLength);
    clamped.set(rgba);
    return new ImageData(clamped, width, height);
}

async function encodeRgbaToPngBytes(
    width: number,
    height: number,
    rgba: Uint8Array,
) {
    if (typeof document === 'undefined') {
        throw new Error('Canvas 2D context is unavailable');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    context.putImageData(createClampedImageData(rgba, width, height), 0, 0);
    try {
        return await canvasToPngBytes(canvas);
    } finally {
        releaseCanvas(canvas);
    }
}

async function embedTiffPages(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    let addedPages = 0;

    for (const {
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(bytes)) {
        const pngBytes = await encodeRgbaToPngBytes(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image);
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`Failed to decode TIFF image: ${fileName}`);
    }
}

async function embedImagePage(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    const extension = getExtension(fileName);
    if (extension === '.tif' || extension === '.tiff') {
        await embedTiffPages(pdfDocument, fileName, bytes);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(bytes);
        appendPdfImagePage(pdfDocument, image);
        return;
    }

    const pngBytes = await normalizeImageBytesToPng(fileName, bytes);
    const image = await pdfDocument.embedPng(pngBytes);
    appendPdfImagePage(pdfDocument, image);
}

export async function createCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    await ensureBrowserCombinedPdfInputBudget(paths);
    const {
        combinePaths,
        convertedRefs,
    } = await createBrowserCombineInputPaths(paths);
    try {
        return await createCombinedPdfFromPreparedPaths(combinePaths, progressOptions);
    } finally {
        if (convertedRefs.length > 0) {
            await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        }
    }
}

async function createCombinedPdfFromPreparedPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    await ensureBrowserCombinedPdfRewriteBudget(paths);
    const startedAt = Date.now();
    const totalPaths = paths.length;

    if (canCombineBrowserPathsOffThread(paths) && canUseBrowserPdfCombineWorker()) {
        const inputs = [];

        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const data = await browserDocumentStore.read(path);
            inputs.push(cloneCombineWorkerInput(
                getBrowserDocumentFileName(path),
                data,
            ));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
        }

        try {
            const result = await runBrowserPdfCombineWorkerRequest('combinePdfs', { inputs });
            emitBatchOpenProgress(progressOptions, totalPaths, totalPaths, startedAt);
            return result.data;
        } catch (error) {
            if (
                !(error instanceof BrowserPdfCombineWorkerUnavailableError)
                && !(
                    error instanceof Error
                    && (
                        error.message === 'ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME'
                        || error.message.startsWith('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:')
                    )
                )
            ) {
                throw error;
            }
        }
    }

    const { PDFDocument } = await import('pdf-lib');
    const pdfDocument = await PDFDocument.create();

    for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
            await yieldToBrowser();
        }

        const path = paths[index]!;
        const bytes = await browserDocumentStore.read(path);
        const fileName = getBrowserDocumentFileName(path);
        if (isPdfFileName(fileName)) {
            const sourcePdf = await PDFDocument.load(bytes);
            const copiedPages = await pdfDocument.copyPages(
                sourcePdf,
                sourcePdf.getPageIndices(),
            );
            copiedPages.forEach((page) => pdfDocument.addPage(page));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
            continue;
        }

        await embedImagePage(pdfDocument, fileName, bytes);
        emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
    }

    await yieldToBrowser();
    return new Uint8Array(await pdfDocument.save());
}
