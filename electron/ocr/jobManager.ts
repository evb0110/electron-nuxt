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
import {
    OCR_JOB_IDLE_TIMEOUT_MS,
    OCR_MODEL_PREP_TIMEOUT_MS,
    OCR_QUEUE_MAX_AGE_MS,
    OCR_QUEUE_MAX_BUFFERED_BYTES,
    OCR_QUEUE_MAX_SIZE,
    OCR_RESULT_FILE_ACK_TTL_MS,
    OCR_WORKER_POOL_SIZE,
    OCR_WORKER_TERMINATE_TIMEOUT_MS,
} from '@electron/ocr/jobManager.config';
import {
    createAbortError,
    createTimeoutError,
    isAbortError,
    isScopedJobOwnedBySender,
    parseWorkerMessage,
    toScopedOcrJobId,
} from '@electron/ocr/jobManager.protocol';
import { createPendingResultFileStore } from '@electron/ocr/jobManager.resultFiles';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/ocr/jobManager.types';
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
const OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS ?? '250', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 250;
    }
    return Math.min(parsed, 2_000);
})();

const activeJobs = new Map<string, IOcrActiveJob>();
const queuedJobs: IOcrQueuedJob[] = [];
const queuedJobIds = new Set<string>();
const preparingJobs = new Map<string, IOcrPreparingJob>();
const cancelledJobs = new Set<string>();
const registeredSenderCleanupIds = new Set<number>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return isRecord(error) && ('code' in error);
}

function assertNever(value: never): never {
    throw new Error(`Unhandled OCR worker message: ${JSON.stringify(value)}`);
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
const pendingResultFileStore = createPendingResultFileStore({
    logger: log,
    ttlMs: OCR_RESULT_FILE_ACK_TTL_MS,
    removeResultFile,
});

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

function resetJobWatchdog(job: IOcrQueuedJob) {
    const activeJob = activeJobs.get(job.scopedJobId);
    if (!activeJob || activeJob.completed) {
        return;
    }

    clearJobWatchdog(job.scopedJobId);
    const watchdog = setTimeout(() => {
        const pendingActiveJob = activeJobs.get(job.scopedJobId);
        if (!pendingActiveJob || pendingActiveJob.completed) {
            return;
        }

        sendJobFailure(job, `OCR job idle timed out after ${OCR_JOB_IDLE_TIMEOUT_MS}ms without worker activity`);
        terminateAndFinalizeActiveJob(job.scopedJobId, {
            markCancelled: true,
            reason: `watchdog idle timeout (${OCR_JOB_IDLE_TIMEOUT_MS}ms)`,
        });
        log.error(`OCR watchdog idle timed out job ${job.requestId}`);
    }, OCR_JOB_IDLE_TIMEOUT_MS);
    watchdog.unref?.();
    activeJob.watchdogTimer = watchdog;
}

async function terminateWorkerSafely(
    scopedJobId: string,
    worker: Worker,
    reason: string,
) {
    try {
        worker.postMessage({
            type: 'cancel',
            jobId: scopedJobId,
        });
        if (OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS));
        }
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

    void pendingResultFileStore.cleanupForSender(webContentsId);
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
                pendingResultFileStore.track(scopedJobId, requestId, webContentsId, message.result.pdfPath);
                void pendingResultFileStore.evictStale();
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
    resetJobWatchdog(job);
    logQueueDepth(`OCR job ${job.requestId} activated`);

    worker.on('message', (message: unknown) => {
        resetJobWatchdog(job);
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
        await pendingResultFileStore.evictStale();

        if (activeJobs.has(scopedJobId) || queuedJobIds.has(scopedJobId) || preparingJobs.has(scopedJobId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }
        if (pendingResultFileStore.find(event.sender.id, requestId)) {
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
        if (pendingResultFileStore.find(event.sender.id, requestId)) {
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
    await pendingResultFileStore.evictStale();

    const requestId = typeof requestIdPayload === 'string' ? requestIdPayload.trim() : '';
    if (!requestId) {
        return {
            cleaned: false,
            error: 'requestId must be a non-empty string',
        };
    }

    return pendingResultFileStore.acknowledge(
        event.sender.id,
        requestId,
        typeof pdfPathPayload === 'string' ? pdfPathPayload : undefined,
    );
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

    await pendingResultFileStore.shutdown();

    cancelledJobs.clear();
    registeredSenderCleanupIds.clear();
}
