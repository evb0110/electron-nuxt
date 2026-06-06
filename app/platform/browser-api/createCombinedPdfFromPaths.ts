import { PDFDocument } from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import {
    ensurePdfExtension,
    getExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    buildBrowserByteLimitError,
} from '@app/platform/browser-api/browserPlatformHelpers';
import {
    BrowserPdfCombineWorkerUnavailableError,
    canUseBrowserPdfCombineWorker,
    cloneCombineWorkerInput,
    runBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import { embedImagePage } from '@app/platform/browser-api/embedImagePage';
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
