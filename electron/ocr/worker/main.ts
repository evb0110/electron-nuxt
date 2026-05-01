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
import { randomUUID } from 'node:crypto';
import {
    readFile,
    stat,
    unlink,
} from 'fs/promises';
import { join } from 'path';
import { uniq } from 'es-toolkit/array';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '../../utils/concurrency';
import type {
    TOcrWorkerCompleteResult,
    TOcrWorkerLogMessage,
    TOcrWorkerOutboundMessage,
    IOcrPageWithWords,
    IOcrPdfPageRequest,
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    clampDpi,
    detectSourceDpi,
} from '@electron/ocr/worker/dpi-detection';
import {
    getPngDimensions,
    runOcrFileBased,
} from '@electron/ocr/worker/tesseract-runner';
import {
    assembleSearchablePdf,
    getPageCount,
} from '@electron/ocr/worker/pdf-assembler';
import {
    resolveSafeOcrIndexBasePath,
    writeOcrIndexV1,
    writeOcrIndexV2,
} from '@electron/ocr/worker/index-writer';
import { runOcrCommand } from '@electron/ocr/worker/run-command';
import { getErrorMessage } from '@electron/utils/error';

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }
    if (!value.every(item => typeof item === 'string')) {
        return null;
    }
    return value;
}

function parsePdfPageRequest(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    if (typeof value.pageNumber !== 'number' || !Number.isFinite(value.pageNumber)) {
        return null;
    }
    const languages = toStringArray(value.languages);
    if (!languages) {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        languages,
    };
}

function parsePdfPageRequests(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }

    const pages: IOcrPdfPageRequest[] = [];
    for (const page of value) {
        const parsedPage = parsePdfPageRequest(page);
        if (!parsedPage) {
            return null;
        }
        pages.push(parsedPage);
    }

    return pages;
}

function parseOptionalDpi(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

interface IOcrWorkerStartPayload {
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
}

function parseStartPayload(value: unknown): IOcrWorkerStartPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    const sourcePdfPath = typeof value.sourcePdfPath === 'string'
        ? value.sourcePdfPath.trim()
        : '';
    const pages = parsePdfPageRequests(value.pages);
    if (!sourcePdfPath || !pages) {
        return null;
    }

    return {
        sourcePdfPath,
        pages,
        renderDpi: parseOptionalDpi(value.renderDpi),
    };
}

type TOcrWorkerParsedInboundMessage =
    | {
        type: 'start';
        jobId: string;
        data: IOcrWorkerStartPayload;
    }
    | {
        type: 'cancel';
        jobId: string;
    };

function parseInboundMessage(value: unknown): TOcrWorkerParsedInboundMessage | null {
    if (!isRecord(value) || typeof value.jobId !== 'string') {
        return null;
    }

    if (value.type === 'cancel') {
        return {
            type: 'cancel',
            jobId: value.jobId,
        };
    }

    if (value.type !== 'start') {
        return null;
    }

    const data = parseStartPayload(value.data);
    if (!data) {
        return null;
    }

    return {
        type: 'start',
        jobId: value.jobId,
        data,
    };
}

function readRequiredPath(
    data: Record<string, unknown>,
    key: keyof IWorkerPaths,
): string {
    const value = data[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Invalid OCR workerData.${String(key)} path`);
    }
    return value;
}

function readOptionalPath(
    data: Record<string, unknown>,
    key: keyof IWorkerPaths,
): string | undefined {
    const value = data[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    return value;
}

function resolveWorkerPaths(rawWorkerData: unknown) {
    if (!isRecord(rawWorkerData)) {
        throw new Error('Invalid OCR workerData payload');
    }
    return {
        tesseractBinary: readRequiredPath(rawWorkerData, 'tesseractBinary'),
        tessdataPath: readRequiredPath(rawWorkerData, 'tessdataPath'),
        pdftoppmBinary: readRequiredPath(rawWorkerData, 'pdftoppmBinary'),
        pdftotextBinary: readRequiredPath(rawWorkerData, 'pdftotextBinary'),
        pdfimagesBinary: readOptionalPath(rawWorkerData, 'pdfimagesBinary'),
        popplerDataDir: readOptionalPath(rawWorkerData, 'popplerDataDir'),
        popplerFontConfigDir: readOptionalPath(rawWorkerData, 'popplerFontConfigDir'),
        qpdfBinary: readRequiredPath(rawWorkerData, 'qpdfBinary'),
        unpaperBinary: readOptionalPath(rawWorkerData, 'unpaperBinary'),
        tempDir: readRequiredPath(rawWorkerData, 'tempDir'),
    };
}

const paths = resolveWorkerPaths(workerData);
const activeJobControllers = new Map<string, AbortController>();

const log: TWorkerLog = (level, message) => {
    const timestamp = new Date().toISOString();
    const payload: TOcrWorkerLogMessage = {
        type: 'log',
        level,
        message: `[${timestamp}] [ocr-worker] ${message}`,
    };
    parentPort?.postMessage(payload);
};

function buildPopplerEnv() {
    const env: NodeJS.ProcessEnv = {};

    if (paths.popplerDataDir) {
        env.POPPLER_DATADIR = paths.popplerDataDir;
    }

    if (paths.popplerFontConfigDir) {
        env.FONTCONFIG_PATH = paths.popplerFontConfigDir;
        env.FONTCONFIG_FILE = join(paths.popplerFontConfigDir, 'fonts.conf');
    }

    if (Object.keys(env).length === 0) {
        return undefined;
    }

    return env;
}

async function renderPdfPageToPng(
    pageNumber: number,
    sourcePdfPath: string,
    outputPngPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
) {
    await runOcrCommand(paths.pdftoppmBinary, [
        '-png',
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        sourcePdfPath,
        outputPngPath.replace(/\.png$/, ''),
    ], {
        commandLabel: `pdftoppm(page=${pageNumber},dpi=${dpi})`,
        env: popplerEnv,
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        signal,
        log,
    });
}

async function preparePdfForPoppler(
    sourcePdfPath: string,
    sessionId: string,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
) {
    const normalizedPdfPath = trackTempFile(join(paths.tempDir, `${sessionId}-poppler-input.pdf`));

    try {
        await runOcrCommand(paths.qpdfBinary, [
            sourcePdfPath,
            normalizedPdfPath,
        ], {
            commandLabel: 'qpdf(poppler-preflight)',
            allowedExitCodes: [
                0,
                3,
            ],
            timeoutMs: QPDF_TIMEOUT_MS,
            signal,
            log,
        });

        const normalizedStat = await stat(normalizedPdfPath);
        if (normalizedStat.size <= 0) {
            throw new Error('qpdf produced an empty normalized PDF');
        }

        log('debug', `Prepared Poppler input via qpdf: ${normalizedPdfPath} (${normalizedStat.size} bytes)`);
        return normalizedPdfPath;
    } catch (err) {
        log('warn', `qpdf preflight failed; falling back to original PDF for Poppler commands: ${getErrorMessage(err)}`);
        return sourcePdfPath;
    }
}

function sendProgress(jobId: string, currentPage: number, processedCount: number, totalPages: number) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'progress',
        jobId,
        progress: {
            requestId: jobId,
            currentPage,
            processedCount,
            totalPages,
        },
    };
    parentPort?.postMessage(payload);
}

function sendComplete(jobId: string, result: TOcrWorkerCompleteResult) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'complete',
        jobId,
        result,
    };
    parentPort?.postMessage(payload);
}

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch {
        // Ignore cleanup errors
    }
}

function readPngDimensions(imageBuffer: Buffer) {
    const dims = getPngDimensions(imageBuffer);
    if (!dims) {
        throw new Error('Failed to determine PNG dimensions from pdftoppm output');
    }
    if (dims.width <= 0 || dims.height <= 0) {
        throw new Error(`Invalid page image dimensions: ${dims.width}x${dims.height}`);
    }
    return dims;
}

interface IOcrPageProcessingContext {
    sessionId: string;
    popplerSourcePdfPath: string;
    extractionDpi: number;
    tesseractThreads: number;
    popplerEnv?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    trackTempFile: (path: string) => string;
}

async function processOcrPage(
    page: IOcrPdfPageRequest,
    context: IOcrPageProcessingContext,
) {
    log('debug', `Processing page ${page.pageNumber}`);

    const pageImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}.png`));

    try {
        await renderPdfPageToPng(
            page.pageNumber,
            context.popplerSourcePdfPath,
            pageImagePath,
            context.extractionDpi,
            context.popplerEnv,
            context.signal,
        );

        const imageBuffer = await readFile(pageImagePath);
        const dims = readPngDimensions(imageBuffer);
        const ocrResult = await runOcrFileBased(
            pageImagePath,
            page.languages,
            dims.width,
            dims.height,
            context.extractionDpi,
            paths.tesseractBinary,
            paths.tessdataPath,
            context.tesseractThreads,
            context.signal,
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
        return {
            pageData,
            pdfPath: ocrResult.pdfPath,
        };
    } catch (err) {
        const errMsg = getErrorMessage(err);
        log('warn', `Failed to process page ${page.pageNumber}: ${errMsg}`);
        return { error: `Failed to process page ${page.pageNumber}: ${errMsg}` };
    } finally {
        await unlinkIfPresent(pageImagePath);
    }
}

async function processOcrPages(
    jobId: string,
    targetPages: IOcrPdfPageRequest[],
    concurrency: number,
    context: IOcrPageProcessingContext,
) {
    const errors: string[] = [];
    const ocrPageData: IOcrPageWithWords[] = [];
    const ocrPdfMap: Map<number, string> = new Map();
    let processedCount = 0;

    sendProgress(jobId, targetPages[0]?.pageNumber ?? 0, 0, targetPages.length);

    await forEachConcurrent(targetPages, concurrency, async (page) => {
        const result = await processOcrPage(page, context);
        if (result.pageData) {
            ocrPageData.push(result.pageData);
        }
        if (result.pdfPath) {
            ocrPdfMap.set(page.pageNumber, result.pdfPath);
        }
        if (result.error) {
            errors.push(result.error);
        }

        processedCount += 1;
        sendProgress(
            jobId,
            getSequentialProgressPage(targetPages, processedCount),
            processedCount,
            targetPages.length,
        );
    });

    ocrPageData.sort((a, b) => a.pageNumber - b.pageNumber);
    return {
        errors,
        ocrPageData,
        ocrPdfMap,
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
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    allLanguages: string[],
    effectiveRenderDpi: number,
) {
    const validatedWorkingCopyPath = await resolveOcrIndexPath(sourcePdfPath);
    if (!validatedWorkingCopyPath) {
        log('warn', 'Skipping OCR index writes due to invalid source PDF path');
        return;
    }

    try {
        await writeOcrIndexV2(
            validatedWorkingCopyPath,
            ocrPageData,
            pageCount,
            allLanguages,
            effectiveRenderDpi,
            log,
        );
    } catch (v2Err) {
        const v2ErrMsg = getErrorMessage(v2Err);
        log('warn', `Failed to write OCR index v2: ${v2ErrMsg}`);
    }

    try {
        await writeOcrIndexV1(validatedWorkingCopyPath, ocrPageData, pageCount);
    } catch {
        // Non-blocking - don't fail OCR if index save fails
    }
}

async function validateSourcePdf(jobId: string, sourcePdfPath: string, pageCount: number) {
    const sourceStat = await stat(sourcePdfPath);
    if (sourceStat.size <= 0) {
        throw new Error(`Source PDF is empty: ${sourcePdfPath}`);
    }
    log('debug', `Processing OCR job ${jobId}: sourcePath=${sourcePdfPath}, pdfBytes=${sourceStat.size}, pages=${pageCount}`);
}

function logPopplerEnvironment(popplerEnv?: NodeJS.ProcessEnv) {
    if (popplerEnv) {
        log(
            'debug',
            `Poppler env: POPPLER_DATADIR=${popplerEnv.POPPLER_DATADIR || 'unset'}, FONTCONFIG_PATH=${popplerEnv.FONTCONFIG_PATH || 'unset'}, FONTCONFIG_FILE=${popplerEnv.FONTCONFIG_FILE || 'unset'}`,
        );
        return;
    }

    if (process.platform === 'win32') {
        log('warn', 'Poppler env data/config paths are unavailable; Windows builds may crash if Poppler runtime assets are missing');
    }
}

async function buildOcrPageProcessingPlan(
    pages: IOcrPdfPageRequest[],
    popplerSourcePdfPath: string,
    renderDpi: number | undefined,
    popplerEnv: NodeJS.ProcessEnv | undefined,
    baseContext: Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads'>,
) {
    const targetPages = pages.filter((p): p is IOcrPdfPageRequest => !!p);
    const detectedDpi = renderDpi ?? await detectSourceDpi(popplerSourcePdfPath, paths.pdfimagesBinary, log, popplerEnv);
    const extractionDpi = clampDpi(detectedDpi ?? 300);
    const concurrency = getOcrConcurrency(targetPages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);

    log('debug', `OCR PDF: pages=${targetPages.length}, dpi=${extractionDpi}, concurrency=${concurrency}, threads=${tesseractThreads}`);

    return {
        targetPages,
        concurrency,
        effectiveRenderDpi: extractionDpi,
        pageContext: {
            ...baseContext,
            extractionDpi,
            tesseractThreads,
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
) {
    try {
        return await assembleSearchablePdf(
            sourcePdfPath,
            ocrPdfMap,
            pageCount,
            paths.tempDir,
            sessionId,
            paths.qpdfBinary,
            log,
            trackTempFile,
        );
    } catch (qpdfErr) {
        const errMsg = getErrorMessage(qpdfErr);
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

async function processOcrJob(
    jobId: string,
    sourcePdfPath: string,
    pages: IOcrPdfPageRequest[],
    renderDpi?: number,
) {
    const abortController = new AbortController();
    activeJobControllers.set(jobId, abortController);
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();

    const trackTempFile = (filePath: string) => {
        tempFiles.add(filePath);
        return filePath;
    };

    try {
        await validateSourcePdf(jobId, sourcePdfPath, pages.length);

        const sessionId = `ocr-${randomUUID()}`;
        const popplerSourcePdfPath = await preparePdfForPoppler(sourcePdfPath, sessionId, trackTempFile, abortController.signal);
        const popplerEnv = buildPopplerEnv();
        logPopplerEnvironment(popplerEnv);

        const {
            targetPages,
            concurrency,
            effectiveRenderDpi,
            pageContext,
        } = await buildOcrPageProcessingPlan(pages, popplerSourcePdfPath, renderDpi, popplerEnv, {
            sessionId,
            popplerSourcePdfPath,
            popplerEnv,
            signal: abortController.signal,
            trackTempFile,
        });

        const {
            errors,
            ocrPageData,
            ocrPdfMap,
        } = await processOcrPages(jobId, targetPages, concurrency, pageContext);

        log('debug', `OCR done. ocrPageData=${ocrPageData.length}, ocrPdfMap=${ocrPdfMap.size}, errors=${errors.length}, renderDpi=${effectiveRenderDpi}`);

        sendProgress(
            jobId,
            targetPages[targetPages.length - 1]?.pageNumber ?? 0,
            targetPages.length,
            targetPages.length,
        );

        if (ocrPageData.length === 0 || ocrPdfMap.size === 0) {
            sendEmptyOcrResultFailure(jobId, errors);
            return;
        }

        const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
        const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;
        const pageCount = await getPageCount(paths.qpdfBinary, sourcePdfPath, maxOcrPage);

        const mergedPdfPath = await assembleMergedOcrPdf(
            jobId,
            sourcePdfPath,
            ocrPdfMap,
            pageCount,
            sessionId,
            trackTempFile,
            errors,
        );
        if (!mergedPdfPath) {
            return;
        }

        const allLanguages = uniq(targetPages.flatMap(p => p.languages));
        await writeOcrIndexes(sourcePdfPath, ocrPageData, pageCount, allLanguages, effectiveRenderDpi);

        keepFiles.add(mergedPdfPath);
        sendComplete(jobId, {
            success: true,
            pdfPath: mergedPdfPath,
            requiresCleanupAck: true,
            errors,
        });
    } catch (err) {
        const errMsg = getErrorMessage(err);
        log('error', `CRITICAL ERROR in processOcrJob: ${errMsg}`);
        sendComplete(jobId, {
            success: false,
            errors: [`Critical error: ${errMsg}`],
        });
    } finally {
        activeJobControllers.delete(jobId);
        await cleanupTempFiles(tempFiles, keepFiles);
    }
}

parentPort?.on('message', async (rawMessage: unknown) => {
    const message = parseInboundMessage(rawMessage);
    if (!message) {
        log('warn', 'Ignoring malformed inbound OCR worker message');
        return;
    }

    switch (message.type) {
        case 'start':
            await processOcrJob(
                message.jobId,
                message.data.sourcePdfPath,
                message.data.pages,
                message.data.renderDpi,
            );
            return;
        case 'cancel':
            activeJobControllers.get(message.jobId)?.abort();
            return;
    }
});

log('debug', 'OCR worker initialized and ready');
