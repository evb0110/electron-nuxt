import {
    PDFDocument,
    type PDFImage,
} from 'pdf-lib';
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
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browser-document-store';
import { embedBookmarksIntoPdf } from '@app/platform/browser-api/djvu-pdf-bookmarks';
import type {
    IDjvuContentsItem,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujs-loader';
import { createDjvuWorkerFromPath } from '@app/platform/browser-api/djvu-worker';
import {
    buildPdfSaveTypes,
    ensurePdfExtension,
    noopUnsubscribe,
} from '@app/platform/browser-api/common';
import {
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/documents-file-capability';
import { BrowserLogger } from '@app/utils/browser-logger';

const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
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

function toArrayBuffer(bytes: Uint8Array) {
    const normalizedBytes = Uint8Array.from(bytes);
    return normalizedBytes.buffer;
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

async function fetchObjectUrlBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to read DjVu page image: ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
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

async function loadBitmapFromBytes(bytes: Uint8Array) {
    const blob = new Blob([toArrayBuffer(bytes)], { type: 'image/png' });

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

async function canvasToPngBytes(
    canvas: OffscreenCanvas | HTMLCanvasElement,
) {
    if (
        typeof OffscreenCanvas !== 'undefined'
        && canvas instanceof OffscreenCanvas
    ) {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await blob.arrayBuffer());
    }

    const htmlCanvas = canvas as HTMLCanvasElement;
    const blob = await new Promise<Blob>((resolve, reject) => {
        htmlCanvas.toBlob((nextBlob: Blob | null) => {
            if (!nextBlob) {
                reject(new Error('Failed to encode canvas as PNG'));
                return;
            }
            resolve(nextBlob);
        }, 'image/png');
    });

    return new Uint8Array(await blob.arrayBuffer());
}

async function resamplePngBytes(
    bytes: Uint8Array,
    width: number,
    height: number,
    subsample: number,
): Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
}> {
    if (subsample <= 1) {
        return {
            bytes,
            width,
            height,
        };
    }

    const targetWidth = Math.max(1, Math.round(width / subsample));
    const targetHeight = Math.max(1, Math.round(height / subsample));
    const canvas = createCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    const bitmap = await loadBitmapFromBytes(bytes);
    try {
        context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    } finally {
        if ('close' in bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }

    return {
        bytes: await canvasToPngBytes(canvas),
        width: targetWidth,
        height: targetHeight,
    };
}

async function renderDjvuPage(
    worker: IDjvuWorker,
    pageNumber: number,
    subsample: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfCanceled(signal);
    const pngObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();

    try {
        const sourceBytes = await fetchObjectUrlBytes(pngObject.url);
        const resampled = await resamplePngBytes(
            sourceBytes,
            pngObject.width,
            pngObject.height,
            subsample,
        );

        return {
            bytes: resampled.bytes,
            width: resampled.width,
            height: resampled.height,
            dpi: Math.max(1, Math.round(pngObject.dpi / subsample)),
        };
    } finally {
        worker.revokeObjectURL(pngObject.url);
    }
}

async function embedPngPage(
    pdfDocument: PDFDocument,
    pageData: IRenderedDjvuPage,
) {
    const image = await pdfDocument.embedPng(pageData.bytes);
    addPdfImagePage(pdfDocument, image, pageData);
}

function addPdfImagePage(
    pdfDocument: PDFDocument,
    image: PDFImage,
    pageData: IRenderedDjvuPage,
) {
    const pageWidth = (pageData.width / pageData.dpi) * 72;
    const pageHeight = (pageData.height / pageData.dpi) * 72;
    const page = pdfDocument.addPage([
        pageWidth,
        pageHeight,
    ]);

    page.drawImage(image, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
    });
}

async function buildPdfFromDjvuPages(options: {
    worker: IDjvuWorker;
    pageCount: number;
    subsample: number;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
}) {
    const pdfDocument = await PDFDocument.create();

    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
        throwIfCanceled(options.signal);
        const pageData = await renderDjvuPage(
            options.worker,
            pageNumber,
            options.subsample,
            options.signal,
        );
        await embedPngPage(pdfDocument, pageData);
        options.onPageProcessed?.(pageNumber, options.pageCount);
    }

    throwIfCanceled(options.signal);
    return Uint8Array.from(await pdfDocument.save());
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

async function buildPdfWithOptionalBookmarks(options: {
    worker: IDjvuWorker;
    pageCount: number;
    subsample: number;
    preserveBookmarks: boolean;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
    onBookmarksStart?: () => void;
}) {
    let pdfBytes: Uint8Array<ArrayBufferLike> = await buildPdfFromDjvuPages({
        worker: options.worker,
        pageCount: options.pageCount,
        subsample: options.subsample,
        signal: options.signal,
        onPageProcessed: options.onPageProcessed,
    });

    if (options.preserveBookmarks) {
        options.onBookmarksStart?.();
        const contents = await options.worker.doc.getContents().run().catch(() => null);
        const bookmarks = await mapDjvuContentsToPdfBookmarks(
            options.worker,
            contents,
        );

        throwIfCanceled(options.signal);
        pdfBytes = await embedBookmarksIntoPdf(pdfBytes, bookmarks);
    }

    return pdfBytes;
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

async function persistOutputPdf(
    outputPath: TDocumentRef,
    bytes: Uint8Array,
) {
    await browserDocumentStore.write(outputPath, bytes);

    const saveTarget = await browserDocumentStore.getSaveTarget(outputPath);
    if (saveTarget.saveHandle) {
        await writeBytesToHandle(saveTarget.saveHandle, bytes);
        return outputPath;
    }

    const saveResult = await saveBytesToPickerOrDownload(bytes, {
        suggestedName: ensurePdfExtension(saveTarget.saveName),
        mimeType: 'application/pdf',
        pickerTypes: buildPdfSaveTypes(),
    });

    await browserDocumentStore.assignSaveTarget(
        outputPath,
        ensurePdfExtension(saveResult.fileName),
        'pdf',
        saveResult.handle,
    );

    return outputPath;
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
                            subsample,
                        );
                        sampleBytes += renderedPage.bytes.byteLength;
                    }

                    estimatedBytes = Math.round(
                        (sampleBytes / samplePages.length) * pageCount,
                    );
                }

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

            const pdfBytes = await buildPdfWithOptionalBookmarks({
                worker,
                pageCount,
                subsample: Math.max(1, Math.round(options.subsample ?? 1)),
                preserveBookmarks: options.preserveBookmarks !== false,
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

            const pdfPath = await persistOutputPdf(outputPath, pdfBytes);
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
