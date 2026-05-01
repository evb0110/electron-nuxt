import type { IPdfBookmarkEntry } from '@contracts/pdf';
import type {
    IDjvuCapability,
    IDjvuInfo,
    IDjvuProgress,
    IDjvuSizeEstimate,
    IDjvuViewingErrorEvent,
    IDjvuViewingReadyEvent,
    TDocumentRef,
} from '@contracts/platform-api';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browser-document-store';
import type {
    IDjvuContentsItem,
    IDjvuImageData,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujs-loader';
import { createDjvuWorkerFromPath } from '@app/platform/browser-api/djvu-worker';
import { noopUnsubscribe } from '@app/platform/browser-api/common';
import {
    type IStreamingPdfSink,
    StreamingImagePdfWriter,
} from '@app/platform/browser-api/streaming-image-pdf';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { BrowserLogger } from '@app/utils/browser-logger';

const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
const DJVU_BROWSER_PDF_JPEG_QUALITY = 0.92;
const DJVU_INFO_TEXT_SAMPLE_PAGES = 3;
const DJVU_ESTIMATE_SAMPLE_PAGES = 3;

class DjvuCanceledError extends Error {
    constructor() {
        super('DjVu conversion canceled');
        this.name = 'DjvuCanceledError';
    }
}

interface IDjvuJobRecord {
    worker: IDjvuWorker;
    abortController: AbortController;
}

interface IRenderedDjvuPage {
    bytes: Uint8Array;
    width: number;
    height: number;
    dpi: number;
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

function createDjvuJob(jobId: string, worker: IDjvuWorker) {
    const abortController = new AbortController();
    activeJobs.set(jobId, {
        worker,
        abortController,
    });
    return abortController;
}

function cleanupDjvuJob(jobId: string) {
    const job = activeJobs.get(jobId);
    if (!job) {
        return;
    }

    activeJobs.delete(jobId);
    try {
        job.worker.terminate();
    } catch (error) {
        BrowserLogger.warn('djvu-browser', 'Failed to terminate DjVu worker', {
            jobId,
            error,
        });
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
        const blob = await canvas.convertToBlob({
            type,
            quality,
        });
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

    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error('Image decoding is unavailable in the current runtime');
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () =>
                reject(new Error('Failed to decode DjVu page image'));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function releaseCanvas(canvas: TDjvuCanvas) {
    canvas.width = 0;
    canvas.height = 0;
}

async function renderDjvuPageFromImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfCanceled(signal);
    const imageData = await worker.doc.getPage(pageNumber).getImageData().run();
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

        return {
            bytes: await canvasToImageBytes(
                targetCanvas,
                'image/jpeg',
                DJVU_BROWSER_PDF_JPEG_QUALITY,
            ),
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
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfCanceled(signal);
    const pngObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
    const targetWidth = Math.max(1, Math.round(pngObject.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(pngObject.height / Math.max(1, subsample)));
    const canvas = createCanvas(targetWidth, targetHeight);

    try {
        const context = getCanvas2dContext(canvas);
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        const bitmap = await loadBitmapFromBytes(await fetchObjectUrlBytes(pngObject.url));
        try {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, targetWidth, targetHeight);
            context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } finally {
            if ('close' in bitmap && typeof bitmap.close === 'function') {
                bitmap.close();
            }
        }

        return {
            bytes: await canvasToImageBytes(
                canvas,
                'image/jpeg',
                DJVU_BROWSER_PDF_JPEG_QUALITY,
            ),
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
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    try {
        return await renderDjvuPageFromImageData(
            worker,
            pageNumber,
            pageDpi,
            subsample,
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
            signal,
        );
    }
}

async function mapDjvuContentsToPdfBookmarks(
    worker: IDjvuWorker,
    items: IDjvuContentsItem[] | null | undefined,
): Promise<IPdfBookmarkEntry[]> {
    if (!items || items.length === 0) {
        return [];
    }

    const bookmarks: IPdfBookmarkEntry[] = [];

    for (const item of items) {
        const pageNumber = item.url
            ? await worker.doc.getPageNumberByUrl(item.url).run().catch(() => null)
            : null;
        const children = await mapDjvuContentsToPdfBookmarks(
            worker,
            item.children,
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

async function buildPdfWithOptionalBookmarks(options: {
    worker: IDjvuWorker;
    pageSizes: Array<{ dpi: number; }>;
    subsample: number;
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
            const contents = await options.worker.doc.getContents().run().catch(() => null);
            bookmarks = await mapDjvuContentsToPdfBookmarks(
                options.worker,
                contents,
            );
        }

        throwIfCanceled(options.signal);
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: options.pageSizes.length,
            bookmarks,
        });
        await writer.start();

        for (let pageNumber = 1; pageNumber <= options.pageSizes.length; pageNumber += 1) {
            throwIfCanceled(options.signal);
            const pageData = await renderDjvuPage(
                options.worker,
                pageNumber,
                options.pageSizes[pageNumber - 1]?.dpi ?? 300,
                options.subsample,
                options.signal,
            );
            await writer.addPage(pageData);
            options.onPageProcessed?.(pageNumber, options.pageSizes.length);
            await yieldToBrowser();
        }

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

function pickSamplePageNumbers(pageCount: number, maxSamples: number) {
    if (pageCount <= 0) {
        return [];
    }

    const candidates = [
        1,
        Math.ceil(pageCount / 2),
        pageCount,
    ];

    return Array.from(new Set(candidates)).slice(0, maxSamples);
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
    async convertToPdf(djvuPath, outputPath, options) {
        if (!isBrowserDocumentRef(outputPath)) {
            return {
                success: false,
                error: 'Invalid browser DjVu output target',
            };
        }

        const worker = await createDjvuWorkerFromPath(djvuPath);
        const pageSizes = await worker.doc.getPagesSizes().run();
        const pageCount = pageSizes.length;
        const jobId = `djvu-convert-${crypto.randomUUID()}`;
        const abortController = createDjvuJob(jobId, worker);

        try {
            if (pageCount <= 0) {
                throw new Error('DjVu document has no pages');
            }

            emitProgress({
                jobId,
                phase: 'converting',
                percent: 0,
            });

            const pdfPath = await buildPdfWithOptionalBookmarks({
                worker,
                pageSizes,
                subsample: Math.max(1, Math.round(options.subsample ?? 1)),
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
