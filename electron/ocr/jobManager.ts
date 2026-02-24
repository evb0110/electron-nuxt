import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    app,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { ensureTessdataLanguages } from '@electron/ocr/language-models';
import { getOcrToolPaths } from '@electron/ocr/paths';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');
const OCR_WORKER_POOL_SIZE = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_POOL_SIZE ?? '2', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 2;
    }
    return parsed;
})();

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

interface IOcrQueuedJob {
    jobId: string;
    webContentsId: number;
    originalPdfData: Uint8Array;
    pages: IOcrPdfPageRequest[];
    workingCopyPath?: string;
    renderDpi?: number;
    queuedAtMs: number;
    requestedBytes: number;
}

interface IOcrActiveJob extends IOcrQueuedJob {
    worker: Worker;
    completed: boolean;
    terminatedByUs: boolean;
    startedAtMs: number;
}

interface IOcrPendingResultFile {
    jobId: string;
    webContentsId: number;
    pdfPath: string;
    createdAtMs: number;
}

type TWorkerMessage = {
    type: 'progress' | 'complete' | 'log';
    jobId?: string;
    progress?: {
        requestId: string;
        currentPage: number;
        processedCount: number;
        totalPages: number;
    };
    result?: {
        success: boolean;
        pdfData: Uint8Array | null;
        pdfPath?: string;
        requiresCleanupAck?: boolean;
        errors: string[];
    };
    level?: string;
    message?: string;
};

const activeJobs = new Map<string, IOcrActiveJob>();
const queuedJobs: IOcrQueuedJob[] = [];
const queuedJobIds = new Set<string>();
const cancelledJobs = new Set<string>();
const pendingResultFiles = new Map<string, IOcrPendingResultFile>();
const OCR_QUEUE_MAX_SIZE = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_QUEUE_MAX_SIZE ?? '8', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 8;
    }
    return parsed;
})();
const OCR_QUEUE_MAX_BUFFERED_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_QUEUE_MAX_BUFFERED_MB ?? '768', 10);
    if (!Number.isFinite(parsed) || parsed < 32) {
        return 768 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const OCR_QUEUE_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_QUEUE_MAX_AGE_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 10 * 60 * 1000;
    }
    return parsed;
})();
const OCR_RESULT_FILE_ACK_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_RESULT_FILE_TTL_MS ?? `${15 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 15 * 60 * 1000;
    }
    return parsed;
})();

function asTransferableBytes(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes;
    }
    return bytes.slice();
}

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch (err) {
        log.debug(`Failed to send IPC message to channel "${channel}": ${err instanceof Error ? err.message : String(err)}`);
    }
}

function getJobWindow(webContentsId: number) {
    return BrowserWindow.getAllWindows().find(
        window => window.webContents.id === webContentsId,
    );
}

function getWorkerPath(): string {
    const defaultPath = join(__dirname, 'ocr-worker.js');
    if (!app?.isPackaged && existsSync(defaultPath)) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    if (existsSync(defaultPath)) {
        return defaultPath;
    }

    throw new Error(`OCR worker script not found. lookedFor="${unpackedPath}", fallback="${defaultPath}"`);
}

function getBufferedBytes() {
    const activeBytes = Array.from(activeJobs.values()).reduce(
        (total, job) => total + job.requestedBytes,
        0,
    );
    const queuedBytes = queuedJobs.reduce(
        (total, job) => total + job.requestedBytes,
        0,
    );
    return activeBytes + queuedBytes;
}

function evictStaleQueuedJobs(nowMs = Date.now()) {
    if (queuedJobs.length === 0) {
        return;
    }

    const staleJobs = queuedJobs.filter(
        (job) => nowMs - job.queuedAtMs > OCR_QUEUE_MAX_AGE_MS,
    );
    if (staleJobs.length === 0) {
        return;
    }

    for (const staleJob of staleJobs) {
        removeQueuedJob(staleJob.jobId);
        sendJobFailure(staleJob, 'OCR queue item expired before processing');
    }

    log.warn(`Evicted ${staleJobs.length} stale OCR queue jobs`);
}

async function removeResultFile(path: string) {
    try {
        await unlink(path);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
            log.warn(`Failed to cleanup OCR temp result file "${path}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

function trackPendingResultFile(jobId: string, webContentsId: number, pdfPath: string) {
    const normalizedPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    pendingResultFiles.set(jobId, {
        jobId,
        webContentsId,
        pdfPath: normalizedPath,
        createdAtMs: Date.now(),
    });
}

async function evictStaleResultFiles(nowMs = Date.now()) {
    if (pendingResultFiles.size === 0) {
        return;
    }

    const staleEntries = Array.from(pendingResultFiles.values())
        .filter(entry => nowMs - entry.createdAtMs > OCR_RESULT_FILE_ACK_TTL_MS);
    if (staleEntries.length === 0) {
        return;
    }

    for (const entry of staleEntries) {
        pendingResultFiles.delete(entry.jobId);
        await removeResultFile(entry.pdfPath);
    }

    log.warn(`Cleaned up ${staleEntries.length} stale OCR result file(s) without renderer acknowledgement`);
}

function ensureQueueCapacity(additionalBytes: number) {
    if (queuedJobs.length >= OCR_QUEUE_MAX_SIZE) {
        return {
            ok: false,
            error: `OCR queue is full (${OCR_QUEUE_MAX_SIZE} jobs)`,
        };
    }

    const bufferedBytes = getBufferedBytes();
    if (bufferedBytes + additionalBytes > OCR_QUEUE_MAX_BUFFERED_BYTES) {
        return {
            ok: false,
            error: `OCR queue is full (buffer cap ${Math.floor(OCR_QUEUE_MAX_BUFFERED_BYTES / (1024 * 1024))}MB reached)`,
        };
    }

    return { ok: true };
}

function estimateRequestBytes(
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
) {
    const averagePageOverhead = 32 * 1024;
    return originalPdfData.byteLength + (pages.length * averagePageOverhead);
}

function logQueueDepth(context: string) {
    log.debug(
        `${context}: active=${activeJobs.size}/${OCR_WORKER_POOL_SIZE}, queued=${queuedJobs.length}/${OCR_QUEUE_MAX_SIZE}, bufferedMB=${(getBufferedBytes() / (1024 * 1024)).toFixed(1)}`,
    );
}

function createOcrWorker(): Worker {
    const paths = getOcrToolPaths();
    const workerPath = getWorkerPath();

    if (!existsSync(workerPath)) {
        throw new Error(`OCR worker unavailable at path: ${workerPath}`);
    }

    log.debug(`Creating OCR worker: ${workerPath}`);
    log.debug(
        `Tool paths: tesseract=${paths.tesseract}, pdftoppm=${paths.pdftoppm}, qpdf=${paths.qpdf}, popplerData=${paths.popplerDataDir || 'none'}, fontConfig=${paths.popplerFontConfigDir || 'none'}`,
    );

    return new Worker(workerPath, {workerData: {
        tesseractBinary: paths.tesseract,
        tessdataPath: paths.tessdata,
        pdftoppmBinary: paths.pdftoppm,
        pdftotextBinary: paths.pdftotext,
        pdfimagesBinary: paths.pdfimages,
        popplerDataDir: paths.popplerDataDir,
        popplerFontConfigDir: paths.popplerFontConfigDir,
        qpdfBinary: paths.qpdf,
        unpaperBinary: paths.unpaper,
        tempDir: app.getPath('temp'),
    }});
}

function removeQueuedJob(jobId: string) {
    const index = queuedJobs.findIndex(job => job.jobId === jobId);
    if (index === -1) {
        return null;
    }

    const [job] = queuedJobs.splice(index, 1);
    queuedJobIds.delete(jobId);
    return job ?? null;
}

function sendJobFailure(job: IOcrQueuedJob, error: string) {
    const window = getJobWindow(job.webContentsId);
    safeSendToWindow(window, 'ocr:complete', {
        requestId: job.jobId,
        success: false,
        pdfData: null,
        errors: [error],
    });
}

function finalizeActiveJob(jobId: string) {
    activeJobs.delete(jobId);
    dispatchQueuedJobs();
}

function handleWorkerMessage(
    jobId: string,
    webContentsId: number,
    message: TWorkerMessage,
) {
    const window = getJobWindow(webContentsId);

    if (message.type === 'log') {
        const logLevel = message.level || 'debug';
        if (logLevel === 'warn') {
            log.warn(message.message || '');
        } else if (logLevel === 'error') {
            log.error(`[worker-error] ${message.message || ''}`);
        } else {
            log.debug(`[worker] ${message.message || ''}`);
        }
        return;
    }

    if (message.type === 'progress' && message.progress) {
        safeSendToWindow(window, 'ocr:progress', message.progress);
        return;
    }

    if (message.type === 'complete' && message.result) {
        if (message.result.success && message.result.pdfPath) {
            trackPendingResultFile(jobId, webContentsId, message.result.pdfPath);
            void evictStaleResultFiles();
        }

        safeSendToWindow(window, 'ocr:complete', {
            requestId: jobId,
            ...message.result,
        });

        const job = activeJobs.get(jobId);
        if (job) {
            job.completed = true;
            job.terminatedByUs = true;
            void job.worker.terminate();
        }
        return;
    }
}

function startQueuedJob(job: IOcrQueuedJob) {
    queuedJobIds.delete(job.jobId);

    let worker: Worker;
    try {
        worker = createOcrWorker();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJobFailure(job, `OCR worker unavailable: ${message}`);
        log.error(`Failed to start OCR worker for job ${job.jobId}: ${message}`);
        dispatchQueuedJobs();
        return;
    }

    const activeJob: IOcrActiveJob = {
        ...job,
        worker,
        completed: false,
        terminatedByUs: false,
        startedAtMs: Date.now(),
    };
    activeJobs.set(job.jobId, activeJob);
    logQueueDepth(`OCR job ${job.jobId} activated`);

    worker.on('message', (message: TWorkerMessage) => {
        handleWorkerMessage(job.jobId, job.webContentsId, message);
    });

    worker.on('error', (err: Error) => {
        if (cancelledJobs.has(job.jobId)) {
            cancelledJobs.delete(job.jobId);
            finalizeActiveJob(job.jobId);
            return;
        }

        log.error(`Worker error for job ${job.jobId}: ${err.message}`);
        const active = activeJobs.get(job.jobId);
        if (active) {
            active.completed = true;
        }
        sendJobFailure(job, `Worker error: ${err.message}`);
        finalizeActiveJob(job.jobId);
    });

    worker.on('exit', (code) => {
        const wasCanceled = cancelledJobs.has(job.jobId);
        if (wasCanceled) {
            cancelledJobs.delete(job.jobId);
        }

        const active = activeJobs.get(job.jobId);
        const wasCompletedOrTerminated = wasCanceled || active?.completed || active?.terminatedByUs;

        if (code !== 0 && !wasCompletedOrTerminated) {
            log.error(`Worker exited with code ${code} for job ${job.jobId}`);
            sendJobFailure(job, `Worker exited unexpectedly with code ${code}`);
        }

        finalizeActiveJob(job.jobId);
    });

    try {
        const transferPdfData = asTransferableBytes(job.originalPdfData);
        worker.postMessage({
            type: 'start',
            jobId: job.jobId,
            data: {
                originalPdfData: transferPdfData,
                pages: job.pages,
                workingCopyPath: job.workingCopyPath,
                renderDpi: job.renderDpi,
            },
        }, [transferPdfData.buffer as ArrayBuffer]);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        sendJobFailure(job, `Failed to post OCR job to worker: ${errMsg}`);
        const active = activeJobs.get(job.jobId);
        if (active) {
            active.completed = true;
            active.terminatedByUs = true;
            void active.worker.terminate();
        }
        finalizeActiveJob(job.jobId);
        return;
    }

    log.debug(`OCR job ${job.jobId} started in worker thread`);
}

function dispatchQueuedJobs() {
    evictStaleQueuedJobs();

    while (activeJobs.size < OCR_WORKER_POOL_SIZE && queuedJobs.length > 0) {
        const nextJob = queuedJobs.shift();
        if (!nextJob) {
            return;
        }
        startQueuedJob(nextJob);
    }
}

export async function handleOcrCreateSearchablePdfAsync(
    event: IpcMainInvokeEvent,
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    workingCopyPath?: string,
    renderDpi?: number,
): Promise<{
    started: boolean;
    jobId: string;
    error?: string;
}> {
    log.debug(`handleOcrCreateSearchablePdfAsync called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}, dpi=${renderDpi}`);

    try {
        evictStaleQueuedJobs();
        await evictStaleResultFiles();

        if (activeJobs.has(requestId) || queuedJobIds.has(requestId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }

        const requestBytes = estimateRequestBytes(originalPdfData, pages);
        const capacityResult = ensureQueueCapacity(requestBytes);
        if (!capacityResult.ok) {
            return {
                started: false,
                jobId: requestId,
                error: capacityResult.error,
            };
        }

        const languages = Array.from(new Set(pages.flatMap(page => page.languages)));
        const tessdataDir = getOcrToolPaths().tessdata;
        const missingLanguages = languages.filter(languageCode =>
            !existsSync(join(tessdataDir, `${languageCode}.traineddata`)),
        );
        if (missingLanguages.length > 0) {
            log.warn(`Missing OCR language models in ${tessdataDir}; downloading: ${missingLanguages.join(', ')}`);
        }
        await ensureTessdataLanguages(languages);

        const queuedJob: IOcrQueuedJob = {
            jobId: requestId,
            webContentsId: event.sender.id,
            originalPdfData,
            pages,
            workingCopyPath,
            renderDpi,
            queuedAtMs: Date.now(),
            requestedBytes: requestBytes,
        };
        queuedJobs.push(queuedJob);
        queuedJobIds.add(requestId);
        logQueueDepth(`OCR job ${requestId} queued`);
        dispatchQueuedJobs();

        return {
            started: true,
            jobId: requestId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to queue OCR worker job: ${errMsg}`);
        return {
            started: false,
            jobId: requestId,
            error: errMsg,
        };
    }
}

export async function handleOcrAcknowledgeResultFile(
    event: IpcMainInvokeEvent,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
): Promise<{
    cleaned: boolean;
    error?: string; 
}> {
    await evictStaleResultFiles();

    const requestId = typeof requestIdPayload === 'string' ? requestIdPayload.trim() : '';
    if (!requestId) {
        return {
            cleaned: false,
            error: 'requestId must be a non-empty string',
        };
    }

    const pending = pendingResultFiles.get(requestId);
    if (!pending) {
        return {
            cleaned: false,
            error: `No pending OCR result file for requestId "${requestId}"`,
        };
    }

    if (pending.webContentsId !== event.sender.id) {
        return {
            cleaned: false,
            error: 'OCR result acknowledgement sender mismatch',
        };
    }

    if (typeof pdfPathPayload === 'string' && pdfPathPayload.trim().length > 0) {
        const normalizedPayloadPath = pdfPathPayload.trim();
        if (normalizedPayloadPath !== pending.pdfPath) {
            return {
                cleaned: false,
                error: 'Acknowledged OCR result path does not match pending result path',
            };
        }
    }

    pendingResultFiles.delete(requestId);
    await removeResultFile(pending.pdfPath);
    return { cleaned: true };
}

export function handleOcrCancel(
    _event: IpcMainInvokeEvent,
    requestId: string,
): { canceled: boolean } {
    log.info(`[${requestId}] Cancel requested`);

    const queued = removeQueuedJob(requestId);
    if (queued) {
        log.info(`[${requestId}] Queued OCR job cancelled`);
        return { canceled: true };
    }

    const activeJob = activeJobs.get(requestId);
    if (!activeJob) {
        log.info(`[${requestId}] No active OCR job found for cancel`);
        return { canceled: false };
    }

    activeJob.completed = true;
    activeJob.terminatedByUs = true;
    cancelledJobs.add(requestId);
    void activeJob.worker.terminate();
    finalizeActiveJob(requestId);
    log.info(`[${requestId}] Active OCR job cancelled`);
    return { canceled: true };
}
