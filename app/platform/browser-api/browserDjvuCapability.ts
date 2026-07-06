import { uniq } from 'es-toolkit/array';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IDjvuCapability,
    IDjvuConvertOptions,
    IDjvuInfo,
    IDjvuProgress,
    IDjvuSizeEstimate,
    IDjvuViewingErrorEvent,
    IDjvuViewingReadyEvent,
} from '@contracts/electronApiDjvu';
import {
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import type { IBrowserPdfCombineWasmPageSpec } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import type {
    IDjvuContentsItem,
    IDjvuImageData,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';
import { createDjvuWorkerFromPath } from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { decodeBrowserImageBlob } from '@app/platform/browser-api/decodeBrowserImageBlob';
import { StreamingImagePdfWriter } from '@app/platform/browser-api/streamingImagePdfWriter';
import type { IStreamingPdfSink } from '@app/platform/browser-api/streamingImagePdfWriter';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { BrowserLogger } from '@app/utils/browserLogger';
import { tryCombineImageInputsWithWasm } from '@app/platform/browser-api/tryCombineImageInputsWithWasm';

const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
const DJVU_BROWSER_DIRECT_PDF_JPEG_QUALITY = 0.92;
const DJVU_BROWSER_COMPACT_PHOTO_PDF_JPEG_QUALITY = 85;
const DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP = 300;
const DJVU_BROWSER_PDF_RENDER_WORKER_LIMIT = 3;
const DJVU_BROWSER_PDF_MEDIUM_PAGE_PIXEL_COUNT = 16_000_000;
const DJVU_BROWSER_PDF_LARGE_PAGE_PIXEL_COUNT = 32_000_000;
const DJVU_INFO_TEXT_SAMPLE_PAGES = 3;
const DJVU_ESTIMATE_SAMPLE_PAGES = 3;

class DjvuCanceledError extends Error {
    constructor() {
        super('DjVu conversion canceled');
        this.name = 'DjvuCanceledError';
    }
}

interface IDjvuJobRecord {
    workers: Set<IDjvuWorker>;
    abortController: AbortController;
}

interface IRenderedDjvuPage {
    bytes: Uint8Array;
    width: number;
    height: number;
    dpi: number;
}

interface IDjvuPageMetrics {
    width?: number;
    height?: number;
    dpi: number;
}

export interface IBrowserDjvuPdfRenderSettings {
    strategy: 'direct' | 'compact-djvu-aware';
    subsample: number;
    jpegQuality: number;
}

interface IBrowserDjvuRenderTaskSuccess {
    pageNumber: number;
    pageData: IRenderedDjvuPage;
    worker: IDjvuWorker;
}

interface IBrowserDjvuRenderTaskFailure {
    pageNumber: number;
    error: unknown;
    worker: IDjvuWorker;
}

type TBrowserDjvuRenderTaskResult =
    | IBrowserDjvuRenderTaskSuccess
    | IBrowserDjvuRenderTaskFailure;

interface IBrowserDjvuRenderTask {
    pageNumber: number;
    promise: Promise<TBrowserDjvuRenderTaskResult>;
}

const progressListeners = new Set<(progress: IDjvuProgress) => void>();
const viewingReadyListeners =
    new Set<(event: IDjvuViewingReadyEvent) => void>();
const viewingErrorListeners =
    new Set<(event: IDjvuViewingErrorEvent) => void>();
const activeJobs = new Map<string, IDjvuJobRecord>();
type TDjvuCanvas = OffscreenCanvas | HTMLCanvasElement;

function emitProgress(progress: IDjvuProgress) {
    progressListeners.forEach((listener) => {
        listener(progress);
    });
}

function createDjvuJob(jobId: string, worker: IDjvuWorker | null = null) {
    const abortController = new AbortController();
    activeJobs.set(jobId, {
        workers: worker ? new Set([worker]) : new Set(),
        abortController,
    });
    return abortController;
}

function attachDjvuJobWorker(jobId: string, worker: IDjvuWorker) {
    const job = activeJobs.get(jobId);
    if (!job) {
        worker.terminate();
        throw new DjvuCanceledError();
    }
    if (job.abortController.signal.aborted) {
        worker.terminate();
        throw new DjvuCanceledError();
    }
    job.workers.add(worker);
}

function cleanupDjvuJob(jobId: string) {
    const job = activeJobs.get(jobId);
    if (!job) {
        return;
    }

    activeJobs.delete(jobId);
    for (const worker of job.workers) {
        try {
            worker.terminate();
        } catch (error) {
            BrowserLogger.warn('djvu-browser', 'Failed to terminate DjVu worker', {
                jobId,
                error,
            });
        }
    }
}

function throwIfCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DjvuCanceledError();
    }
}

async function withDjvuWorker<T>(
    djvuPath: TDocumentRef,
    run: (worker: IDjvuWorker) => Promise<T>,
) {
    const worker = await createDjvuWorkerFromPath(djvuPath);
    try {
        return await run(worker);
    } finally {
        worker.terminate();
    }
}

function createCanvas(width: number, height: number) {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }

    if (typeof document === 'undefined') {
        throw new Error('Canvas is unavailable in the current runtime');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function getCanvas2dContext(
    canvas: TDjvuCanvas,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
        return canvas.getContext('2d');
    }

    return canvas.getContext('2d');
}

function createImageDataFromTransfer(imageData: IDjvuImageData) {
    return new ImageData(
        new Uint8ClampedArray(imageData.buffer),
        imageData.width,
        imageData.height,
    );
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

async function canvasToImageBytes(
    canvas: TDjvuCanvas,
    type: 'image/jpeg' | 'image/png',
    quality?: number,
) {
    if (
        typeof OffscreenCanvas !== 'undefined'
        && canvas instanceof OffscreenCanvas
    ) {
        const encodeOptions: ImageEncodeOptions = {type};
        if (quality !== undefined) {
            encodeOptions.quality = quality;
        }
        const blob = await canvas.convertToBlob(encodeOptions);
        return new Uint8Array(await blob.arrayBuffer());
    }

    const htmlCanvas = canvas as HTMLCanvasElement;
    const blob = await new Promise<Blob>((resolve, reject) => {
        htmlCanvas.toBlob((nextBlob: Blob | null) => {
            if (!nextBlob) {
                reject(new Error(`Failed to encode canvas as ${type}`));
                return;
            }
            resolve(nextBlob);
        }, type, quality);
    });

    return new Uint8Array(await blob.arrayBuffer());
}

async function fetchObjectUrlBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to read DjVu page image: ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

async function loadBitmapFromBytes(bytes: Uint8Array) {
    const blob = new Blob([toOwnedArrayBuffer(bytes)], { type: 'image/png' });

    return decodeBrowserImageBlob(blob, { fallbackErrorMessage: 'Failed to decode DjVu page image' });
}

function releaseCanvas(canvas: TDjvuCanvas) {
    canvas.width = 0;
    canvas.height = 0;
}

export function resolveBrowserDjvuPdfRenderSettings(
    options: Pick<IDjvuConvertOptions, 'pdfStrategy' | 'subsample'>,
): IBrowserDjvuPdfRenderSettings {
    const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
    const requestedSubsample = normalizeDjvuPdfSubsample(options.subsample);

    if (strategy === 'compact-djvu-aware') {
        return {
            strategy,
            subsample: requestedSubsample,
            jpegQuality: DJVU_BROWSER_COMPACT_PHOTO_PDF_JPEG_QUALITY,
        };
    }

    return {
        strategy,
        subsample: requestedSubsample,
        jpegQuality: DJVU_BROWSER_DIRECT_PDF_JPEG_QUALITY,
    };
}

export function resolveBrowserDjvuPdfRenderConcurrency(
    pageSizes: ReadonlyArray<Pick<IDjvuPageMetrics, 'width' | 'height'>>,
    hardwareConcurrency = typeof navigator === 'undefined'
        ? undefined
        : navigator.hardwareConcurrency,
) {
    const pageCount = Math.max(1, pageSizes.length);
    const normalizedHardwareConcurrency =
        typeof hardwareConcurrency === 'number'
        && Number.isFinite(hardwareConcurrency)
        && hardwareConcurrency > 0
            ? Math.trunc(hardwareConcurrency)
            : 2;
    const hardwareWorkerCount = Math.max(
        1,
        Math.floor(normalizedHardwareConcurrency / 2),
    );
    const maxPagePixels = pageSizes.reduce((maxPixels, size) => {
        const width = typeof size.width === 'number' && Number.isFinite(size.width)
            ? Math.max(0, Math.trunc(size.width))
            : 0;
        const height = typeof size.height === 'number' && Number.isFinite(size.height)
            ? Math.max(0, Math.trunc(size.height))
            : 0;
        return Math.max(maxPixels, width * height);
    }, 0);
    const pixelWorkerLimit = maxPagePixels >= DJVU_BROWSER_PDF_LARGE_PAGE_PIXEL_COUNT
        ? 1
        : maxPagePixels >= DJVU_BROWSER_PDF_MEDIUM_PAGE_PIXEL_COUNT
            ? 2
            : DJVU_BROWSER_PDF_RENDER_WORKER_LIMIT;

    return Math.min(
        pageCount,
        DJVU_BROWSER_PDF_RENDER_WORKER_LIMIT,
        pixelWorkerLimit,
        hardwareWorkerCount,
    );
}

async function renderDjvuPageFromImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfCanceled(signal);
    const imageData = await worker.doc.getPage(pageNumber).getImageData().run();
    throwIfCanceled(signal);
    const targetWidth = Math.max(1, Math.round(imageData.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(imageData.height / Math.max(1, subsample)));
    const sourceCanvas = createCanvas(imageData.width, imageData.height);
    const targetCanvas = targetWidth === imageData.width && targetHeight === imageData.height
        ? sourceCanvas
        : createCanvas(targetWidth, targetHeight);

    try {
        const sourceContext = getCanvas2dContext(sourceCanvas);
        if (!sourceContext) {
            throw new Error('Canvas 2D context is unavailable');
        }

        sourceContext.putImageData(createImageDataFromTransfer(imageData), 0, 0);

        const targetContext = getCanvas2dContext(targetCanvas);
        if (!targetContext) {
            throw new Error('Canvas 2D context is unavailable');
        }

        if (targetCanvas !== sourceCanvas) {
            targetContext.fillStyle = '#ffffff';
            targetContext.fillRect(0, 0, targetWidth, targetHeight);
            targetContext.drawImage(
                sourceCanvas,
                0,
                0,
                targetWidth,
                targetHeight,
            );
        }

        const bytes = await canvasToImageBytes(
            targetCanvas,
            'image/jpeg',
            jpegQuality,
        );
        throwIfCanceled(signal);

        return {
            bytes,
            width: targetWidth,
            height: targetHeight,
            dpi: Math.max(1, Math.round(pageDpi / subsample)),
        };
    } finally {
        releaseCanvas(targetCanvas);
        if (targetCanvas !== sourceCanvas) {
            releaseCanvas(sourceCanvas);
        }
    }
}

async function renderDjvuPageFromPngObject(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfCanceled(signal);
    const pngObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
    throwIfCanceled(signal);
    const targetWidth = Math.max(1, Math.round(pngObject.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(pngObject.height / Math.max(1, subsample)));
    const canvas = createCanvas(targetWidth, targetHeight);

    try {
        const context = getCanvas2dContext(canvas);
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        const pngBytes = await fetchObjectUrlBytes(pngObject.url);
        throwIfCanceled(signal);
        const bitmap = await loadBitmapFromBytes(pngBytes);
        throwIfCanceled(signal);
        try {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, targetWidth, targetHeight);
            context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } finally {
            if ('close' in bitmap && typeof bitmap.close === 'function') {
                bitmap.close();
            }
        }

        const bytes = await canvasToImageBytes(
            canvas,
            'image/jpeg',
            jpegQuality,
        );
        throwIfCanceled(signal);

        return {
            bytes,
            width: targetWidth,
            height: targetHeight,
            dpi: Math.max(1, Math.round(pageDpi / subsample)),
        };
    } finally {
        worker.revokeObjectURL(pngObject.url);
        releaseCanvas(canvas);
    }
}

async function renderDjvuPage(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    try {
        return await renderDjvuPageFromImageData(
            worker,
            pageNumber,
            pageDpi,
            subsample,
            jpegQuality,
            signal,
        );
    } catch (error) {
        if (error instanceof DjvuCanceledError) {
            throw error;
        }

        BrowserLogger.debug('djvu-browser', 'Falling back to PNG DjVu page rendering', {
            pageNumber,
            error,
        });
        return renderDjvuPageFromPngObject(
            worker,
            pageNumber,
            pageDpi,
            subsample,
            jpegQuality,
            signal,
        );
    }
}

interface IRenderedDjvuPpmPage {
    input: {
        fileName: string;
        data: Uint8Array;
    };
    pageSize: {
        widthPoints: number;
        heightPoints: number;
    };
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

function compactPhotoTargetSize(pageSize: IDjvuPageMetrics) {
    const width = positiveInteger(pageSize.width) ?? 1;
    const height = positiveInteger(pageSize.height) ?? 1;
    const dpi = positiveInteger(pageSize.dpi) ?? DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP;
    const scale = Math.max(1, dpi / DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP);
    return {
        height: Math.max(1, Math.round(height / scale)),
        width: Math.max(1, Math.round(width / scale)),
    };
}

function positiveInteger(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function rgbaToPpmBytes(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array) {
    const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const pixels = new Uint8Array(width * height * 3);
    for (let sourceOffset = 0, targetOffset = 0; targetOffset < pixels.byteLength; sourceOffset += 4, targetOffset += 3) {
        const alpha = (rgba[sourceOffset + 3] ?? 255) / 255;
        pixels[targetOffset] = Math.round((rgba[sourceOffset] ?? 255) * alpha + 255 * (1 - alpha));
        pixels[targetOffset + 1] = Math.round((rgba[sourceOffset + 1] ?? 255) * alpha + 255 * (1 - alpha));
        pixels[targetOffset + 2] = Math.round((rgba[sourceOffset + 2] ?? 255) * alpha + 255 * (1 - alpha));
    }
    const output = new Uint8Array(header.byteLength + pixels.byteLength);
    output.set(header, 0);
    output.set(pixels, header.byteLength);
    return output;
}

function canvasImageDataToPpm(canvas: TDjvuCanvas, width: number, height: number) {
    const context = getCanvas2dContext(canvas);
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }
    return rgbaToPpmBytes(width, height, context.getImageData(0, 0, width, height).data);
}

async function renderDjvuPageAsPpmFromImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    targetHeight: number,
    signal?: AbortSignal,
) {
    throwIfCanceled(signal);
    const imageData = await worker.doc.getPage(pageNumber).getImageData().run();
    throwIfCanceled(signal);
    if (imageData.width === targetWidth && imageData.height === targetHeight) {
        return rgbaToPpmBytes(
            imageData.width,
            imageData.height,
            new Uint8Array(imageData.buffer),
        );
    }

    const sourceCanvas = createCanvas(imageData.width, imageData.height);
    const targetCanvas = createCanvas(targetWidth, targetHeight);
    try {
        const sourceContext = getCanvas2dContext(sourceCanvas);
        const targetContext = getCanvas2dContext(targetCanvas);
        if (!sourceContext || !targetContext) {
            throw new Error('Canvas 2D context is unavailable');
        }
        sourceContext.putImageData(createImageDataFromTransfer(imageData), 0, 0);
        targetContext.fillStyle = '#ffffff';
        targetContext.fillRect(0, 0, targetWidth, targetHeight);
        targetContext.drawImage(
            sourceCanvas,
            0,
            0,
            targetWidth,
            targetHeight,
        );
        throwIfCanceled(signal);
        return canvasImageDataToPpm(targetCanvas, targetWidth, targetHeight);
    } finally {
        releaseCanvas(targetCanvas);
        releaseCanvas(sourceCanvas);
    }
}

async function renderDjvuPageAsPpmFromPngObject(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    targetHeight: number,
    signal?: AbortSignal,
) {
    throwIfCanceled(signal);
    const pngObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
    throwIfCanceled(signal);
    const canvas = createCanvas(targetWidth, targetHeight);

    try {
        const context = getCanvas2dContext(canvas);
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }
        const pngBytes = await fetchObjectUrlBytes(pngObject.url);
        throwIfCanceled(signal);
        const bitmap = await loadBitmapFromBytes(pngBytes);
        throwIfCanceled(signal);
        try {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, targetWidth, targetHeight);
            context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } finally {
            if ('close' in bitmap && typeof bitmap.close === 'function') {
                bitmap.close();
            }
        }
        return canvasImageDataToPpm(canvas, targetWidth, targetHeight);
    } finally {
        worker.revokeObjectURL(pngObject.url);
        releaseCanvas(canvas);
    }
}

async function renderDjvuPageAsPpm(
    worker: IDjvuWorker,
    pageNumber: number,
    pageSize: IDjvuPageMetrics,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPpmPage> {
    const targetSize = compactPhotoTargetSize(pageSize);
    let data: Uint8Array;
    try {
        data = await renderDjvuPageAsPpmFromImageData(
            worker,
            pageNumber,
            targetSize.width,
            targetSize.height,
            signal,
        );
    } catch (error) {
        if (error instanceof DjvuCanceledError) {
            throw error;
        }
        BrowserLogger.debug('djvu-browser', 'Falling back to PNG DjVu page rendering for compact WASM path', {
            pageNumber,
            error,
        });
        data = await renderDjvuPageAsPpmFromPngObject(
            worker,
            pageNumber,
            targetSize.width,
            targetSize.height,
            signal,
        );
    }

    const dpi = positiveInteger(pageSize.dpi) ?? DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP;
    const sourceWidth = positiveInteger(pageSize.width) ?? targetSize.width;
    const sourceHeight = positiveInteger(pageSize.height) ?? targetSize.height;
    return {
        input: {
            data,
            fileName: `page-${String(pageNumber).padStart(5, '0')}.ppm`,
        },
        pageSize: {
            widthPoints: pointsFromPixels(sourceWidth, dpi),
            heightPoints: pointsFromPixels(sourceHeight, dpi),
        },
    };
}

async function mapDjvuContentsToPdfBookmarks(
    worker: IDjvuWorker,
    items: IDjvuContentsItem[] | null | undefined,
    signal?: AbortSignal,
): Promise<IPdfBookmarkEntry[]> {
    throwIfCanceled(signal);
    if (!items || items.length === 0) {
        return [];
    }

    const bookmarks: IPdfBookmarkEntry[] = [];

    for (const item of items) {
        throwIfCanceled(signal);
        const pageNumber = item.url
            ? await worker.doc.getPageNumberByUrl(item.url).run().catch(() => null)
            : null;
        const children = await mapDjvuContentsToPdfBookmarks(
            worker,
            item.children,
            signal,
        );

        bookmarks.push({
            title: item.description,
            pageIndex:
                typeof pageNumber === 'number' && pageNumber > 0
                    ? pageNumber - 1
                    : null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: children,
        });
    }

    return bookmarks;
}

interface IFinalizablePdfSink extends IStreamingPdfSink {
    finish(): Promise<TDocumentRef>;
    abort(): Promise<void>;
}

class BrowserChunkedPdfSink implements IFinalizablePdfSink {
    private readonly outputPath: TDocumentRef;
    private readonly chunkSize: number;
    private readonly saveName: string;
    private readonly buffer: Uint8Array;
    private chunkIndex = 0;
    private bufferedBytes = 0;
    private fileSize = 0;

    public constructor(
        outputPath: TDocumentRef,
        saveName: string,
        chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE,
    ) {
        this.outputPath = outputPath;
        this.saveName = saveName;
        this.chunkSize = chunkSize;
        this.buffer = new Uint8Array(chunkSize);
    }

    public async init() {
        await browserDocumentStore.prepareChunkedDocument(this.outputPath, { chunkSize: this.chunkSize });
    }

    public async write(bytes: Uint8Array) {
        let readOffset = 0;
        this.fileSize += bytes.byteLength;

        while (readOffset < bytes.byteLength) {
            const remaining = this.chunkSize - this.bufferedBytes;
            const writeLength = Math.min(remaining, bytes.byteLength - readOffset);
            this.buffer.set(
                bytes.subarray(readOffset, readOffset + writeLength),
                this.bufferedBytes,
            );
            this.bufferedBytes += writeLength;
            readOffset += writeLength;

            if (this.bufferedBytes === this.chunkSize) {
                await browserDocumentStore.writeChunk(
                    this.outputPath,
                    this.chunkIndex,
                    this.buffer,
                );
                this.chunkIndex += 1;
                this.bufferedBytes = 0;
            }
        }
    }

    public async finish() {
        if (this.bufferedBytes > 0) {
            await browserDocumentStore.writeChunk(
                this.outputPath,
                this.chunkIndex,
                this.buffer.slice(0, this.bufferedBytes),
            );
            this.chunkIndex += 1;
            this.bufferedBytes = 0;
        }

        await browserDocumentStore.finalizeChunkedDocument(this.outputPath, {
            fileSize: this.fileSize,
            chunkCount: this.chunkIndex,
            chunkSize: this.chunkSize,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        await browserDocumentStore.clearChunkedDocument(this.outputPath);
    }
}

class BrowserHandlePdfSink implements IFinalizablePdfSink {
    private readonly outputPath: TDocumentRef;
    private readonly saveHandle: FileSystemFileHandle;
    private readonly saveName: string;
    private readonly writable: FileSystemWritableFileStream;
    private fileSize = 0;

    private constructor(
        outputPath: TDocumentRef,
        saveHandle: FileSystemFileHandle,
        saveName: string,
        writable: FileSystemWritableFileStream,
    ) {
        this.outputPath = outputPath;
        this.saveHandle = saveHandle;
        this.saveName = saveName;
        this.writable = writable;
    }

    public static async create(
        outputPath: TDocumentRef,
        saveHandle: FileSystemFileHandle,
        saveName: string,
    ) {
        const writable = await saveHandle.createWritable();
        return new BrowserHandlePdfSink(
            outputPath,
            saveHandle,
            saveName,
            writable,
        );
    }

    public async write(bytes: Uint8Array) {
        this.fileSize += bytes.byteLength;
        await this.writable.write(toOwnedArrayBuffer(bytes));
    }

    public async finish() {
        await this.writable.close();
        await browserDocumentStore.replaceWithHandleBackedDocument(this.outputPath, {
            fileSize: this.fileSize,
            saveHandle: this.saveHandle,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        if (typeof this.writable.abort === 'function') {
            await this.writable.abort();
        }
    }
}

async function createPdfOutputSink(outputPath: TDocumentRef) {
    const saveTarget = await browserDocumentStore.getSaveTarget(outputPath);
    const saveName = saveTarget.saveName;

    if (saveTarget.saveHandle) {
        return BrowserHandlePdfSink.create(
            outputPath,
            saveTarget.saveHandle,
            saveName,
        );
    }

    const sink = new BrowserChunkedPdfSink(
        outputPath,
        saveName,
    );
    await sink.init();
    return sink;
}

async function createPdfRenderWorkers(options: {
    worker: IDjvuWorker;
    renderConcurrency: number;
    createRenderWorker?: (() => Promise<IDjvuWorker>) | undefined;
    signal?: AbortSignal | undefined;
}) {
    const workers = [options.worker];
    const additionalWorkerCount = Math.max(
        0,
        Math.trunc(options.renderConcurrency) - 1,
    );

    for (let index = 0; index < additionalWorkerCount; index += 1) {
        throwIfCanceled(options.signal);
        if (!options.createRenderWorker) {
            break;
        }
        workers.push(await options.createRenderWorker());
    }

    return workers;
}

async function renderDjvuPagesIntoWriter(options: {
    writer: StreamingImagePdfWriter;
    workers: IDjvuWorker[];
    pageSizes: IDjvuPageMetrics[];
    subsample: number;
    jpegQuality: number;
    signal?: AbortSignal | undefined;
    onPageProcessed?: ((processed: number, total: number) => void) | undefined;
}) {
    const total = options.pageSizes.length;
    const activeTasks = new Map<number, IBrowserDjvuRenderTask>();
    let nextPageNumber = 1;

    const startTask = (worker: IDjvuWorker): IBrowserDjvuRenderTask | null => {
        if (nextPageNumber > total) {
            return null;
        }

        const pageNumber = nextPageNumber;
        nextPageNumber += 1;
        const promise = renderDjvuPage(
            worker,
            pageNumber,
            options.pageSizes[pageNumber - 1]?.dpi ?? 300,
            options.subsample,
            options.jpegQuality,
            options.signal,
        ).then(
            pageData => ({
                pageNumber,
                pageData,
                worker,
            } satisfies TBrowserDjvuRenderTaskResult),
            error => ({
                pageNumber,
                error,
                worker,
            } satisfies TBrowserDjvuRenderTaskResult),
        );

        return {
            pageNumber,
            promise,
        };
    };

    for (const worker of options.workers) {
        const task = startTask(worker);
        if (!task) {
            break;
        }
        activeTasks.set(task.pageNumber, task);
    }

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
        throwIfCanceled(options.signal);
        const task = activeTasks.get(pageNumber);
        if (!task) {
            throw new Error(`DjVu PDF render task for page ${pageNumber} was not scheduled`);
        }

        const result = await task.promise;
        activeTasks.delete(pageNumber);
        if ('error' in result) {
            throw result.error;
        }

        await options.writer.addPage(result.pageData);
        options.onPageProcessed?.(pageNumber, total);
        const nextTask = startTask(result.worker);
        if (nextTask) {
            activeTasks.set(nextTask.pageNumber, nextTask);
        }
        await yieldToBrowser();
    }
}

async function buildPdfWithOptionalBookmarks(options: {
    worker: IDjvuWorker;
    pageSizes: IDjvuPageMetrics[];
    subsample: number;
    jpegQuality: number;
    renderConcurrency: number;
    createRenderWorker?: () => Promise<IDjvuWorker>;
    preserveBookmarks: boolean;
    outputPath: TDocumentRef;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
    onBookmarksStart?: () => void;
}) {
    const sink = await createPdfOutputSink(options.outputPath);

    try {
        let bookmarks: IPdfBookmarkEntry[] = [];
        if (options.preserveBookmarks) {
            throwIfCanceled(options.signal);
            const contents = await options.worker.doc.getContents().run().catch(() => null);
            throwIfCanceled(options.signal);
            bookmarks = await mapDjvuContentsToPdfBookmarks(
                options.worker,
                contents,
                options.signal,
            );
        }

        throwIfCanceled(options.signal);
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: options.pageSizes.length,
            bookmarks,
        });
        await writer.start();

        const renderWorkers = await createPdfRenderWorkers({
            worker: options.worker,
            renderConcurrency: options.renderConcurrency,
            createRenderWorker: options.createRenderWorker,
            signal: options.signal,
        });
        await renderDjvuPagesIntoWriter({
            writer,
            workers: renderWorkers,
            pageSizes: options.pageSizes,
            subsample: options.subsample,
            jpegQuality: options.jpegQuality,
            signal: options.signal,
            onPageProcessed: options.onPageProcessed,
        });

        throwIfCanceled(options.signal);
        if (options.preserveBookmarks) {
            options.onBookmarksStart?.();
        }
        await writer.finish();
        return await sink.finish();
    } catch (error) {
        await sink.abort().catch((abortError: unknown) => {
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser PDF sink', abortError);
        });
        throw error;
    }
}

async function writePdfBytesToOutput(
    outputPath: TDocumentRef,
    bytes: Uint8Array,
) {
    const sink = await createPdfOutputSink(outputPath);
    try {
        await sink.write(bytes);
        return await sink.finish();
    } catch (error) {
        await sink.abort().catch((abortError: unknown) => {
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser compact PDF sink', abortError);
        });
        throw error;
    }
}

async function buildCompactPhotoPdfWithWasm(options: {
    worker: IDjvuWorker;
    pageSizes: IDjvuPageMetrics[];
    outputPath: TDocumentRef;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
}) {
    // The bundled djvu.js wrapper does not expose stable raw Sjbz/BG44/FG44 layer buffers.
    // Keep web compact export bounded by rendering capped photo-style PPM pages and letting
    // the Rust WASM encoder own JPEG quality, grayscale detection, and PDF image embedding.
    const pageSpecs: IBrowserPdfCombineWasmPageSpec[] = [];
    const pageCount = options.pageSizes.length;

    for (const [
        index,
        pageSize,
    ] of options.pageSizes.entries()) {
        throwIfCanceled(options.signal);
        const pageNumber = index + 1;
        const renderedPage = await renderDjvuPageAsPpm(
            options.worker,
            pageNumber,
            pageSize,
            options.signal,
        );
        pageSpecs.push({
            kind: 'image',
            pageSize: renderedPage.pageSize,
            jpegQuality: DJVU_BROWSER_COMPACT_PHOTO_PDF_JPEG_QUALITY,
            ppiCap: DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP,
            image: renderedPage.input,
        });
        options.onPageProcessed?.(pageNumber, pageCount);
        await yieldToBrowser();
    }

    throwIfCanceled(options.signal);
    const pdfBytes = await tryCombineImageInputsWithWasm([], {pageSpecs});
    if (!pdfBytes) {
        throw new Error('ERR_BROWSER_DJVU_COMPACT_WASM_UNAVAILABLE');
    }
    return writePdfBytesToOutput(options.outputPath, pdfBytes);
}

function pickSamplePageNumbers(pageCount: number, maxSamples: number) {
    if (pageCount <= 0) {
        return [];
    }

    const candidates = [
        1,
        Math.ceil(pageCount / 2),
        pageCount,
    ];

    return uniq(candidates).slice(0, maxSamples);
}

async function getDjvuInfo(djvuPath: TDocumentRef): Promise<IDjvuInfo> {
    return withDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await worker.doc.getPagesSizes().run();
        const contents = await worker.doc.getContents().run().catch(() => null);
        const samplePages = pickSamplePageNumbers(
            pageSizes.length,
            DJVU_INFO_TEXT_SAMPLE_PAGES,
        );

        let hasText = false;
        for (const pageNumber of samplePages) {
            const text = await worker.doc.getPage(pageNumber).getText().run().catch(() => '');
            if (text.trim().length > 0) {
                hasText = true;
                break;
            }
            await yieldToBrowser();
        }

        return {
            pageCount: pageSizes.length,
            sourceDpi: pageSizes[0]?.dpi ?? 300,
            hasBookmarks: Boolean(contents && contents.length > 0),
            hasText,
            metadata: {},
        };
    });
}

async function estimateDjvuSizes(
    djvuPath: TDocumentRef,
): Promise<IDjvuSizeEstimate[]> {
    return withDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await worker.doc.getPagesSizes().run();
        const pageCount = pageSizes.length;
        const sourceDpi = pageSizes[0]?.dpi ?? 300;
        const samplePages = pickSamplePageNumbers(
            pageCount,
            DJVU_ESTIMATE_SAMPLE_PAGES,
        );

        return Promise.all(
            DJVU_ESTIMATE_PRESETS.map(async (subsample) => {
                let estimatedBytes = 0;

                if (samplePages.length > 0) {
                    let sampleBytes = 0;
                    for (const pageNumber of samplePages) {
                        const renderedPage = await renderDjvuPage(
                            worker,
                            pageNumber,
                            pageSizes[pageNumber - 1]?.dpi ?? sourceDpi,
                            subsample,
                            DJVU_BROWSER_DIRECT_PDF_JPEG_QUALITY,
                        );
                        sampleBytes += renderedPage.bytes.byteLength;
                        await yieldToBrowser();
                    }

                    estimatedBytes = Math.round(
                        (sampleBytes / samplePages.length) * pageCount,
                    );
                }

                await yieldToBrowser();

                return {
                    subsample,
                    label: '',
                    description: '',
                    resultingDpi: Math.max(
                        1,
                        Math.round(sourceDpi / subsample),
                    ),
                    estimatedBytes,
                } satisfies IDjvuSizeEstimate;
            }),
        );
    });
}

export const browserDjvuCapability: IDjvuCapability = {
    async openForViewing(djvuPath) {
        return withDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await worker.doc.getPagesSizes().run();
            const pageCount = pageSizes.length;

            if (pageCount <= 0) {
                return {
                    success: false,
                    error: 'DjVu document has no pages',
                };
            }

            return {
                success: true,
                pageCount,
            };
        }).catch((error: unknown) => ({
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : 'DjVu viewing failed',
        }));
    },
    async releaseViewingPath(_djvuPath) {},
    cancelPagePreview(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    async convertToPdf(djvuPath, outputPath, options) {
        if (!isBrowserDocumentRef(outputPath)) {
            return {
                success: false,
                error: 'Invalid browser DjVu output target',
            };
        }

        const jobId = `djvu-convert-${crypto.randomUUID()}`;
        const abortController = createDjvuJob(jobId);

        try {
            emitProgress({
                jobId,
                phase: 'loading',
                percent: 0,
            });
            const worker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
            attachDjvuJobWorker(jobId, worker);
            throwIfCanceled(abortController.signal);
            const pageSizes = await worker.doc.getPagesSizes().run();
            throwIfCanceled(abortController.signal);
            const pageCount = pageSizes.length;

            if (pageCount <= 0) {
                throw new Error('DjVu document has no pages');
            }

            emitProgress({
                jobId,
                phase: 'converting',
                percent: 0,
            });
            const renderSettings = resolveBrowserDjvuPdfRenderSettings(options);
            const renderConcurrency = resolveBrowserDjvuPdfRenderConcurrency(pageSizes);
            BrowserLogger.info('djvu-browser', 'Starting browser DjVu PDF conversion', {
                jobId,
                pageCount,
                strategy: renderSettings.strategy,
                subsample: renderSettings.subsample,
                jpegQuality: renderSettings.jpegQuality,
                renderConcurrency,
            });

            const pdfPath = renderSettings.strategy === 'compact-djvu-aware'
                ? await buildCompactPhotoPdfWithWasm({
                    worker,
                    pageSizes,
                    outputPath,
                    signal: abortController.signal,
                    onPageProcessed: (processed, total) => {
                        emitProgress({
                            jobId,
                            phase: 'converting',
                            percent: Math.round((processed / total) * 90),
                        });
                    },
                })
                : await buildPdfWithOptionalBookmarks({
                    worker,
                    pageSizes,
                    subsample: renderSettings.subsample,
                    jpegQuality: renderSettings.jpegQuality,
                    renderConcurrency,
                    createRenderWorker: async () => {
                        const renderWorker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
                        attachDjvuJobWorker(jobId, renderWorker);
                        return renderWorker;
                    },
                    preserveBookmarks: options.preserveBookmarks !== false,
                    outputPath,
                    signal: abortController.signal,
                    onPageProcessed: (processed, total) => {
                        emitProgress({
                            jobId,
                            phase: 'converting',
                            percent: Math.round((processed / total) * 90),
                        });
                    },
                    onBookmarksStart: () => {
                        emitProgress({
                            jobId,
                            phase: 'bookmarks',
                            percent: 95,
                        });
                    },
                });

            emitProgress({
                jobId,
                phase: 'bookmarks',
                percent: 100,
            });

            return {
                success: true,
                pdfPath,
                jobId,
            };
        } catch (error) {
            return {
                success: false,
                jobId,
                error:
                    error instanceof Error
                        ? error.message
                        : 'DjVu conversion failed',
            };
        } finally {
            cleanupDjvuJob(jobId);
        }
    },
    printDjvuPath() {
        return Promise.resolve({
            success: false,
            error: 'DjVu printing is only available in the desktop app',
        });
    },
    cancel(jobId) {
        const job = activeJobs.get(jobId);
        if (!job) {
            return Promise.resolve({ canceled: false });
        }

        job.abortController.abort();
        cleanupDjvuJob(jobId);
        return Promise.resolve({ canceled: true });
    },
    getInfo(djvuPath) {
        return getDjvuInfo(djvuPath);
    },
    getPageSizes(djvuPath) {
        return withDjvuWorker(djvuPath, worker => worker.doc.getPagesSizes().run());
    },
    renderPagePreview(djvuPath, pageNumber, _options) {
        return withDjvuWorker(djvuPath, async (worker) => {
            const pageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            try {
                const response = await fetch(pageObject.url);
                if (!response.ok) {
                    throw new Error(`Failed to read DjVu page preview: ${response.status}`);
                }
                return {
                    bytes: new Uint8Array(await response.arrayBuffer()),
                    width: pageObject.width,
                    height: pageObject.height,
                };
            } finally {
                worker.revokeObjectURL(pageObject.url);
            }
        });
    },
    estimateSizes(djvuPath) {
        return estimateDjvuSizes(djvuPath);
    },
    async cleanupTemp(tempPdfPath) {
        if (!isBrowserDocumentRef(tempPdfPath)) {
            return;
        }

        if (await browserDocumentStore.exists(tempPdfPath)) {
            await browserDocumentStore.remove(tempPdfPath);
        }
    },
    onProgress(callback) {
        progressListeners.add(callback);
        return () => {
            progressListeners.delete(callback);
        };
    },
    onViewingReady(callback) {
        viewingReadyListeners.add(callback);
        return () => {
            viewingReadyListeners.delete(callback);
        };
    },
    onViewingError(callback) {
        viewingErrorListeners.add(callback);
        return () => {
            viewingErrorListeners.delete(callback);
        };
    },
    onMenuConvertToPdf: noopUnsubscribe,
};
