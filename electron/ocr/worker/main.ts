/**
 * OCR Worker Thread
 *
 * This worker handles all heavy OCR processing off the main Electron thread,
 * preventing UI freezing during long-running OCR operations.
 *
 * Communication protocol:
 * - Receives: { type: 'start', jobId, data: { sourcePdfPath, pages, renderDpi } }
 * - Receives: { type: 'cancel', jobId }
 * - Sends: { type: 'progress', jobId, progress: {...} }
 * - Sends: { type: 'complete', jobId, result: {...} }
 * - Sends: { type: 'log', level, message }
 */

import {
    parentPort,
    workerData,
} from 'worker_threads';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {uniq} from 'es-toolkit/array';
import { PDFDocument } from 'pdf-lib';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import {
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import type {
    TOcrWorkerCompleteResult,
    IOcrWorkerLogMessage,
    TOcrWorkerOutboundMessage,
    IOcrPageWithWords,
    IOcrPdfPageRequest,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import { clampDpi } from '@electron/image/imageDpi';
import {
    getPngDimensionsFromFile,
    runOcrFileBased,
} from '@electron/ocr/worker/tesseractRunner';
import { tryPreprocessOcrImage } from '@electron/ocr/worker/tryPreprocessOcrImage';
import {
    assembleSearchablePdf,
    getPageCount,
} from '@electron/ocr/worker/pdfAssembler';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';
import {
    resolveSafeOcrIndexBasePath,
    writeOcrIndexV3,
} from '@electron/ocr/worker/indexWriter';
import {
    parseInvalidOcrWorkerStartMessage,
    parseOcrWorkerInboundMessage,
} from '@electron/ocr/worker/inboundMessage';
import { resolveWorkerPaths } from '@electron/ocr/worker/resolveWorkerPaths';
import {
    buildPopplerEnv,
    preparePdfForPoppler,
    renderPdfPageToPng,
} from '@electron/ocr/worker/popplerStage';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { buildOcrErrorEnvelope } from '@electron/ocr/contracts';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {selectOcrPagesForSupersession} from '@electron/ocr/worker/selectOcrPagesForSupersession';
import { assertPdfPageSizeFallbackInputSafe } from '@electron/ocr/worker/assertPdfPageSizeFallbackInputSafe';
import {
    cleanupStaleOcrJobDirectories,
    createOcrJobManifestController,
} from '@electron/ocr/worker/ocrJobManifest';

const initialWorkerData: unknown = workerData;
const paths = resolveWorkerPaths(initialWorkerData);
const activeJobControllers = new Map<string, AbortController>();
const OCR_PAGE_SIZES_TIMEOUT_MS = 30_000;
const OCR_PAGE_SIZE_FALLBACK_MAX_INPUT_BYTES = parseIntegerEnv(
    'EVB_OCR_PAGE_SIZE_FALLBACK_MAX_INPUT_MB',
    128,
    1,
    1024,
) * 1024 * 1024;
const OCR_RESOURCE_ACQUIRE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_RESOURCE_ACQUIRE_TIMEOUT_MS ?? '30000', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 30_000;
    }
    return Math.min(Math.max(parsed, 1_000), 120_000);
})();
interface IOcrResourceSlotLease {
    token: string;
    effectiveDpi: number;
}
const pendingResourceAcquires = new Map<string, {
    resolve: (lease: IOcrResourceSlotLease) => void;
    reject: (error: Error) => void;
}>();

const log: TWorkerLog = (level, message) => {
    const timestamp = new Date().toISOString();
    const payload: IOcrWorkerLogMessage = {
        type: 'log',
        level,
        message: `[${timestamp}] [ocr-worker] ${message}`,
    };
    parentPort?.postMessage(payload);
};

function sendProgress(
    jobId: string,
    currentPage: number,
    processedCount: number,
    totalPages: number,
    options: {
        phase?: TOcrProgressPhase;
        phaseProgress?: number;
    } = {},
) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'progress',
        jobId,
        progress: {
            requestId: jobId,
            currentPage,
            processedCount,
            totalPages,
            ...options,
        },
    };
    parentPort?.postMessage(payload);
}

function sendStageProgress(
    jobId: string,
    pages: readonly IOcrPdfPageRequest[],
    phase: TOcrProgressPhase,
) {
    sendProgress(
        jobId,
        pages[0]?.pageNumber ?? 0,
        0,
        pages.length,
        { phase },
    );
}

function sendComplete(jobId: string, result: TOcrWorkerCompleteResult) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'complete',
        jobId,
        result,
    };
    parentPort?.postMessage(payload);
}

function sendCleanupComplete(jobId: string) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'cleanup-complete',
        jobId,
    };
    parentPort?.postMessage(payload);
}

async function acquireOcrResourceSlot(
    jobId: string,
    pageNumber: number,
    requestedDpi: number,
    pageSizeInches: IOcrPageSizeInches | undefined,
    signal: AbortSignal,
) {
    const requestId = randomUUID();
    const payload: TOcrWorkerOutboundMessage = {
        type: 'resource-acquire',
        jobId,
        requestId,
        pageNumber,
        requestedDpi,
    };
    if (pageSizeInches !== undefined) {
        payload.pageWidthIn = pageSizeInches.width;
        payload.pageHeightIn = pageSizeInches.height;
    }

    throwIfAborted(signal);
    const leasePromise = new Promise<IOcrResourceSlotLease>((resolve, reject) => {
        pendingResourceAcquires.set(requestId, {
            resolve,
            reject,
        });
    });

    const timeout = setTimeout(() => {
        const pending = pendingResourceAcquires.get(requestId);
        pendingResourceAcquires.delete(requestId);
        pending?.reject(new Error(`OCR resource acquire timed out after ${OCR_RESOURCE_ACQUIRE_TIMEOUT_MS}ms`));
    }, OCR_RESOURCE_ACQUIRE_TIMEOUT_MS);
    timeout.unref?.();

    const abortListener = () => {
        const pending = pendingResourceAcquires.get(requestId);
        pendingResourceAcquires.delete(requestId);
        pending?.reject(signal.reason instanceof Error
            ? signal.reason
            : new Error('OCR job aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
    parentPort?.postMessage(payload);

    try {
        return await leasePromise;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortListener);
        pendingResourceAcquires.delete(requestId);
    }
}

function releaseOcrResourceSlot(jobId: string, token: string) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'resource-release',
        jobId,
        token,
    };
    parentPort?.postMessage(payload);
}

function throwIfAborted(signal: AbortSignal) {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('OCR job aborted');
}

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch {
        // Ignore cleanup errors
    }
}

async function readPngDimensions(imagePath: string) {
    const dims = await getPngDimensionsFromFile(imagePath);
    if (!dims) {
        throw new Error('Failed to determine PNG dimensions from pdftoppm output');
    }
    if (dims.width <= 0 || dims.height <= 0) {
        throw new Error(`Invalid page image dimensions: ${dims.width}x${dims.height}`);
    }
    return dims;
}

interface IOcrPageProcessingContext {
    jobId: string;
    sessionId: string;
    popplerSourcePdfPath: string;
    extractionDpi: number;
    tesseractThreads: number;
    pageSizeByNumber: Map<number, IOcrPageSizeInches>;
    pageSourceDpiByNumber: Map<number, number>;
    options: IOcrSearchablePdfOptions;
    checkpointDir: string;
    checkpointPage: (pageNumber: number) => Promise<void>;
    popplerEnv?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    trackTempFile: (path: string) => string;
}

interface IOcrPageSizeInches {
    width: number;
    height: number;
}

async function processOcrPage(
    page: IOcrPdfPageRequest,
    context: IOcrPageProcessingContext,
) {
    const checkpointJsonPath = join(context.checkpointDir, `page-${page.pageNumber}.json`);
    const checkpointPdfPath = join(context.checkpointDir, `page-${page.pageNumber}.pdf`);
    try {
        const checkpoint = JSON.parse(await readFile(checkpointJsonPath, 'utf8')) as {
            pageData?: IOcrPageWithWords;
            effectiveDpi?: number;
            diagnostics?: IOcrDiagnostic[];
        };
        const checkpointPdfStat = await stat(checkpointPdfPath);
        if (
            checkpointPdfStat.size > 0
            && checkpoint.pageData?.pageNumber === page.pageNumber
            && checkpoint.pageData.imageWidth > 0
            && checkpoint.pageData.imageHeight > 0
            && typeof checkpoint.effectiveDpi === 'number'
            && checkpoint.effectiveDpi > 0
        ) {
            await context.checkpointPage(page.pageNumber);
            return {
                pageData: checkpoint.pageData,
                pdfPath: checkpointPdfPath,
                effectiveDpi: checkpoint.effectiveDpi,
                diagnostics: checkpoint.diagnostics ?? [],
            };
        }
    } catch {
        // Missing or invalid checkpoints are recomputed.
    }
    log('debug', `Processing page ${page.pageNumber}`);

    const pageImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}.png`));
    const preprocessedImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.png`));
    const preprocessMetadataPath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.json`));
    let resourceToken: string | null = null;
    const diagnostics: IOcrDiagnostic[] = [];

    try {
        const resourceLease = await acquireOcrResourceSlot(
            context.jobId,
            page.pageNumber,
            context.extractionDpi,
            context.pageSizeByNumber.get(page.pageNumber),
            context.signal,
        );
        resourceToken = resourceLease.token;
        const pageSourceDpi = context.pageSourceDpiByNumber.get(page.pageNumber);
        const effectiveDpi = Math.min(resourceLease.effectiveDpi, pageSourceDpi ?? resourceLease.effectiveDpi);
        if (effectiveDpi < context.extractionDpi) {
            const reason = pageSourceDpi !== undefined && pageSourceDpi <= effectiveDpi
                ? 'to avoid upscaling the embedded page image'
                : 'to stay within native resource budget';
            log('debug', `Reduced OCR render DPI for page ${page.pageNumber} from ${context.extractionDpi} to ${effectiveDpi} ${reason}`);
            diagnostics.push({
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'info',
                pageNumber: page.pageNumber,
                message: `Used ${effectiveDpi} DPI instead of ${context.extractionDpi} DPI ${reason}`,
            });
        }

        await renderPdfPageToPng(
            paths,
            log,
            page.pageNumber,
            context.popplerSourcePdfPath,
            pageImagePath,
            effectiveDpi,
            context.popplerEnv,
            context.signal,
        );

        const dims = await readPngDimensions(pageImagePath);
        let ocrImagePath = pageImagePath;
        let ocrDims = dims;
        if (context.options.preprocessingMode === 'clean') {
            const candidateOcrImagePath = await tryPreprocessOcrImage(
                paths.unpaperBinary,
                pageImagePath,
                preprocessedImagePath,
                log,
                context.signal,
                diagnostic => diagnostics.push({
                    ...diagnostic,
                    pageNumber: page.pageNumber,
                }),
                paths.scanCleanupBinary,
                preprocessMetadataPath,
                effectiveDpi,
            );
            if (candidateOcrImagePath !== pageImagePath) {
                const candidateDims = await readPngDimensions(candidateOcrImagePath);
                if (candidateDims.width === dims.width && candidateDims.height === dims.height) {
                    ocrImagePath = candidateOcrImagePath;
                    ocrDims = candidateDims;
                } else {
                    const rawSize = `${dims.width}x${dims.height}`;
                    const cleanSize = `${candidateDims.width}x${candidateDims.height}`;
                    log('warn', [
                        `OCR preprocessing changed page ${page.pageNumber} image dimensions`,
                        `from ${rawSize} to ${cleanSize};`,
                        'using raw page render to preserve text-layer alignment',
                    ].join(' '));
                    diagnostics.push({
                        code: 'OCR_PREPROCESSING_GEOMETRY_CHANGED',
                        severity: 'warning',
                        pageNumber: page.pageNumber,
                        message: `Preprocessing changed image dimensions from ${rawSize} to ${cleanSize}; used raw render to preserve alignment`,
                    });
                }
            }
        }
        const ocrResult = await runOcrFileBased(
            ocrImagePath,
            page.languages,
            ocrDims.width,
            ocrDims.height,
            effectiveDpi,
            paths.tesseractBinary,
            paths.tessdataPath,
            context.tesseractThreads,
            context.signal,
            context.options,
        );

        if (!ocrResult.success || !ocrResult.pageData) {
            return { error: `Page ${page.pageNumber}: ${ocrResult.error}` };
        }

        const pageData: IOcrPageWithWords = {
            pageNumber: page.pageNumber,
            words: ocrResult.pageData.words,
            text: ocrResult.pageData.text,
            imageWidth: ocrResult.pageData.imageWidth,
            imageHeight: ocrResult.pageData.imageHeight,
        };

        if (!ocrResult.pdfPath) {
            return {
                pageData,
                error: `Page ${page.pageNumber}: Tesseract did not produce PDF output`,
            };
        }

        context.trackTempFile(ocrResult.pdfPath);
        const checkpointTempPdf = `${checkpointPdfPath}.${process.pid}.${randomUUID()}.tmp`;
        const checkpointTempJson = `${checkpointJsonPath}.${process.pid}.${randomUUID()}.tmp`;
        await copyFile(ocrResult.pdfPath, checkpointTempPdf);
        await writeFile(checkpointTempJson, JSON.stringify({
            version: 1,
            pageData,
            effectiveDpi,
            diagnostics,
        }), 'utf8');
        await rename(checkpointTempPdf, checkpointPdfPath);
        await rename(checkpointTempJson, checkpointJsonPath);
        await context.checkpointPage(page.pageNumber);
        return {
            pageData,
            pdfPath: checkpointPdfPath,
            effectiveDpi,
            diagnostics,
        };
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log('warn', `Failed to process page ${page.pageNumber}: ${errMsg}`);
        return { error: `Failed to process page ${page.pageNumber}: ${errMsg}` };
    } finally {
        if (resourceToken) {
            releaseOcrResourceSlot(context.jobId, resourceToken);
        }
    }
}

async function processOcrPages(
    jobId: string,
    targetPages: IOcrPdfPageRequest[],
    concurrency: number,
    context: IOcrPageProcessingContext,
) {
    let processedCount = 0;

    sendProgress(
        jobId,
        targetPages[0]?.pageNumber ?? 0,
        0,
        targetPages.length,
        { phase: 'processing' },
    );

    const errors: string[] = [];
    const ocrPageData: IOcrPageWithWords[] = [];
    const ocrPdfMap = new Map<number, string>();
    let effectiveRenderDpi = context.extractionDpi;
    const diagnostics: IOcrDiagnostic[] = [];
    let nextPageIndex = 0;

    const aggregateResult = (pageNumber: number, result: Awaited<ReturnType<typeof processOcrPage>>) => {
        if (result.error) {
            errors.push(result.error);
        }
        if (result.pageData) {
            ocrPageData.push(result.pageData);
        }
        if (typeof result.effectiveDpi === 'number') {
            effectiveRenderDpi = Math.min(effectiveRenderDpi, result.effectiveDpi);
        }
        if (result.pdfPath) {
            ocrPdfMap.set(pageNumber, result.pdfPath);
        }
        diagnostics.push(...(result.diagnostics ?? []));
    };

    const runWorker = async () => {
        while (nextPageIndex < targetPages.length) {
            const page = targetPages[nextPageIndex];
            nextPageIndex += 1;
            if (!page) {
                continue;
            }
            const result = await processOcrPage(page, context);
            aggregateResult(page.pageNumber, result);
            processedCount += 1;
            sendProgress(
                jobId,
                getSequentialProgressPage(targetPages, processedCount),
                processedCount,
                targetPages.length,
                { phase: 'processing' },
            );
        }
    };
    await Promise.all(Array.from(
        {length: Math.min(concurrency, targetPages.length)},
        () => runWorker(),
    ));

    return {
        errors,
        ocrPageData: ocrPageData.sort((left, right) => left.pageNumber - right.pageNumber),
        ocrPdfMap,
        effectiveRenderDpi,
        diagnostics,
    };
}

async function resolveOcrIndexPath(sourcePdfPath: string) {
    try {
        return await resolveSafeOcrIndexBasePath(sourcePdfPath, paths.tempDir);
    } catch (pathErr) {
        const pathErrMsg = getErrorMessage(pathErr);
        log('warn', `Rejected OCR index path "${sourcePdfPath}": ${pathErrMsg}`);
        return undefined;
    }
}

async function writeOcrIndexes(
    sourcePdfPath: string,
    stagedResultPdfPath: string,
    documentRevision: IDocumentRevisionInfo,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    allLanguages: string[],
    effectiveRenderDpi: number,
    signal: AbortSignal,
) {
    const validatedWorkingCopyPath = await resolveOcrIndexPath(sourcePdfPath);
    if (!validatedWorkingCopyPath) {
        const warning = 'Skipping OCR index writes due to invalid source PDF path';
        log('warn', warning);
        return [warning];
    }

    try {
        await writeOcrIndexV3(
            validatedWorkingCopyPath,
            documentRevision,
            ocrPageData,
            pageCount,
            allLanguages,
            effectiveRenderDpi,
            log,
            signal,
            stagedResultPdfPath,
        );
    } catch (indexError) {
        if (isAbortError(indexError)) {
            throw indexError;
        }
        const indexErrorMessage = getErrorMessage(indexError);
        log('error', `Failed to stage OCR text catalog: ${indexErrorMessage}`);
        throw new Error(`Failed to stage OCR text catalog: ${indexErrorMessage}`, {cause: indexError});
    }

    return [];
}

async function validateSourcePdf(jobId: string, sourcePdfPath: string, pageCount: number) {
    const sourceStat = await stat(sourcePdfPath);
    if (sourceStat.size <= 0) {
        throw new Error(`Source PDF is empty: ${sourcePdfPath}`);
    }
    log('debug', `Processing OCR job ${jobId}: sourcePath=${sourcePdfPath}, pdfBytes=${sourceStat.size}, pages=${pageCount}`);
}

function assertUniqueOcrPageNumbers(pages: readonly IOcrPdfPageRequest[]) {
    const seenPageNumbers = new Set<number>();
    for (const page of pages) {
        if (seenPageNumbers.has(page.pageNumber)) {
            throw new Error(`Duplicate OCR page number ${page.pageNumber}`);
        }
        seenPageNumbers.add(page.pageNumber);
    }
}

function logPopplerEnvironment(popplerEnv?: NodeJS.ProcessEnv) {
    if (popplerEnv) {
        log(
            'debug',
            `Poppler env: POPPLER_DATADIR=${popplerEnv.POPPLER_DATADIR?.length ? popplerEnv.POPPLER_DATADIR : 'unset'}, FONTCONFIG_PATH=${popplerEnv.FONTCONFIG_PATH?.length ? popplerEnv.FONTCONFIG_PATH : 'unset'}, FONTCONFIG_FILE=${popplerEnv.FONTCONFIG_FILE?.length ? popplerEnv.FONTCONFIG_FILE : 'unset'}`,
        );
        return;
    }

    if (process.platform === 'win32') {
        log('warn', 'Poppler env data/config paths are unavailable; Windows builds may crash if Poppler runtime assets are missing');
    }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseNativePageSizesPayload(payload: unknown) {
    if (!isObjectRecord(payload) || !Array.isArray(payload.pages)) {
        return null;
    }

    const pageSizes = new Map<number, IOcrPageSizeInches>();
    for (const page of payload.pages) {
        if (!isObjectRecord(page)) {
            return null;
        }

        const {
            pageNumber,
            widthInches,
            heightInches,
        } = page;
        if (
            typeof pageNumber !== 'number'
            || !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || typeof widthInches !== 'number'
            || !Number.isFinite(widthInches)
            || widthInches <= 0
            || typeof heightInches !== 'number'
            || !Number.isFinite(heightInches)
            || heightInches <= 0
        ) {
            return null;
        }

        pageSizes.set(pageNumber, {
            width: widthInches,
            height: heightInches,
        });
    }

    return pageSizes;
}

async function readPdfPageSizesInchesNative(pdfPath: string, signal?: AbortSignal) {
    if (!paths.pdfPageOpsBinary) {
        return null;
    }

    let tempDir: string | null = null;
    try {
        tempDir = await mkdtemp(join(paths.tempDir, 'ocr-page-sizes-'));
        const outputPath = join(tempDir, 'page-sizes.json');
        await runOcrCommand(paths.pdfPageOpsBinary, [
            'page-sizes',
            '--input',
            pdfPath,
            '--output',
            outputPath,
        ], {
            timeoutMs: OCR_PAGE_SIZES_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(page-sizes)',
            ...(signal ? { signal } : {}),
        });
        const payload: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
        return parseNativePageSizesPayload(payload);
    } catch (error) {
        log('debug', `Native PDF page-size inspection failed for OCR resource budgeting; falling back to pdf-lib: ${getErrorMessage(error)}`);
        return null;
    } finally {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }
}

async function readPdfPageSizesInches(pdfPath: string, signal?: AbortSignal) {
    const nativePageSizes = await readPdfPageSizesInchesNative(pdfPath, signal);
    if (nativePageSizes) {
        return nativePageSizes;
    }

    try {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('OCR job canceled');
        }
        await assertPdfPageSizeFallbackInputSafe(pdfPath, OCR_PAGE_SIZE_FALLBACK_MAX_INPUT_BYTES);
        const pdfBytes = await readFile(pdfPath);
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('OCR job canceled');
        }
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pageSizes = new Map<number, IOcrPageSizeInches>();
        pdfDoc.getPages().forEach((page, index) => {
            const size = page.getSize();
            if (size.width > 0 && size.height > 0) {
                pageSizes.set(index + 1, {
                    width: size.width / 72,
                    height: size.height / 72,
                });
            }
        });
        return pageSizes;
    } catch (err) {
        log('debug', `Unable to inspect PDF page sizes for OCR resource budgeting; using fallback page size: ${getErrorMessage(err)}`);
        return new Map<number, IOcrPageSizeInches>();
    }
}

async function buildOcrPageProcessingPlan(
    pages: IOcrPdfPageRequest[],
    popplerSourcePdfPath: string,
    renderDpi: number | undefined,
    popplerEnv: NodeJS.ProcessEnv | undefined,
    baseContext: Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads' | 'pageSizeByNumber' | 'pageSourceDpiByNumber'>,
    sendStage: (phase: TOcrProgressPhase) => void,
) {
    const targetPages = pages;
    sendStage('dpi-inspection');
    const detectedSourceDpi = renderDpi === undefined
        ? await detectSourceDpiDetails(
            popplerSourcePdfPath,
            paths.pdfimagesBinary,
            log,
            popplerEnv,
            baseContext.signal,
            targetPages.map(page => page.pageNumber),
        )
        : {
            documentDpi: renderDpi,
            pageDpiByNumber: new Map<number, number>(),
        };
    const detectedDpi = detectedSourceDpi.documentDpi;
    const extractionDpi = clampDpi(detectedDpi ?? 300);
    const concurrency = getOcrConcurrency(targetPages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);
    sendStage('page-size-probing');
    const pageSizeByNumber = await readPdfPageSizesInches(popplerSourcePdfPath, baseContext.signal);

    log('debug', `OCR PDF: pages=${targetPages.length}, dpi=${extractionDpi}, concurrency=${concurrency}, threads=${tesseractThreads}`);

    return {
        targetPages,
        concurrency,
        effectiveRenderDpi: extractionDpi,
        pageContext: {
            ...baseContext,
            extractionDpi,
            tesseractThreads,
            pageSizeByNumber,
            pageSourceDpiByNumber: detectedSourceDpi.pageDpiByNumber,
        },
    };
}

function sendEmptyOcrResultFailure(
    jobId: string,
    errors: string[],
) {
    log('error', `OCR failed to produce searchable output. errors=${errors.join(' | ') || 'none'}`);
    sendComplete(jobId, {
        success: false,
        errors,
    });
}

async function assembleMergedOcrPdf(
    jobId: string,
    sourcePdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageCount: number,
    sessionId: string,
    trackTempFile: (path: string) => string,
    errors: string[],
    signal: AbortSignal,
) {
    try {
        return await assembleSearchablePdf(
            paths.qpdfBinary,
            sourcePdfPath,
            ocrPdfMap,
            pageCount,
            paths.tempDir,
            sessionId,
            log,
            trackTempFile,
            signal,
        );
    } catch (mergeErr) {
        const errMsg = getErrorMessage(mergeErr);
        errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
        sendComplete(jobId, {
            success: false,
            errors,
        });
        return null;
    }
}

async function cleanupTempFiles(
    tempFiles: Set<string>,
    keepFiles: Set<string>,
) {
    for (const filePath of tempFiles) {
        if (keepFiles.has(filePath)) {
            continue;
        }
        await unlinkIfPresent(filePath);
    }
}

async function sha256File(path: string) {
    const hash = createHash('sha256');
    for await (const rawChunk of createReadStream(path)) {
        const chunk: unknown = rawChunk;
        if (!(chunk instanceof Uint8Array)) {
            throw new Error('OCR result stream returned a non-binary chunk');
        }
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function processOcrJob(
    jobId: string,
    sourcePdfPath: string,
    documentRevision: IDocumentRevisionInfo,
    pages: IOcrPdfPageRequest[],
    options: IOcrSearchablePdfOptions = {},
) {
    const abortController = new AbortController();
    activeJobControllers.set(jobId, abortController);
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();
    const jobWarnings: string[] = [];
    const jobDiagnostics: IOcrDiagnostic[] = [];
    let durableManifest: Awaited<ReturnType<typeof createOcrJobManifestController>> | null = null;

    const trackTempFile = (filePath: string) => {
        tempFiles.add(filePath);
        return filePath;
    };

    try {
        assertUniqueOcrPageNumbers(pages);
        await validateSourcePdf(jobId, sourcePdfPath, pages.length);

        const supersessionPolicy = options.supersessionPolicy ?? 'missing-only';
        if (supersessionPolicy === 'replace-all' && options.replaceAllAcknowledged !== true) {
            throw new Error('replace-all OCR requires explicit acknowledgement');
        }
        const selection = await selectOcrPagesForSupersession({
            sourcePdfPath,
            documentRevisionToken: documentRevision.token,
            pages,
            supersessionPolicy,
            ...(paths.pdftotextBinary ? {pdftotextBinary: paths.pdftotextBinary} : {}),
            log,
            signal: abortController.signal,
        });
        jobWarnings.push(...selection.warnings);
        jobDiagnostics.push(...selection.diagnostics);
        if (selection.pages.length === 0) {
            sendComplete(jobId, {
                success: false,
                errors: [
                    ...jobWarnings,
                    'No pages require OCR under the selected text supersession policy',
                ],
                diagnostics: jobDiagnostics,
            });
            return;
        }
        pages = selection.pages;

        const sessionId = `ocr-${randomUUID()}`;
        const checkpointFingerprint = createHash('sha256').update(JSON.stringify({
            sourcePdfPath,
            documentRevision: documentRevision.token,
            pages: pages.map(page => ({
                pageNumber: page.pageNumber,
                languages: [...page.languages].sort(),
            })),
            options,
        })).digest('hex');
        const checkpointDir = join(paths.tempDir, 'ocr-checkpoints', checkpointFingerprint);
        await mkdir(checkpointDir, {recursive: true});
        const checkpointRoot = join(paths.tempDir, 'ocr-checkpoints');
        await cleanupStaleOcrJobDirectories(checkpointRoot);
        durableManifest = await createOcrJobManifestController(checkpointDir, checkpointFingerprint);
        await durableManifest.markNode('model', 'verified');
        await durableManifest.markNode('normalized-source', 'running');
        sendStageProgress(jobId, pages, 'pdf-prep');
        const preparedPopplerPdf = await preparePdfForPoppler(
            paths,
            log,
            sourcePdfPath,
            sessionId,
            trackTempFile,
            abortController.signal,
        );
        const popplerSourcePdfPath = preparedPopplerPdf.pdfPath;
        await durableManifest.markNode('normalized-source', 'verified');
        jobWarnings.push(...preparedPopplerPdf.warnings);
        const popplerEnv = buildPopplerEnv(paths);
        logPopplerEnvironment(popplerEnv);

        const planOptions: Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads' | 'pageSizeByNumber' | 'pageSourceDpiByNumber'> = {
            sessionId,
            jobId,
            popplerSourcePdfPath,
            signal: abortController.signal,
            options,
            checkpointDir,
            checkpointPage: pageNumber => durableManifest!.markPageVerified(pageNumber),
            trackTempFile,
        };
        if (popplerEnv !== undefined) {
            planOptions.popplerEnv = popplerEnv;
        }
        const {
            targetPages,
            concurrency,
            pageContext,
        } = await buildOcrPageProcessingPlan(
            pages,
            popplerSourcePdfPath,
            options.renderDpi,
            popplerEnv,
            planOptions,
            phase => sendStageProgress(jobId, pages, phase),
        );
        await durableManifest.markNode('page-raster', 'running');
        await durableManifest.markNode('preprocessed', 'running');
        await durableManifest.markNode('recognized-page', 'running');
        const {
            errors,
            ocrPageData,
            ocrPdfMap,
            effectiveRenderDpi: actualRenderDpi,
            diagnostics: pageDiagnostics,
        } = await processOcrPages(jobId, targetPages, concurrency, pageContext);
        jobDiagnostics.push(...pageDiagnostics);
        await durableManifest.markNode('page-raster', 'verified');
        await durableManifest.markNode('preprocessed', 'verified');
        await durableManifest.markNode('recognized-page', 'verified');
        const completionMessages = [
            ...jobWarnings,
            ...errors,
        ];

        log('debug', `OCR done. ocrPageData=${ocrPageData.length}, ocrPdfMap=${ocrPdfMap.size}, errors=${errors.length}, renderDpi=${actualRenderDpi}`);

        sendProgress(
            jobId,
            targetPages[targetPages.length - 1]?.pageNumber ?? 0,
            targetPages.length,
            targetPages.length,
            { phase: 'processing' },
        );

        if (ocrPageData.length === 0 || ocrPdfMap.size === 0) {
            sendEmptyOcrResultFailure(jobId, completionMessages);
            return;
        }

        const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
        const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;
        const pageCountResult = await getPageCount(paths.qpdfBinary, sourcePdfPath, maxOcrPage, abortController.signal);
        const pageCount = pageCountResult.pageCount;
        completionMessages.push(...pageCountResult.warnings);

        sendStageProgress(jobId, targetPages, 'merging');
        await durableManifest.markNode('assembled-document', 'running');
        const mergedPdfPath = await assembleMergedOcrPdf(
            jobId,
            sourcePdfPath,
            ocrPdfMap,
            pageCount,
            sessionId,
            trackTempFile,
            completionMessages,
            abortController.signal,
        );
        if (!mergedPdfPath) {
            await durableManifest.setTerminal('failed');
            return;
        }
        await durableManifest.markNode('assembled-document', 'verified');

        const allLanguages = uniq(targetPages.flatMap(p => p.languages));
        sendStageProgress(jobId, targetPages, 'indexing');
        await durableManifest.markNode('text-catalog', 'running');
        completionMessages.push(...await writeOcrIndexes(
            sourcePdfPath,
            mergedPdfPath,
            documentRevision,
            ocrPageData,
            pageCount,
            allLanguages,
            actualRenderDpi,
            abortController.signal,
        ));
        await durableManifest.markNode('text-catalog', 'verified');
        await durableManifest.markNode('verified-result', 'verified');
        sendProgress(
            jobId,
            targetPages[targetPages.length - 1]?.pageNumber ?? 0,
            targetPages.length,
            targetPages.length,
            {
                phase: 'indexing',
                phaseProgress: 100,
            },
        );

        keepFiles.add(mergedPdfPath);
        await durableManifest.setTerminal('completed');
        sendComplete(jobId, {
            success: true,
            pdfPath: mergedPdfPath,
            sourceDocumentRevisionToken: documentRevision.token,
            resultSha256: await sha256File(mergedPdfPath),
            requiresCleanupAck: true,
            errors: completionMessages,
            diagnostics: jobDiagnostics,
        });
    } catch (err) {
        const errMsg = getErrorMessage(err);
        if (isAbortError(err)) {
            await durableManifest?.setTerminal('cancelled').catch(() => undefined);
            log('debug', `OCR job ${jobId} aborted: ${errMsg}`);
            sendComplete(jobId, {
                success: false,
                errors: [errMsg],
            });
            return;
        }
        log('error', `CRITICAL ERROR in processOcrJob: ${errMsg}`);
        await durableManifest?.setTerminal('failed').catch(() => undefined);
        sendComplete(jobId, {
            success: false,
            errors: [`Critical error: ${errMsg}`],
        });
    } finally {
        activeJobControllers.delete(jobId);
        await cleanupTempFiles(tempFiles, keepFiles);
        sendCleanupComplete(jobId);
    }
}

parentPort?.on('message', async (rawMessage: unknown) => {
    const message = parseOcrWorkerInboundMessage(rawMessage);
    if (!message) {
        const invalidStart = parseInvalidOcrWorkerStartMessage(rawMessage);
        if (invalidStart) {
            log('warn', invalidStart.error);
            sendComplete(invalidStart.jobId, {
                success: false,
                errors: [invalidStart.error],
                errorEnvelope: buildOcrErrorEnvelope(
                    'OCR_INVALID_PAYLOAD',
                    invalidStart.error,
                ),
            });
            sendCleanupComplete(invalidStart.jobId);
            return;
        }

        log('warn', 'Ignoring malformed inbound OCR worker message');
        return;
    }

    switch (message.type) {
        case 'start':
            await processOcrJob(
                message.jobId,
                message.data.sourcePdfPath,
                message.data.documentRevision,
                message.data.pages,
                message.data.options ?? (message.data.renderDpi !== undefined ? {renderDpi: message.data.renderDpi} : {}),
            );
            return;
        case 'cancel':
            activeJobControllers.get(message.jobId)?.abort();
            return;
        case 'resource-acquired': {
            const pending = pendingResourceAcquires.get(message.requestId);
            if (!pending) {
                releaseOcrResourceSlot(message.jobId, message.token);
                return;
            }
            pending.resolve({
                token: message.token,
                effectiveDpi: message.effectiveDpi,
            });
            return;
        }
        case 'resource-denied': {
            const pending = pendingResourceAcquires.get(message.requestId);
            pendingResourceAcquires.delete(message.requestId);
            pending?.reject(new Error(message.reason));
            return;
        }
    }
});

log('debug', 'OCR worker initialized and ready');
