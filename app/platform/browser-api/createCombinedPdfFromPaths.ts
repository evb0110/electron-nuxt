import type { PDFDocument } from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import {
    DEFAULT_TIFF_DECODE_LIMITS,
    iterateDecodedTiffFrames,
} from '@pdf-core/iterateDecodedTiffFrames';
import {
    applyCombinedPdfPageLabels,
    inspectPdfCombineCatalog,
    offsetPdfCombineBookmarks,
} from '@pdf-core/pdfCombineCatalog';
import type {IPdfCombinePageLabelRange} from '@pdf-core/pdfCombineCatalog';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
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
import { getBrowserDjvuBookmarksForCombine } from '@app/platform/browser-api/browserDjvuConversionPipeline';
import { emitBrowserOpenDocumentDirectBatchProgress } from '@app/platform/browser-api/documentsMenuCapability';
import type { TOpenBatchProgressOperation } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    readBrowserRasterImageMetadata,
    readBrowserTiffFrameDpi,
    resolveBrowserRasterIccProfile,
} from '@app/platform/browser-api/browserRasterImageMetadata';
import {embedPdfImageIccProfile} from '@app/platform/browser-api/embedPdfImageIccProfile';

export interface IBrowserBatchOpenProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface IBrowserBatchOpenProgressOptions {
    requestId?: string;
    operation?: TOpenBatchProgressOperation;
    onProgress?: (progress: IBrowserBatchOpenProgress) => void;
    signal?: AbortSignal;
}

function throwIfCombineAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
}

const BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES = 32 * 1024 * 1024;
const BROWSER_COMBINED_PDF_MAX_IMAGE_PIXELS = 80_000_000;
const BROWSER_COMBINED_PDF_MAX_PAGES = 500;
const BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const BROWSER_COMBINED_PDF_MAX_DECODED_WORKING_BYTES = 256 * 1024 * 1024;

interface IBrowserDecodedWorkingSetBudget {
    usedBytes: number;
    maxBytes: number;
}

export function consumeBrowserDecodedWorkingSet(
    budget: IBrowserDecodedWorkingSetBudget,
    width: number,
    height: number,
    fileName: string,
) {
    const decodedBytes = width * height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0 || budget.usedBytes > budget.maxBytes - decodedBytes) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_DECODED_WORKING_SET_TOO_LARGE:${fileName}`);
    }
    budget.usedBytes += decodedBytes;
}

export function assertBrowserCombinedPdfPageCount(pageCount: number) {
    if (pageCount > BROWSER_COMBINED_PDF_MAX_PAGES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
    }
}

export function assertBrowserCombinedPdfOutputBytes(bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength > BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT');
    }
}

function assertBrowserImageMetadata(fileName: string, bytes: Uint8Array) {
    const metadata = readBrowserRasterImageMetadata(bytes, getExtension(fileName));
    if (
        !metadata
        || metadata.width < 1
        || metadata.height < 1
        || metadata.width > BROWSER_COMBINED_PDF_MAX_IMAGE_PIXELS / metadata.height
    ) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_IMAGE_TOO_LARGE:${fileName}`);
    }
    return metadata;
}

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
    percentCap = 100,
) {
    const requestId = options?.requestId?.trim();
    const safeTotal = Math.max(total, 0);
    const safeProcessed = safeTotal > 0
        ? clamp(processed, 0, safeTotal)
        : 0;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const percent = safeTotal > 0
        ? (safeProcessed / safeTotal) * percentCap
        : percentCap;
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
        operation: options?.operation ?? 'document-open',
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

async function createBrowserPdfFromDjvuForCombine(path: string, signal?: AbortSignal) {
    throwIfCombineAborted(signal);
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
    const jobId = `browser-pdf-combine-djvu-${crypto.randomUUID()}`;
    const cancel = () => { void browserDjvuCapability.cancel(jobId); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        let result;
        try {
            result = await browserDjvuCapability.convertToPdf(
                path,
                outputRef,
                {
                    jobId,
                    pdfStrategy: 'compact-djvu-aware',
                    subsample: 2,
                    // The combine planner writes the extracted outline after
                    // compact conversion, keeping compact export enabled.
                    preserveBookmarks: false,
                },
            );
            throwIfCombineAborted(signal);
        } finally {
            signal?.removeEventListener('abort', cancel);
        }

        if (!result.success) {
            throw new Error(result.error ?? `Failed to convert DjVu file: ${fileName}`);
        }
        const bookmarks = await getBrowserDjvuBookmarksForCombine(path, signal);
        if (bookmarks.length > 0) {
            const {PDFDocument} = await import('pdf-lib');
            const convertedBytes = await browserDocumentStore.read(outputRef);
            const convertedPdf = await PDFDocument.load(convertedBytes);
            writePdfBookmarkOutlines(convertedPdf, bookmarks);
            await browserDocumentStore.write(outputRef, new Uint8Array(await convertedPdf.save()));
        }
        return outputRef;
    } catch (error) {
        await browserDocumentStore.remove(outputRef).catch(() => undefined);
        throw error;
    }
}

async function createBrowserCombineInputPaths(paths: string[], signal?: AbortSignal) {
    const convertedRefs: string[] = [];
    const combinePaths: string[] = [];

    try {
        for (let index = 0; index < paths.length; index += 1) {
            throwIfCombineAborted(signal);
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const fileName = getBrowserDocumentFileName(path);
            if (!isDjvuFileName(fileName)) {
                combinePaths.push(path);
                continue;
            }

            const convertedRef = await createBrowserPdfFromDjvuForCombine(path, signal);
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

    assertBrowserImageMetadata(fileName, bytes);

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
    decodedBudget: IBrowserDecodedWorkingSetBudget,
) {
    let addedPages = 0;

    for (const {
        frame,
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(bytes, {
            ...DEFAULT_TIFF_DECODE_LIMITS,
            sourceLabel: fileName,
        })) {
        consumeBrowserDecodedWorkingSet(decodedBudget, width, height, fileName);
        const pngBytes = await encodeRgbaToPngBytes(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image, {dpi: readBrowserTiffFrameDpi(frame)});
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
    decodedBudget: IBrowserDecodedWorkingSetBudget,
) {
    const extension = getExtension(fileName);
    if (extension === '.tif' || extension === '.tiff') {
        await embedTiffPages(pdfDocument, fileName, bytes, decodedBudget);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const metadata = assertBrowserImageMetadata(fileName, bytes);
        consumeBrowserDecodedWorkingSet(decodedBudget, metadata.width, metadata.height, fileName);
        const image = await pdfDocument.embedJpg(bytes);
        embedPdfImageIccProfile(pdfDocument, image, await resolveBrowserRasterIccProfile(metadata));
        appendPdfImagePage(pdfDocument, image, metadata);
        return;
    }

    const metadata = assertBrowserImageMetadata(fileName, bytes);
    consumeBrowserDecodedWorkingSet(decodedBudget, metadata.width, metadata.height, fileName);
    const pngBytes = await normalizeImageBytesToPng(fileName, bytes);
    const image = await pdfDocument.embedPng(pngBytes);
    embedPdfImageIccProfile(pdfDocument, image, await resolveBrowserRasterIccProfile(metadata));
    appendPdfImagePage(pdfDocument, image, metadata);
}

export async function createCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    throwIfCombineAborted(progressOptions?.signal);
    await ensureBrowserCombinedPdfInputBudget(paths);
    const {
        combinePaths,
        convertedRefs,
    } = await createBrowserCombineInputPaths(paths, progressOptions?.signal);
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
    throwIfCombineAborted(progressOptions?.signal);
    await ensureBrowserCombinedPdfRewriteBudget(paths);
    const startedAt = Date.now();
    const totalPaths = paths.length;

    if (canCombineBrowserPathsOffThread(paths) && canUseBrowserPdfCombineWorker()) {
        const inputs = [];

        for (let index = 0; index < paths.length; index += 1) {
            throwIfCombineAborted(progressOptions?.signal);
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const data = await browserDocumentStore.read(path);
            inputs.push(cloneCombineWorkerInput(
                getBrowserDocumentFileName(path),
                data,
            ));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt, 80);
        }

        try {
            const result = await runBrowserPdfCombineWorkerRequest(
                'combinePdfs',
                { inputs },
                progressOptions?.signal,
            );
            emitBatchOpenProgress(progressOptions, totalPaths, totalPaths, startedAt, 95);
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
    const sourceOutlines: IPdfBookmarkEntry[] = [];
    const pageLabelRanges: IPdfCombinePageLabelRange[] = [];
    const decodedBudget: IBrowserDecodedWorkingSetBudget = {
        usedBytes: 0,
        maxBytes: BROWSER_COMBINED_PDF_MAX_DECODED_WORKING_BYTES,
    };

    for (let index = 0; index < paths.length; index += 1) {
        throwIfCombineAborted(progressOptions?.signal);
        if (index > 0) {
            await yieldToBrowser();
        }

        const path = paths[index]!;
        const bytes = await browserDocumentStore.read(path);
        const fileName = getBrowserDocumentFileName(path);
        const firstPageIndex = pdfDocument.getPageCount();
        if (isPdfFileName(fileName)) {
            const sourcePdf = await PDFDocument.load(bytes);
            const catalog = inspectPdfCombineCatalog(sourcePdf);
            const copiedPages = await pdfDocument.copyPages(
                sourcePdf,
                sourcePdf.getPageIndices(),
            );
            copiedPages.forEach((page) => pdfDocument.addPage(page));
            assertBrowserCombinedPdfPageCount(pdfDocument.getPageCount());
            sourceOutlines.push({
                title: fileName,
                pageIndex: firstPageIndex,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: offsetPdfCombineBookmarks(catalog.bookmarks, firstPageIndex),
            });
            pageLabelRanges.push(...catalog.pageLabels.map(range => ({
                ...range,
                pageIndex: firstPageIndex + range.pageIndex,
            })));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt, 90);
            continue;
        }

        await embedImagePage(pdfDocument, fileName, bytes, decodedBudget);
        assertBrowserCombinedPdfPageCount(pdfDocument.getPageCount());
        sourceOutlines.push({
            title: fileName,
            pageIndex: firstPageIndex,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        });
        emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt, 90);
    }

    await yieldToBrowser();
    writePdfBookmarkOutlines(pdfDocument, sourceOutlines);
    applyCombinedPdfPageLabels(pdfDocument, pageLabelRanges);
    const result = new Uint8Array(await pdfDocument.save());
    assertBrowserCombinedPdfOutputBytes(result);
    emitBatchOpenProgress(progressOptions, totalPaths, totalPaths, startedAt, 95);
    return result;
}
