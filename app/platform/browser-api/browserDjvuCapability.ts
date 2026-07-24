import { uniq } from 'es-toolkit/array';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IDjvuInfo,
    IDjvuProgress,
    IDjvuSizeEstimate,
} from '@contracts/electronApiDjvu';
import type {
    DJVU_PLATFORM_FEATURE,
    IDjvuCapability,
} from '@contracts/djvuPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import type { IBrowserPdfCombineWasmPageSpec } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import type {
    IDjvuContentsItem,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';
import {
    createDjvuWorkerFromPath,
    releaseBrowserDjvuViewingWorker,
    retainBrowserDjvuViewingWorker,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { browserDjvuTextSearchCapability } from '@app/platform/browser-api/browserDjvuTextSearchCapability';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { browserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';
import { StreamingImagePdfWriter } from '@app/platform/browser-api/streamingImagePdfWriter';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { BrowserLogger } from '@app/utils/browserLogger';
import { tryCombineImageInputsWithWasm } from '@app/platform/browser-api/tryCombineImageInputsWithWasm';
import {
    createDjvuCanvas as createCanvas,
    createDjvuImageData as createImageDataFromTransfer,
    encodeDjvuCanvas as canvasToImageBytes,
    fetchDjvuObjectUrlBytes as fetchObjectUrlBytes,
    getDjvuCanvas2dContext as getCanvas2dContext,
    loadDjvuBitmap as loadBitmapFromBytes,
    releaseDjvuCanvas as releaseCanvas,
    type TDjvuCanvas,
} from '@app/platform/browser-api/browserDjvuCanvas';
import {createBrowserDjvuPdfOutputSink as createPdfOutputSink} from '@app/platform/browser-api/createBrowserDjvuPdfOutputSink';
import {
    DjvuCanceledError,
    throwIfDjvuCanceled as throwIfCanceled,
} from '@app/platform/browser-api/djvuCanceledError';
import {
    resolveBrowserDjvuCompactExportPlan,
    resolveBrowserDjvuConversionPreflight,
    resolveBrowserDjvuPdfRenderConcurrency,
    resolveBrowserDjvuPdfRenderSettings,
    type IBrowserDjvuPageMetrics as IDjvuPageMetrics,
} from '@app/platform/browser-api/browserDjvuConversionPolicy';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
export {
    resolveBrowserDjvuCompactExportPlan,
    resolveBrowserDjvuConversionPreflight,
    resolveBrowserDjvuPdfRenderConcurrency,
    resolveBrowserDjvuPdfRenderSettings,
} from '@app/platform/browser-api/browserDjvuConversionPolicy';

export async function getBrowserDjvuBookmarksForCombine(djvuPath: TDocumentRef, signal?: AbortSignal) {
    const worker = await createDjvuWorkerFromPath(djvuPath, signal ? { signal } : {});
    try {
        throwIfCanceled(signal);
        const contents = await worker.doc.getContents().run().catch(() => null);
        throwIfCanceled(signal);
        return await mapDjvuContentsToPdfBookmarks(worker, contents, signal);
    } finally {
        worker.terminate();
    }
}
const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
const DJVU_BROWSER_DIRECT_PDF_JPEG_QUALITY = 0.92;
const DJVU_BROWSER_COMPACT_PHOTO_PDF_JPEG_QUALITY = 85;
const DJVU_BROWSER_COMPACT_PHOTO_PPI_CAP = 300;
const DJVU_BROWSER_COMPACT_PHOTO_PAGE_SPEC_MAX_BYTES = 192 * 1024 * 1024;
const DJVU_INFO_TEXT_SAMPLE_PAGES = 3;
const DJVU_ESTIMATE_SAMPLE_PAGES = 3;
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
const activeJobs = new Map<string, IDjvuJobRecord>();

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

async function assertWorkerDjvuRasterBudget(worker: IDjvuWorker, pageNumber: number) {
    const pageSize = (await worker.doc.getPagesSizes().run())[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
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
    const pageSize = (await worker.doc.getPagesSizes().run())[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
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
    await assertWorkerDjvuRasterBudget(worker, pageNumber);
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
    const pageSize = (await worker.doc.getPagesSizes().run())[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
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
    await assertWorkerDjvuRasterBudget(worker, pageNumber);
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
    const outcome = await tryCombineImageInputsWithWasm([], {pageSpecs});
    if (outcome.status !== 'success') {
        throw new Error('ERR_BROWSER_DJVU_COMPACT_WASM_UNAVAILABLE');
    }
    return writePdfBytesToOutput(options.outputPath, outcome.data);
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
    startOpenForViewing(djvuPath, requestId) {
        const jobId = `djvu-open-${requestId}`;
        return Promise.resolve(browserDurableDjvuJobs.startOpen(
            jobId,
            requestId,
            () => browserDjvuCapability.openForViewing(djvuPath),
        ));
    },
    awaitOpenJob(jobId) {
        return browserDurableDjvuJobs.awaitOpen(jobId);
    },
    async openForViewing(djvuPath) {
        if (!isBrowserDocumentRef(djvuPath)) {
            return withDjvuWorker(djvuPath, async (worker) => {
                const pageSizes = await worker.doc.getPagesSizes().run();
                return pageSizes.length > 0
                    ? {
                        success: true,
                        pageCount: pageSizes.length,
                    }
                    : {
                        success: false,
                        error: 'DjVu document has no pages',
                    };
            });
        }
        try {
            const worker = await retainBrowserDjvuViewingWorker(djvuPath);
            const pageSizes = await worker.doc.getPagesSizes().run();
            const pageCount = pageSizes.length;

            if (pageCount <= 0) {
                releaseBrowserDjvuViewingWorker(djvuPath);
                return {
                    success: false,
                    error: 'DjVu document has no pages',
                };
            }
            return {
                success: true,
                pageCount,
            };
        } catch (error: unknown) {
            releaseBrowserDjvuViewingWorker(djvuPath);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'DjVu viewing failed',
            };
        }
    },
    releaseViewingPath(djvuPath) {
        if (isBrowserDocumentRef(djvuPath)) releaseBrowserDjvuViewingWorker(djvuPath);
        return Promise.resolve();
    },
    cancelPagePreview(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    ...browserDjvuTextSearchCapability,
    async convertToPdf(djvuPath, outputPath, options) {
        if (!isBrowserDocumentRef(outputPath)) {
            return {
                success: false,
                error: 'Invalid browser DjVu output target',
            };
        }

        const jobId = options.jobId ?? `djvu-convert-${crypto.randomUUID()}`;
        const abortController = createDjvuJob(jobId);

        try {
            const sourceBytes = isBrowserDocumentRef(djvuPath)
                ? (await browserDocumentStore.stat(djvuPath)).size
                : 0;
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
            const preflight = resolveBrowserDjvuConversionPreflight(pageSizes);
            if (!preflight.allowed) {
                const limit = preflight.reason === 'page-count'
                    ? `${preflight.maxPages} pages`
                    : `${preflight.maxPagePixels.toLocaleString('en-US')} pixels per page`;
                throw new Error(`Browser rasterized compatibility export exceeds its ${limit} limit. Use the Electron app for archival conversion.`);
            }

            emitProgress({
                jobId,
                phase: 'converting',
                percent: 0,
            });
            const renderSettings = resolveBrowserDjvuPdfRenderSettings(options);
            const renderConcurrency = resolveBrowserDjvuPdfRenderConcurrency(pageSizes, undefined, sourceBytes, getPerformanceProfile().tier);
            BrowserLogger.info('djvu-browser', 'Starting browser DjVu PDF conversion', {
                jobId,
                pageCount,
                strategy: renderSettings.strategy,
                subsample: renderSettings.subsample,
                jpegQuality: renderSettings.jpegQuality,
                renderConcurrency,
            });
            const compactExportPlan = renderSettings.strategy === 'compact-djvu-aware'
                ? resolveBrowserDjvuCompactExportPlan(
                    pageSizes,
                    DJVU_BROWSER_COMPACT_PHOTO_PAGE_SPEC_MAX_BYTES,
                    options.preserveBookmarks !== false,
                )
                : null;
            if (compactExportPlan?.strategy === 'direct-fallback') {
                BrowserLogger.info('djvu-browser', compactExportPlan.fallbackReason === 'bookmarks'
                    ? 'Browser compact DjVu export cannot preserve bookmarks; using streaming direct export'
                    : 'Browser compact DjVu export exceeds in-memory WASM budget; using streaming direct export', {
                    jobId,
                    fallbackReason: compactExportPlan.fallbackReason,
                    estimatedPageSpecBytes: compactExportPlan.estimatedPageSpecBytes,
                    maxPageSpecBytes: compactExportPlan.maxPageSpecBytes,
                });
            }
            const useCompactWasm = compactExportPlan?.strategy === 'compact-djvu-aware';
            const streamingRenderSettings = useCompactWasm
                ? renderSettings
                : {
                    strategy: 'direct' as const,
                    subsample: renderSettings.subsample,
                    jpegQuality: DJVU_BROWSER_DIRECT_PDF_JPEG_QUALITY,
                };

            const pdfPath = useCompactWasm
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
                    subsample: streamingRenderSettings.subsample,
                    jpegQuality: streamingRenderSettings.jpegQuality,
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
    startConvertToPdf(djvuPath, outputPath, options) {
        const requestId = options.requestId ?? crypto.randomUUID();
        const jobId = options.jobId ?? `djvu-convert-${requestId}`;
        return Promise.resolve(browserDurableDjvuJobs.startConvert(
            jobId,
            requestId,
            () => browserDjvuCapability.convertToPdf(djvuPath, outputPath, {
                ...options,
                jobId,
                requestId,
            }),
        ));
    },
    awaitConvertJob(jobId) {
        return browserDurableDjvuJobs.awaitConvert(jobId);
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
    getJobState(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    subscribeJob(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    getInfo(djvuPath) {
        return getDjvuInfo(djvuPath);
    },
    getPageSourceInfo(djvuPath, pageNumber) {
        return withDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await worker.doc.getPagesSizes().run();
            const effectivePageNumber = Math.min(pageNumber, pageSizes.length);
            const pageSize = pageSizes[effectivePageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside 1..${pageSizes.length}`);
            }
            return {
                pageCount: pageSizes.length,
                pageNumber: effectivePageNumber,
                pageSize,
            };
        });
    },
    getPageSizes(djvuPath) {
        return withDjvuWorker(djvuPath, worker => worker.doc.getPagesSizes().run());
    },
    renderPagePreview(djvuPath, pageNumber, _options) {
        return withDjvuWorker(djvuPath, async (worker) => {
            const pageSize = (await worker.doc.getPagesSizes().run())[pageNumber - 1];
            if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
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
    onMenuConvertToPdf: noopUnsubscribe,
} satisfies TFeatureBrowserBindings<typeof DJVU_PLATFORM_FEATURE>;
