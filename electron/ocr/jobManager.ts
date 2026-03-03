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
import {
    stat,
    unlink,
} from 'fs/promises';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { uniq } from 'es-toolkit/array';
import { withTimeout } from 'es-toolkit/promise';
import { ensureTessdataLanguages } from '@electron/ocr/language-models';
import { getOcrToolPaths } from '@electron/ocr/paths';
import type {
    IOcrPdfPageRequest,
    TOcrWorkerInboundMessage,
    TOcrWorkerOutboundMessage,
} from '@electron/ocr/worker/types';
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

interface IOcrQueuedJob {
    jobId: string;
    webContentsId: number;
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
    queuedAtMs: number;
    requestedBytes: number;
}

interface IOcrActiveJob extends IOcrQueuedJob {
    worker: Worker;
    completed: boolean;
    terminatedByUs: boolean;
    startedAtMs: number;
    watchdogTimer: NodeJS.Timeout | null;
}

interface IOcrPendingResultFile {
    jobId: string;
    webContentsId: number;
    pdfPath: string;
    createdAtMs: number;
    cleanupTimer: NodeJS.Timeout | null;
}

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
const OCR_JOB_MAX_RUNTIME_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_JOB_MAX_RUNTIME_MS ?? `${15 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 15_000) {
        return 15 * 60 * 1000;
    }
    return parsed;
})();
const OCR_MODEL_PREP_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_MODEL_PREP_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const OCR_WORKER_TERMINATE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_TERMINATE_TIMEOUT_MS ?? '10000', 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 10_000;
    }
    return parsed;
})();
const registeredSenderCleanupIds = new Set<number>();

function assertNever(value: never): never {
    throw new Error(`Unhandled OCR worker outbound message: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function parseWorkerMessage(message: unknown): TOcrWorkerOutboundMessage | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'log':
            if (
                (message.level === 'debug' || message.level === 'warn' || message.level === 'error')
                && typeof message.message === 'string'
            ) {
                return {
                    type: 'log',
                    level: message.level,
                    message: message.message,
                };
            }
            return null;
        case 'progress':
            if (!isRecord(message.progress)) {
                return null;
            }
            if (
                typeof message.jobId === 'string'
                && typeof message.progress.requestId === 'string'
                && typeof message.progress.currentPage === 'number'
                && Number.isFinite(message.progress.currentPage)
                && typeof message.progress.processedCount === 'number'
                && Number.isFinite(message.progress.processedCount)
                && typeof message.progress.totalPages === 'number'
                && Number.isFinite(message.progress.totalPages)
            ) {
                return {
                    type: 'progress',
                    jobId: message.jobId,
                    progress: {
                        requestId: message.progress.requestId,
                        currentPage: message.progress.currentPage,
                        processedCount: message.progress.processedCount,
                        totalPages: message.progress.totalPages,
                    },
                };
            }
            return null;
        case 'complete':
            if (!isRecord(message.result)) {
                return null;
            }
            if (typeof message.jobId !== 'string' || typeof message.result.success !== 'boolean' || !isStringArray(message.result.errors)) {
                return null;
            }

            if (message.result.success) {
                const normalizedPdfPath = typeof message.result.pdfPath === 'string'
                    ? message.result.pdfPath.trim()
                    : '';
                if (normalizedPdfPath.length === 0) {
                    return null;
                }
                if (typeof message.result.requiresCleanupAck !== 'boolean') {
                    return null;
                }
                return {
                    type: 'complete',
                    jobId: message.jobId,
                    result: {
                        success: true,
                        pdfPath: normalizedPdfPath,
                        requiresCleanupAck: message.result.requiresCleanupAck,
                        errors: message.result.errors,
                    },
                };
            }

            return {
                type: 'complete',
                jobId: message.jobId,
                result: {
                    success: false,
                    errors: message.result.errors,
                },
            };
        default:
            return null;
    }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return isRecord(error) && ('code' in error);
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
        const code = isErrnoException(err) ? err.code : undefined;
        if (code !== 'ENOENT') {
            log.warn(`Failed to cleanup OCR temp result file "${path}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

function clearPendingResultFileCleanupTimer(entry: IOcrPendingResultFile | null | undefined) {
    if (!entry?.cleanupTimer) {
        return;
    }
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
}

function removePendingResultFileEntry(jobId: string) {
    const pending = pendingResultFiles.get(jobId);
    if (!pending) {
        return null;
    }
    pendingResultFiles.delete(jobId);
    clearPendingResultFileCleanupTimer(pending);
    return pending;
}

function trackPendingResultFile(jobId: string, webContentsId: number, pdfPath: string) {
    const normalizedPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    const previousEntry = removePendingResultFileEntry(jobId);
    if (previousEntry && previousEntry.pdfPath !== normalizedPath) {
        void removeResultFile(previousEntry.pdfPath);
    }

    const cleanupTimer = setTimeout(() => {
        const pending = removePendingResultFileEntry(jobId);
        if (!pending) {
            return;
        }

        void removeResultFile(pending.pdfPath);
        log.warn(`Cleaned up stale OCR result file for job "${jobId}" after acknowledgement timeout`);
    }, OCR_RESULT_FILE_ACK_TTL_MS);
    cleanupTimer.unref?.();

    pendingResultFiles.set(jobId, {
        jobId,
        webContentsId,
        pdfPath: normalizedPath,
        createdAtMs: Date.now(),
        cleanupTimer,
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
        const removedEntry = removePendingResultFileEntry(entry.jobId);
        if (removedEntry) {
            await removeResultFile(removedEntry.pdfPath);
        }
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

async function estimateRequestBytes(
    sourcePdfPath: string,
    pages: IOcrPdfPageRequest[],
) {
    const averagePageOverhead = 32 * 1024;
    let sourcePdfBytes = 0;
    try {
        sourcePdfBytes = (await stat(sourcePdfPath)).size;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to stat OCR source PDF "${sourcePdfPath}" for queue estimation: ${errMsg}`);
    }
    return sourcePdfBytes + (pages.length * averagePageOverhead);
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

function clearJobWatchdog(jobId: string) {
    const activeJob = activeJobs.get(jobId);
    if (!activeJob?.watchdogTimer) {
        return;
    }
    clearTimeout(activeJob.watchdogTimer);
    activeJob.watchdogTimer = null;
}

async function terminateWorkerSafely(
    jobId: string,
    worker: Worker,
    reason: string,
) {
    try {
        await withTimeout(() => worker.terminate(), OCR_WORKER_TERMINATE_TIMEOUT_MS);
    } catch (error) {
        log.warn(`[${jobId}] Failed to terminate OCR worker (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    }
}

function terminateAndFinalizeActiveJob(
    jobId: string,
    options: {
        markCancelled?: boolean;
        reason: string;
    },
) {
    const activeJob = activeJobs.get(jobId);
    if (!activeJob) {
        return;
    }

    activeJob.completed = true;
    activeJob.terminatedByUs = true;
    if (options.markCancelled) {
        cancelledJobs.add(jobId);
    }
    clearJobWatchdog(jobId);
    void terminateWorkerSafely(jobId, activeJob.worker, options.reason).finally(() => {
        finalizeActiveJob(jobId);
        if (options.markCancelled) {
            cancelledJobs.delete(jobId);
        }
    });
}

async function cleanupPendingResultFilesForSender(webContentsId: number) {
    const pendingEntries = Array.from(pendingResultFiles.values())
        .filter(entry => entry.webContentsId === webContentsId);
    for (const pendingEntry of pendingEntries) {
        const removedEntry = removePendingResultFileEntry(pendingEntry.jobId);
        if (removedEntry) {
            await removeResultFile(removedEntry.pdfPath);
        }
    }
}

function cancelJobsForSender(webContentsId: number, reason: string) {
    const queuedForSender = queuedJobs
        .filter(job => job.webContentsId === webContentsId)
        .map(job => job.jobId);
    for (const jobId of queuedForSender) {
        const removedJob = removeQueuedJob(jobId);
        if (removedJob) {
            log.info(`[${jobId}] Removed queued OCR job: ${reason}`);
        }
    }

    const activeForSender = Array.from(activeJobs.values())
        .filter(activeJob => activeJob.webContentsId === webContentsId);
    for (const activeJob of activeForSender) {
        terminateAndFinalizeActiveJob(activeJob.jobId, {
            markCancelled: true,
            reason,
        });
        log.info(`[${activeJob.jobId}] Cancelled active OCR job: ${reason}`);
    }

    void cleanupPendingResultFilesForSender(webContentsId);
}

function registerSenderCleanup(event: IpcMainInvokeEvent) {
    const senderId = event.sender.id;
    if (registeredSenderCleanupIds.has(senderId)) {
        return;
    }

    registeredSenderCleanupIds.add(senderId);
    let didCleanup = false;
    const cleanup = (reason: string) => {
        if (didCleanup) {
            return;
        }
        didCleanup = true;
        cancelJobsForSender(senderId, reason);
        registeredSenderCleanupIds.delete(senderId);

        event.sender.removeListener('destroyed', handleDestroyed);
        event.sender.removeListener('render-process-gone', handleRenderProcessGone);
    };

    const handleDestroyed = () => {
        cleanup('Renderer destroyed');
    };
    const handleRenderProcessGone = () => {
        cleanup('Renderer process gone');
    };

    event.sender.once('destroyed', handleDestroyed);
    event.sender.once('render-process-gone', handleRenderProcessGone);
}

function sendJobFailure(job: IOcrQueuedJob, error: string) {
    const window = getJobWindow(job.webContentsId);
    safeSendToWindow(window, 'ocr:complete', {
        requestId: job.jobId,
        success: false,
        errors: [error],
    });
}

function finalizeActiveJob(jobId: string) {
    clearJobWatchdog(jobId);
    activeJobs.delete(jobId);
    dispatchQueuedJobs();
}

function handleWorkerMessage(
    jobId: string,
    webContentsId: number,
    message: TOcrWorkerOutboundMessage,
) {
    const window = getJobWindow(webContentsId);

    switch (message.type) {
        case 'log':
            if (message.level === 'warn') {
                log.warn(message.message);
            } else if (message.level === 'error') {
                log.error(`[worker-error] ${message.message}`);
            } else {
                log.debug(`[worker] ${message.message}`);
            }
            return;
        case 'progress':
            if (message.jobId !== jobId) {
                log.warn(`Ignoring OCR progress for mismatched job id "${message.jobId}" (expected "${jobId}")`);
                return;
            }
            safeSendToWindow(window, 'ocr:progress', message.progress);
            return;
        case 'complete': {
            if (message.jobId !== jobId) {
                log.warn(`Ignoring OCR completion for mismatched job id "${message.jobId}" (expected "${jobId}")`);
                return;
            }
            if (message.result.success) {
                trackPendingResultFile(jobId, webContentsId, message.result.pdfPath);
                void evictStaleResultFiles();
            }

            safeSendToWindow(window, 'ocr:complete', {
                requestId: jobId,
                ...message.result,
            });

            terminateAndFinalizeActiveJob(jobId, { reason: 'worker reported completion' });
            return;
        }
        default:
            assertNever(message);
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
        watchdogTimer: null,
    };
    activeJobs.set(job.jobId, activeJob);
    const watchdog = setTimeout(() => {
        const pendingActiveJob = activeJobs.get(job.jobId);
        if (!pendingActiveJob || pendingActiveJob.completed) {
            return;
        }

        sendJobFailure(job, `OCR job timed out after ${OCR_JOB_MAX_RUNTIME_MS}ms`);
        terminateAndFinalizeActiveJob(job.jobId, {
            markCancelled: true,
            reason: `watchdog timeout (${OCR_JOB_MAX_RUNTIME_MS}ms)`,
        });
        log.error(`OCR watchdog timed out job ${job.jobId}`);
    }, OCR_JOB_MAX_RUNTIME_MS);
    watchdog.unref?.();
    activeJob.watchdogTimer = watchdog;
    logQueueDepth(`OCR job ${job.jobId} activated`);

    worker.on('message', (message: unknown) => {
        const parsedMessage = parseWorkerMessage(message);
        if (!parsedMessage) {
            log.warn(`Ignoring malformed OCR worker message for job ${job.jobId}`);
            return;
        }
        handleWorkerMessage(job.jobId, job.webContentsId, parsedMessage);
    });

    worker.on('error', (err: Error) => {
        if (cancelledJobs.has(job.jobId)) {
            cancelledJobs.delete(job.jobId);
            finalizeActiveJob(job.jobId);
            return;
        }

        log.error(`Worker error for job ${job.jobId}: ${err.message}`);
        const active = activeJobs.get(job.jobId);
        if (!active) {
            return;
        }
        if (active.completed || active.terminatedByUs) {
            finalizeActiveJob(job.jobId);
            return;
        }
        sendJobFailure(job, `Worker error: ${err.message}`);
        terminateAndFinalizeActiveJob(job.jobId, { reason: 'worker error' });
    });

    worker.on('exit', (code) => {
        const wasCanceled = cancelledJobs.has(job.jobId);
        if (wasCanceled) {
            cancelledJobs.delete(job.jobId);
        }

        const active = activeJobs.get(job.jobId);
        if (!active) {
            return;
        }
        const wasCompletedOrTerminated = wasCanceled || active?.completed || active?.terminatedByUs;

        if (code !== 0 && !wasCompletedOrTerminated) {
            log.error(`Worker exited with code ${code} for job ${job.jobId}`);
            sendJobFailure(job, `Worker exited unexpectedly with code ${code}`);
        }

        finalizeActiveJob(job.jobId);
    });

    try {
        const startMessage: TOcrWorkerInboundMessage = {
            type: 'start',
            jobId: job.jobId,
            data: {
                sourcePdfPath: job.sourcePdfPath,
                pages: job.pages,
                renderDpi: job.renderDpi,
            },
        };
        worker.postMessage(startMessage);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        sendJobFailure(job, `Failed to post OCR job to worker: ${errMsg}`);
        terminateAndFinalizeActiveJob(job.jobId, { reason: 'failed to post worker start message' });
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
    sourcePdfPath: string,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    renderDpi?: number,
): Promise<{
    started: boolean;
    jobId: string;
    error?: string;
}> {
    log.debug(`handleOcrCreateSearchablePdfAsync called: sourcePdfPath=${sourcePdfPath}, pages=${pages.length}, reqId=${requestId}, dpi=${renderDpi}`);

    try {
        registerSenderCleanup(event);
        if (event.sender.isDestroyed()) {
            return {
                started: false,
                jobId: requestId,
                error: 'Renderer disconnected before OCR request could be queued',
            };
        }

        evictStaleQueuedJobs();
        await evictStaleResultFiles();

        if (activeJobs.has(requestId) || queuedJobIds.has(requestId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }

        const requestBytes = await estimateRequestBytes(sourcePdfPath, pages);
        const capacityResult = ensureQueueCapacity(requestBytes);
        if (!capacityResult.ok) {
            return {
                started: false,
                jobId: requestId,
                error: capacityResult.error,
            };
        }

        const languages = uniq(pages.flatMap(page => page.languages));
        const tessdataDir = getOcrToolPaths().tessdata;
        const missingLanguages = languages.filter(languageCode =>
            !existsSync(join(tessdataDir, `${languageCode}.traineddata`)),
        );
        if (missingLanguages.length > 0) {
            log.warn(`Missing OCR language models in ${tessdataDir}; downloading: ${missingLanguages.join(', ')}`);
        }
        try {
            await withTimeout(() => ensureTessdataLanguages(languages), OCR_MODEL_PREP_TIMEOUT_MS);
        } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new Error(`OCR model preparation timed out after ${OCR_MODEL_PREP_TIMEOUT_MS}ms`);
            }
            throw error;
        }

        if (event.sender.isDestroyed()) {
            return {
                started: false,
                jobId: requestId,
                error: 'Renderer disconnected before OCR request could be queued',
            };
        }

        const queuedJob: IOcrQueuedJob = {
            jobId: requestId,
            webContentsId: event.sender.id,
            sourcePdfPath,
            pages,
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
    registerSenderCleanup(event);
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

    const removedEntry = removePendingResultFileEntry(requestId);
    if (!removedEntry) {
        return {
            cleaned: false,
            error: `No pending OCR result file for requestId "${requestId}"`,
        };
    }

    await removeResultFile(removedEntry.pdfPath);
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

    terminateAndFinalizeActiveJob(requestId, {
        markCancelled: true,
        reason: 'explicit cancel request',
    });
    log.info(`[${requestId}] Active OCR job cancelled`);
    return { canceled: true };
}
