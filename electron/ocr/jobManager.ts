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
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
    queuedAtMs: number;
    requestedBytes: number;
}

interface IOcrPreparingJob {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    requestedBytes: number;
    startedAtMs: number;
    abortController: AbortController;
}

interface IOcrActiveJob extends IOcrQueuedJob {
    worker: Worker;
    completed: boolean;
    terminatedByUs: boolean;
    startedAtMs: number;
    watchdogTimer: NodeJS.Timeout | null;
}

interface IOcrPendingResultFile {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    pdfPath: string;
    createdAtMs: number;
    cleanupTimer: NodeJS.Timeout | null;
}

const activeJobs = new Map<string, IOcrActiveJob>();
const queuedJobs: IOcrQueuedJob[] = [];
const queuedJobIds = new Set<string>();
const preparingJobs = new Map<string, IOcrPreparingJob>();
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

function createAbortError(message: string) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function createTimeoutError(message: string) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function toScopedOcrJobId(webContentsId: number, requestId: string) {
    return `${webContentsId}:${requestId}`;
}

function isScopedJobOwnedBySender(scopedJobId: string, webContentsId: number) {
    return scopedJobId.startsWith(`${webContentsId}:`);
}

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
    const preparingBytes = Array.from(preparingJobs.values()).reduce(
        (total, job) => total + job.requestedBytes,
        0,
    );
    const activeBytes = Array.from(activeJobs.values()).reduce(
        (total, job) => total + job.requestedBytes,
        0,
    );
    const queuedBytes = queuedJobs.reduce(
        (total, job) => total + job.requestedBytes,
        0,
    );
    return preparingBytes + activeBytes + queuedBytes;
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
        removeQueuedJob(staleJob.scopedJobId);
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

function removePendingResultFileEntry(scopedJobId: string) {
    const pending = pendingResultFiles.get(scopedJobId);
    if (!pending) {
        return null;
    }
    pendingResultFiles.delete(scopedJobId);
    clearPendingResultFileCleanupTimer(pending);
    return pending;
}

function findPendingResultFileEntry(webContentsId: number, requestId: string) {
    return Array.from(pendingResultFiles.values())
        .find(entry => entry.webContentsId === webContentsId && entry.requestId === requestId)
        ?? null;
}

function trackPendingResultFile(
    scopedJobId: string,
    requestId: string,
    webContentsId: number,
    pdfPath: string,
) {
    const normalizedPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    const previousEntry = removePendingResultFileEntry(scopedJobId);
    if (previousEntry && previousEntry.pdfPath !== normalizedPath) {
        void removeResultFile(previousEntry.pdfPath);
    }

    const cleanupTimer = setTimeout(() => {
        const pending = removePendingResultFileEntry(scopedJobId);
        if (!pending) {
            return;
        }

        void removeResultFile(pending.pdfPath);
        log.warn(`Cleaned up stale OCR result file for job "${requestId}" after acknowledgement timeout`);
    }, OCR_RESULT_FILE_ACK_TTL_MS);
    cleanupTimer.unref?.();

    pendingResultFiles.set(scopedJobId, {
        scopedJobId,
        requestId,
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
        const removedEntry = removePendingResultFileEntry(entry.scopedJobId);
        if (removedEntry) {
            await removeResultFile(removedEntry.pdfPath);
        }
    }

    log.warn(`Cleaned up ${staleEntries.length} stale OCR result file(s) without renderer acknowledgement`);
}

function ensureQueueCapacity(additionalBytes: number) {
    if (queuedJobs.length + preparingJobs.size > OCR_QUEUE_MAX_SIZE) {
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
        `${context}: active=${activeJobs.size}/${OCR_WORKER_POOL_SIZE}, preparing=${preparingJobs.size}, queued=${queuedJobs.length}/${OCR_QUEUE_MAX_SIZE}, bufferedMB=${(getBufferedBytes() / (1024 * 1024)).toFixed(1)}`,
    );
}

function abortPreparingJob(
    scopedJobId: string,
    reason: string,
) {
    const preparingJob = preparingJobs.get(scopedJobId);
    if (!preparingJob) {
        return false;
    }

    cancelledJobs.add(scopedJobId);
    if (!preparingJob.abortController.signal.aborted) {
        preparingJob.abortController.abort(createAbortError(reason));
    }
    return true;
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

function removeQueuedJob(scopedJobId: string) {
    const index = queuedJobs.findIndex(job => job.scopedJobId === scopedJobId);
    if (index === -1) {
        return null;
    }

    const [job] = queuedJobs.splice(index, 1);
    queuedJobIds.delete(scopedJobId);
    return job ?? null;
}

function clearJobWatchdog(scopedJobId: string) {
    const activeJob = activeJobs.get(scopedJobId);
    if (!activeJob?.watchdogTimer) {
        return;
    }
    clearTimeout(activeJob.watchdogTimer);
    activeJob.watchdogTimer = null;
}

async function terminateWorkerSafely(
    scopedJobId: string,
    worker: Worker,
    reason: string,
) {
    try {
        await withTimeout(() => worker.terminate(), OCR_WORKER_TERMINATE_TIMEOUT_MS);
    } catch (error) {
        log.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    }
}

function terminateAndFinalizeActiveJob(
    scopedJobId: string,
    options: {
        markCancelled?: boolean;
        reason: string;
    },
) {
    const activeJob = activeJobs.get(scopedJobId);
    if (!activeJob) {
        return;
    }

    activeJob.completed = true;
    activeJob.terminatedByUs = true;
    if (options.markCancelled) {
        cancelledJobs.add(scopedJobId);
    }
    clearJobWatchdog(scopedJobId);
    void terminateWorkerSafely(scopedJobId, activeJob.worker, options.reason).finally(() => {
        finalizeActiveJob(scopedJobId);
        if (options.markCancelled) {
            cancelledJobs.delete(scopedJobId);
        }
    });
}

async function cleanupPendingResultFilesForSender(webContentsId: number) {
    const pendingEntries = Array.from(pendingResultFiles.values())
        .filter(entry => entry.webContentsId === webContentsId);
    for (const pendingEntry of pendingEntries) {
        const removedEntry = removePendingResultFileEntry(pendingEntry.scopedJobId);
        if (removedEntry) {
            await removeResultFile(removedEntry.pdfPath);
        }
    }
}

function cancelJobsForSender(webContentsId: number, reason: string) {
    for (const preparingJob of Array.from(preparingJobs.values())) {
        if (!isScopedJobOwnedBySender(preparingJob.scopedJobId, webContentsId)) {
            continue;
        }

        abortPreparingJob(preparingJob.scopedJobId, reason);
        log.info(`[${preparingJob.requestId}] Marked preparing OCR job as cancelled: ${reason}`);
    }

    const queuedForSender = queuedJobs
        .filter(job => job.webContentsId === webContentsId)
        .map(job => job.scopedJobId);
    for (const scopedJobId of queuedForSender) {
        const removedJob = removeQueuedJob(scopedJobId);
        if (removedJob) {
            log.info(`[${removedJob.requestId}] Removed queued OCR job: ${reason}`);
        }
    }

    const activeForSender = Array.from(activeJobs.values())
        .filter(activeJob => activeJob.webContentsId === webContentsId);
    for (const activeJob of activeForSender) {
        terminateAndFinalizeActiveJob(activeJob.scopedJobId, {
            markCancelled: true,
            reason,
        });
        log.info(`[${activeJob.requestId}] Cancelled active OCR job: ${reason}`);
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
        requestId: job.requestId,
        success: false,
        errors: [error],
    });
}

function finalizeActiveJob(scopedJobId: string) {
    clearJobWatchdog(scopedJobId);
    activeJobs.delete(scopedJobId);
    dispatchQueuedJobs();
}

function handleWorkerMessage(
    scopedJobId: string,
    requestId: string,
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
            if (message.jobId !== requestId) {
                log.warn(`Ignoring OCR progress for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                return;
            }
            safeSendToWindow(window, 'ocr:progress', message.progress);
            return;
        case 'complete': {
            if (message.jobId !== requestId) {
                log.warn(`Ignoring OCR completion for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                return;
            }
            if (message.result.success) {
                trackPendingResultFile(scopedJobId, requestId, webContentsId, message.result.pdfPath);
                void evictStaleResultFiles();
            }

            safeSendToWindow(window, 'ocr:complete', {
                requestId,
                ...message.result,
            });

            terminateAndFinalizeActiveJob(scopedJobId, { reason: 'worker reported completion' });
            return;
        }
        default:
            assertNever(message);
    }
}

function startQueuedJob(job: IOcrQueuedJob) {
    queuedJobIds.delete(job.scopedJobId);

    let worker: Worker;
    try {
        worker = createOcrWorker();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJobFailure(job, `OCR worker unavailable: ${message}`);
        log.error(`Failed to start OCR worker for job ${job.requestId}: ${message}`);
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
    activeJobs.set(job.scopedJobId, activeJob);
    const watchdog = setTimeout(() => {
        const pendingActiveJob = activeJobs.get(job.scopedJobId);
        if (!pendingActiveJob || pendingActiveJob.completed) {
            return;
        }

        sendJobFailure(job, `OCR job timed out after ${OCR_JOB_MAX_RUNTIME_MS}ms`);
        terminateAndFinalizeActiveJob(job.scopedJobId, {
            markCancelled: true,
            reason: `watchdog timeout (${OCR_JOB_MAX_RUNTIME_MS}ms)`,
        });
        log.error(`OCR watchdog timed out job ${job.requestId}`);
    }, OCR_JOB_MAX_RUNTIME_MS);
    watchdog.unref?.();
    activeJob.watchdogTimer = watchdog;
    logQueueDepth(`OCR job ${job.requestId} activated`);

    worker.on('message', (message: unknown) => {
        const parsedMessage = parseWorkerMessage(message);
        if (!parsedMessage) {
            log.warn(`Ignoring malformed OCR worker message for job ${job.requestId}`);
            return;
        }
        handleWorkerMessage(job.scopedJobId, job.requestId, job.webContentsId, parsedMessage);
    });

    worker.on('error', (err: Error) => {
        if (cancelledJobs.has(job.scopedJobId)) {
            cancelledJobs.delete(job.scopedJobId);
            finalizeActiveJob(job.scopedJobId);
            return;
        }

        log.error(`Worker error for job ${job.requestId}: ${err.message}`);
        const active = activeJobs.get(job.scopedJobId);
        if (!active) {
            return;
        }
        if (active.completed || active.terminatedByUs) {
            finalizeActiveJob(job.scopedJobId);
            return;
        }
        sendJobFailure(job, `Worker error: ${err.message}`);
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker error' });
    });

    worker.on('exit', (code) => {
        const wasCanceled = cancelledJobs.has(job.scopedJobId);
        if (wasCanceled) {
            cancelledJobs.delete(job.scopedJobId);
        }

        const active = activeJobs.get(job.scopedJobId);
        if (!active) {
            return;
        }
        const wasCompletedOrTerminated = wasCanceled || active?.completed || active?.terminatedByUs;

        if (code !== 0 && !wasCompletedOrTerminated) {
            log.error(`Worker exited with code ${code} for job ${job.requestId}`);
            sendJobFailure(job, `Worker exited unexpectedly with code ${code}`);
        }

        finalizeActiveJob(job.scopedJobId);
    });

    try {
        const startMessage: TOcrWorkerInboundMessage = {
            type: 'start',
            // Keep worker-visible job ids sender-agnostic so renderer callbacks
            // continue matching the requestId generated in the UI.
            jobId: job.requestId,
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
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'failed to post worker start message' });
        return;
    }

    log.debug(`OCR job ${job.requestId} started in worker thread`);
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
    const scopedJobId = toScopedOcrJobId(event.sender.id, requestId);
    let isPreparingReserved = false;

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

        if (activeJobs.has(scopedJobId) || queuedJobIds.has(scopedJobId) || preparingJobs.has(scopedJobId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }
        if (findPendingResultFileEntry(event.sender.id, requestId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" is waiting for result-file acknowledgement`,
            };
        }

        // Reserve the scoped id before long async prep to avoid duplicate in-flight
        // requests racing into the queue with the same requestId.
        const preparingJob: IOcrPreparingJob = {
            scopedJobId,
            requestId,
            webContentsId: event.sender.id,
            requestedBytes: 0,
            startedAtMs: Date.now(),
            abortController: new AbortController(),
        };
        preparingJobs.set(scopedJobId, preparingJob);
        isPreparingReserved = true;

        const requestBytes = await estimateRequestBytes(sourcePdfPath, pages);
        preparingJob.requestedBytes = requestBytes;
        const capacityResult = ensureQueueCapacity(0);
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

        const modelPrepTimeout = setTimeout(() => {
            if (!preparingJob.abortController.signal.aborted) {
                preparingJob.abortController.abort(
                    createTimeoutError(`OCR model preparation timed out after ${OCR_MODEL_PREP_TIMEOUT_MS}ms`),
                );
            }
        }, OCR_MODEL_PREP_TIMEOUT_MS);
        modelPrepTimeout.unref?.();
        try {
            await ensureTessdataLanguages(languages, { signal: preparingJob.abortController.signal });
        } catch (error) {
            if (preparingJob.abortController.signal.aborted) {
                const reason = preparingJob.abortController.signal.reason;
                if (reason instanceof Error && reason.name === 'TimeoutError') {
                    throw reason;
                }
                if (cancelledJobs.has(scopedJobId)) {
                    return {
                        started: false,
                        jobId: requestId,
                        error: 'OCR job was cancelled before it started',
                    };
                }
                if (event.sender.isDestroyed()) {
                    return {
                        started: false,
                        jobId: requestId,
                        error: 'Renderer disconnected before OCR request could be queued',
                    };
                }
            }
            throw error;
        } finally {
            clearTimeout(modelPrepTimeout);
        }

        if (cancelledJobs.has(scopedJobId)) {
            return {
                started: false,
                jobId: requestId,
                error: 'OCR job was cancelled before it started',
            };
        }
        if (event.sender.isDestroyed()) {
            return {
                started: false,
                jobId: requestId,
                error: 'Renderer disconnected before OCR request could be queued',
            };
        }
        if (activeJobs.has(scopedJobId) || queuedJobIds.has(scopedJobId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }
        if (findPendingResultFileEntry(event.sender.id, requestId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" is waiting for result-file acknowledgement`,
            };
        }
        const recheckedCapacityResult = ensureQueueCapacity(0);
        if (!recheckedCapacityResult.ok) {
            return {
                started: false,
                jobId: requestId,
                error: recheckedCapacityResult.error,
            };
        }
        if (cancelledJobs.has(scopedJobId)) {
            return {
                started: false,
                jobId: requestId,
                error: 'OCR job was cancelled before it started',
            };
        }

        const queuedJob: IOcrQueuedJob = {
            scopedJobId,
            requestId,
            webContentsId: event.sender.id,
            sourcePdfPath,
            pages,
            renderDpi,
            queuedAtMs: Date.now(),
            requestedBytes: requestBytes,
        };
        preparingJobs.delete(scopedJobId);
        isPreparingReserved = false;
        queuedJobs.push(queuedJob);
        queuedJobIds.add(scopedJobId);
        logQueueDepth(`OCR job ${requestId} queued`);
        dispatchQueuedJobs();

        return {
            started: true,
            jobId: requestId,
        };
    } catch (err) {
        if (cancelledJobs.has(scopedJobId) && isAbortError(err)) {
            return {
                started: false,
                jobId: requestId,
                error: 'OCR job was cancelled before it started',
            };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to queue OCR worker job: ${errMsg}`);
        return {
            started: false,
            jobId: requestId,
            error: errMsg,
        };
    } finally {
        if (isPreparingReserved) {
            preparingJobs.delete(scopedJobId);
        }
        if (
            cancelledJobs.has(scopedJobId)
            && !activeJobs.has(scopedJobId)
            && !queuedJobIds.has(scopedJobId)
            && !preparingJobs.has(scopedJobId)
        ) {
            cancelledJobs.delete(scopedJobId);
        }
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

    const pending = findPendingResultFileEntry(event.sender.id, requestId);
    if (!pending) {
        return {
            cleaned: false,
            error: `No pending OCR result file for requestId "${requestId}"`,
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

    const removedEntry = removePendingResultFileEntry(pending.scopedJobId);
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
    event: IpcMainInvokeEvent,
    requestId: string,
): { canceled: boolean } {
    const scopedJobId = toScopedOcrJobId(event.sender.id, requestId);
    log.info(`[${requestId}] Cancel requested`);

    if (preparingJobs.has(scopedJobId)) {
        abortPreparingJob(scopedJobId, 'explicit cancel request');
        log.info(`[${requestId}] Preparing OCR job marked as cancelled`);
        return { canceled: true };
    }

    const queued = removeQueuedJob(scopedJobId);
    if (queued) {
        log.info(`[${requestId}] Queued OCR job cancelled`);
        return { canceled: true };
    }

    const activeJob = activeJobs.get(scopedJobId);
    if (!activeJob) {
        log.info(`[${requestId}] No active OCR job found for cancel`);
        return { canceled: false };
    }

    terminateAndFinalizeActiveJob(scopedJobId, {
        markCancelled: true,
        reason: 'explicit cancel request',
    });
    log.info(`[${requestId}] Active OCR job cancelled`);
    return { canceled: true };
}

export async function shutdownOcrJobManager() {
    queuedJobs.length = 0;
    queuedJobIds.clear();
    for (const preparingJob of preparingJobs.values()) {
        if (!preparingJob.abortController.signal.aborted) {
            preparingJob.abortController.abort(createAbortError('OCR job manager shutdown'));
        }
    }
    preparingJobs.clear();

    const activeEntries = Array.from(activeJobs.entries());
    activeJobs.clear();
    for (const [
        scopedJobId,
        activeJob,
    ] of activeEntries) {
        activeJob.completed = true;
        activeJob.terminatedByUs = true;
        clearJobWatchdog(scopedJobId);
    }
    await Promise.allSettled(
        activeEntries.map(([
            scopedJobId,
            activeJob,
        ]) =>
            terminateWorkerSafely(scopedJobId, activeJob.worker, 'app shutdown')),
    );

    const pendingEntries = Array.from(pendingResultFiles.values());
    pendingResultFiles.clear();
    for (const pendingEntry of pendingEntries) {
        clearPendingResultFileCleanupTimer(pendingEntry);
        await removeResultFile(pendingEntry.pdfPath);
    }

    cancelledJobs.clear();
    registeredSenderCleanupIds.clear();
}
