import { BrowserWindow } from 'electron';
import * as fsPromises from 'fs/promises';
import type { Worker } from 'worker_threads';
import { remove } from 'es-toolkit/array';
import { sumBy } from 'es-toolkit/math';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
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
import { prepareLanguageModelsForJob } from '@electron/ocr/prepareLanguageModelsForJob.modelPrep';
import {
    createAbortError,
    isAbortError,
    isScopedJobOwnedBySender,
    parseWorkerMessage,
    type TOcrWorkerManagerMessage,
    toScopedOcrJobId,
} from '@electron/ocr/jobManagerProtocol';
import {
    getOcrWorkerMessageDisposition,
    transitionOcrJobLifecycle,
} from '@electron/ocr/ocrJobLifecycle';
import { createPendingResultFileStore } from '@electron/ocr/createPendingResultFileStore';
import { createOcrWorker } from '@electron/ocr/createOcrWorker.worker';
import { ocrResourceGovernor } from '@electron/ocr/ocrResourceGovernor';
import {
    handleWorkerResourceMessage,
    isWorkerResourceMessage,
} from '@electron/ocr/ocrWorkerResourceMessages';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/ocr/jobManager.types';
import type { IOcrJobOperationContext } from '@electron/ocr/ocrJobOperationContext';
import type {
    IOcrPdfPageRequest,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';
import { isErrnoException } from '@contracts/runtimeGuards';
import type {
    IOcrCancelResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    TOcrErrorCode,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import { buildOcrErrorEnvelope } from '@electron/ocr/contracts';
import { createLogger } from '@electron/utils/createLogger';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';
import { getErrorMessage } from '@electron/utils/error';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { sendToLiveWindow } from '@electron/utils/sendToLiveWindow';

const log = createLogger('ocr-ipc');
const OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS ?? '250', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 250;
    }
    return Math.min(parsed, 2_000);
})();
const OCR_WORKER_CLEANUP_GRACE_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_OCR_WORKER_CLEANUP_GRACE_MS ?? String(OCR_WORKER_TERMINATE_TIMEOUT_MS),
        10,
    );
    if (!Number.isFinite(parsed) || parsed < 0) {
        return OCR_WORKER_TERMINATE_TIMEOUT_MS;
    }
    return Math.min(parsed, 60_000);
})();

const activeJobs = new Map<string, IOcrActiveJob>();
const queuedJobs: IOcrQueuedJob[] = [];
const queuedJobIds = new Set<string>();
const preparingJobs = new Map<string, IOcrPreparingJob>();
const cancelledJobs = new Set<string>();
const registeredSenderCleanupIds = new Set<number>();
const progressPumpsByScopedJobId = new Map<string, ReturnType<typeof createIpcProgressPump<IOcrProgress>>>();
const workerCleanupTimersByScopedJobId = new Map<string, NodeJS.Timeout>();

function assertNever(value: never) {
    throw new Error(`Unhandled OCR worker message: ${JSON.stringify(value)}`);
}

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: typeof OCR_EVENT_CHANNELS[keyof typeof OCR_EVENT_CHANNELS],
    ...args: unknown[]
) {
    sendToLiveWindow(window, channel, args, (err) => {
        log.debug(`Failed to send IPC message to channel "${channel}": ${getErrorMessage(err)}`);
    });
}

function getOcrProgressPump(
    scopedJobId: string,
    window: BrowserWindow | null | undefined,
) {
    let pump = progressPumpsByScopedJobId.get(scopedJobId);
    if (pump) {
        return pump;
    }

    pump = createIpcProgressPump<IOcrProgress>({
        channel: OCR_EVENT_CHANNELS.progress,
        getTarget: () => ({
            isDestroyed: () => !window
                || window.isDestroyed?.() === true
                || window.webContents.isDestroyed?.() === true,
            send: (channel, payload) => safeSendToWindow(
                window,
                channel as typeof OCR_EVENT_CHANNELS.progress,
                payload,
            ),
        }),
        getKey: payload => payload.requestId,
        isTerminal: payload =>
            payload.phase === 'indexing'
            && payload.totalPages > 0
            && payload.processedCount >= payload.totalPages,
        onError: error => {
            log.debug(`Failed to send OCR progress: ${getErrorMessage(error)}`);
        },
    });
    progressPumpsByScopedJobId.set(scopedJobId, pump);
    return pump;
}

function enqueueOcrProgress(
    scopedJobId: string,
    window: BrowserWindow | null | undefined,
    progress: IOcrProgress,
) {
    getOcrProgressPump(scopedJobId, window).enqueue(progress);
}

function clearOcrProgressPump(scopedJobId: string, requestId?: string) {
    const pump = progressPumpsByScopedJobId.get(scopedJobId);
    if (!pump) {
        return;
    }
    if (requestId) {
        pump.flush(requestId);
    }
    pump.clear();
    progressPumpsByScopedJobId.delete(scopedJobId);
}

function getJobWindow(webContentsId: number) {
    return BrowserWindow.getAllWindows().find(
        window => window.webContents.id === webContentsId,
    );
}

function sendOcrProgressStage(
    webContentsId: number,
    requestId: string,
    pages: IOcrPdfPageRequest[],
    phase: TOcrProgressPhase,
    phaseProgress?: number,
) {
    enqueueOcrProgress(toScopedOcrJobId(webContentsId, requestId), getJobWindow(webContentsId), {
        requestId,
        currentPage: pages[0]?.pageNumber ?? 0,
        processedCount: 0,
        totalPages: pages.length,
        phase,
        ...(phaseProgress !== undefined ? { phaseProgress } : {}),
    });
}

function getBufferedBytes(options: { excludePreparingJobId?: string } = {}) {
    const preparingBytes = sumBy([...preparingJobs.values()], job =>
        job.scopedJobId === options.excludePreparingJobId ? 0 : job.requestedBytes);
    const activeBytes = sumBy([...activeJobs.values()], job => job.requestedBytes);
    const queuedBytes = sumBy(queuedJobs, job => job.requestedBytes);
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
        await fsPromises.unlink(path);
        return true;
    } catch (err) {
        const code = isErrnoException(err) ? err.code : undefined;
        if (code === 'ENOENT') {
            return true;
        }
        if (code !== 'ENOENT') {
            log.warn(`Failed to cleanup OCR temp result file "${path}": ${getErrorMessage(err)}`);
        }
        return false;
    }
}
const pendingResultFileStore = createPendingResultFileStore({
    logger: log,
    ttlMs: OCR_RESULT_FILE_ACK_TTL_MS,
    removeResultFile,
});

type TQueueCapacityResult = { ok: true; } | {
    ok: false;
    error: string;
};

function ensureQueueCapacity(
    additionalBytes: number,
    options: { excludePreparingJobId?: string } = {},
): TQueueCapacityResult {
    const preparingCount = options.excludePreparingJobId === undefined
        ? preparingJobs.size
        : preparingJobs.size - (preparingJobs.has(options.excludePreparingJobId) ? 1 : 0);
    if (queuedJobs.length + preparingCount >= OCR_QUEUE_MAX_SIZE) {
        return {
            ok: false,
            error: `OCR queue is full (${OCR_QUEUE_MAX_SIZE} jobs)`,
        };
    }

    const bufferedBytes = getBufferedBytes(options);
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
        sourcePdfBytes = (await fsPromises.stat(sourcePdfPath)).size;
    } catch (err) {
        const errMsg = getErrorMessage(err);
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
    if (preparingJob.lifecycleState !== 'cancelling') {
        preparingJob.lifecycleState = transitionOcrJobLifecycle(
            preparingJob.lifecycleState,
            'cancelling',
            scopedJobId,
        );
    }
    if (!preparingJob.abortController.signal.aborted) {
        preparingJob.abortController.abort(createAbortError(reason));
    }
    clearOcrProgressPump(scopedJobId, preparingJob.requestId);
    return true;
}

function removeQueuedJob(
    scopedJobId: string,
    nextState: 'cancelling' | 'finalized' = 'finalized',
) {
    const [job = null] = remove(queuedJobs, candidate => candidate.scopedJobId === scopedJobId);
    if (!job) {
        return null;
    }
    job.lifecycleState = transitionOcrJobLifecycle(job.lifecycleState, nextState, scopedJobId);
    queuedJobIds.delete(scopedJobId);
    clearOcrProgressPump(scopedJobId, job.requestId);
    return job;
}

function clearJobWatchdog(scopedJobId: string) {
    const activeJob = activeJobs.get(scopedJobId);
    if (!activeJob?.watchdogTimer) {
        return;
    }
    clearTimeout(activeJob.watchdogTimer);
    activeJob.watchdogTimer = null;
}

function clearWorkerCleanupTimer(scopedJobId: string) {
    const timer = workerCleanupTimersByScopedJobId.get(scopedJobId);
    if (!timer) {
        return;
    }
    clearTimeout(timer);
    workerCleanupTimersByScopedJobId.delete(scopedJobId);
}

function resetJobWatchdog(job: IOcrQueuedJob) {
    const activeJob = activeJobs.get(job.scopedJobId);
    if (!activeJob || activeJob.completed || activeJob.terminalResultSent) {
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
    requestId?: string,
) {
    try {
        worker.postMessage({
            type: 'cancel',
            jobId: requestId ?? activeJobs.get(scopedJobId)?.requestId ?? scopedJobId,
        });
        if (OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS > 0) {
            await delay(OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS);
        }
        const terminatePromise = worker.terminate();
        void terminatePromise.catch(() => undefined);
        await withTimeout(() => terminatePromise, OCR_WORKER_TERMINATE_TIMEOUT_MS);
    } catch (error) {
        log.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${getErrorMessage(error)}`);
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
    if (activeJob.completed || activeJob.terminatedByUs) {
        return;
    }

    activeJob.completed = true;
    activeJob.terminatedByUs = true;
    if (options.markCancelled) {
        if (activeJob.lifecycleState !== 'terminal-result-sent') {
            activeJob.lifecycleState = transitionOcrJobLifecycle(
                activeJob.lifecycleState,
                'cancelling',
                scopedJobId,
            );
        }
        cancelledJobs.add(scopedJobId);
        if (!activeJob.terminalResultSent) {
            removePendingCompletionResultFile(activeJob);
        }
    }
    clearJobWatchdog(scopedJobId);
    clearWorkerCleanupTimer(scopedJobId);
    void terminateWorkerSafely(scopedJobId, activeJob.worker, options.reason, activeJob.requestId).finally(() => {
        if (options.markCancelled) {
            cancelledJobs.delete(scopedJobId);
        }
        finalizeActiveJob(scopedJobId);
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
        const removedJob = removeQueuedJob(scopedJobId, 'cancelling');
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

function registerSenderCleanup(context: IOcrJobOperationContext) {
    const {
        sender,
        senderId,
    } = context;
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

        sender.removeListener('destroyed', handleDestroyed);
        sender.removeListener('render-process-gone', handleRenderProcessGone);
        sender.removeListener('did-start-navigation', handleNavigation);
    };

    const handleDestroyed = () => {
        cleanup('Renderer destroyed');
    };
    const handleRenderProcessGone = () => {
        cleanup('Renderer process gone');
    };
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup('Renderer navigated');
        }
    };

    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    // Navigation can happen repeatedly during one renderer lifetime; this is
    // registered once per sender and removed by the shared cleanup handler.
    sender.on('did-start-navigation', handleNavigation);
}

function createTerminalOcrErrorEnvelope(
    error: string,
    options: {
        code?: TOcrErrorCode;
        retryable?: boolean;
    } = {},
): IOcrErrorEnvelope {
    return buildOcrErrorEnvelope(options.code ?? 'OCR_INTERNAL_ERROR', error, {retryable: options.retryable ?? false});
}

function sendJobFailure(
    job: IOcrQueuedJob,
    error: string,
    options: {
        code?: TOcrErrorCode;
        retryable?: boolean;
    } = {},
) {
    const window = getJobWindow(job.webContentsId);
    clearOcrProgressPump(job.scopedJobId, job.requestId);
    safeSendToWindow(window, OCR_EVENT_CHANNELS.complete, {
        requestId: job.requestId,
        success: false,
        errors: [error],
        errorEnvelope: createTerminalOcrErrorEnvelope(error, options),
    });
}

function trackPendingCompletionResultFile(job: IOcrActiveJob) {
    const result = job.pendingCompletionResult;
    if (!result?.success) {
        return false;
    }

    pendingResultFileStore.track(
        job.scopedJobId,
        job.requestId,
        job.webContentsId,
        result.pdfPath,
        result.requiresCleanupAck,
    );
    void pendingResultFileStore.evictStale();
    job.pendingCompletionResult = null;
    return true;
}

function startWorkerCleanupGraceTimer(job: IOcrActiveJob) {
    clearWorkerCleanupTimer(job.scopedJobId);
    if (OCR_WORKER_CLEANUP_GRACE_MS === 0) {
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker cleanup grace disabled after terminal result' });
        return;
    }

    const timer = setTimeout(() => {
        const activeJob = activeJobs.get(job.scopedJobId);
        if (!activeJob || activeJob.worker !== job.worker || !activeJob.terminalResultSent) {
            return;
        }

        log.warn(`[${job.scopedJobId}] OCR worker cleanup did not complete within ${OCR_WORKER_CLEANUP_GRACE_MS}ms after terminal result`);
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker cleanup timed out after terminal result' });
    }, OCR_WORKER_CLEANUP_GRACE_MS);
    timer.unref?.();
    workerCleanupTimersByScopedJobId.set(job.scopedJobId, timer);
}

function sendPendingCompletionResult(job: IOcrActiveJob) {
    const result = job.pendingCompletionResult;
    if (!result || job.terminalResultSent) {
        return false;
    }

    if (result.success) {
        trackPendingCompletionResultFile(job);
    } else {
        job.pendingCompletionResult = null;
    }
    job.lifecycleState = transitionOcrJobLifecycle(
        job.lifecycleState,
        'terminal-result-sent',
        job.scopedJobId,
    );
    job.terminalResultSent = true;
    clearJobWatchdog(job.scopedJobId);
    startWorkerCleanupGraceTimer(job);
    const terminalResult = result.success || result.errorEnvelope
        ? result
        : {
            ...result,
            errorEnvelope: createTerminalOcrErrorEnvelope(
                result.errors[0] ?? 'OCR worker failed without an error message',
            ),
        };
    clearOcrProgressPump(job.scopedJobId, job.requestId);
    safeSendToWindow(getJobWindow(job.webContentsId), OCR_EVENT_CHANNELS.complete, {
        requestId: job.requestId,
        ...terminalResult,
    });
    return true;
}

function removePendingCompletionResultFile(job: IOcrActiveJob) {
    const result = job.pendingCompletionResult;
    if (!result?.success) {
        return;
    }

    job.pendingCompletionResult = null;
    void removeResultFile(result.pdfPath);
}

function finalizeActiveJob(scopedJobId: string) {
    clearJobWatchdog(scopedJobId);
    clearWorkerCleanupTimer(scopedJobId);
    ocrResourceGovernor.releaseJob(scopedJobId);
    const activeJob = activeJobs.get(scopedJobId);
    if (activeJob) {
        trackPendingCompletionResultFile(activeJob);
    }
    clearOcrProgressPump(scopedJobId);
    activeJobs.delete(scopedJobId);
    dispatchQueuedJobs();
}

function handleWorkerMessage(
    scopedJobId: string,
    requestId: string,
    webContentsId: number,
    worker: Worker,
    message: TOcrWorkerManagerMessage,
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
        case 'progress': {
            const disposition = getOcrWorkerMessageDisposition({
                incomingJobId: message.jobId,
                expectedRequestId: requestId,
                isCurrentWorker: isCurrentActiveWorker(scopedJobId, worker),
            });
            if (!disposition.accepted) {
                if (disposition.reason === 'mismatched-job-id') {
                    log.warn(`Ignoring OCR progress for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                } else {
                    log.debug(`Ignoring late OCR progress for inactive job "${requestId}"`);
                }
                return;
            }
            enqueueOcrProgress(scopedJobId, window, message.progress);
            return;
        }
        case 'complete': {
            const activeJob = activeJobs.get(scopedJobId);
            const disposition = getOcrWorkerMessageDisposition({
                incomingJobId: message.jobId,
                expectedRequestId: requestId,
                isCurrentWorker: isCurrentActiveWorker(scopedJobId, worker),
                terminalResultSent: activeJob?.terminalResultSent === true,
                rejectAfterTerminalResult: true,
            });
            if (!disposition.accepted) {
                if (disposition.reason === 'mismatched-job-id') {
                    log.warn(`Ignoring OCR completion for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                } else if (disposition.reason === 'terminal-result-already-sent') {
                    log.debug(`Ignoring duplicate OCR completion for job "${requestId}" after terminal result`);
                } else {
                    log.debug(`Ignoring late OCR completion for inactive job "${requestId}"`);
                }
                return;
            }
            if (activeJob) {
                activeJob.pendingCompletionResult = message.result;
                sendPendingCompletionResult(activeJob);
            }
            return;
        }
        case 'cleanup-complete': {
            const disposition = getOcrWorkerMessageDisposition({
                incomingJobId: message.jobId,
                expectedRequestId: requestId,
                isCurrentWorker: isCurrentActiveWorker(scopedJobId, worker),
            });
            if (!disposition.accepted) {
                if (disposition.reason === 'mismatched-job-id') {
                    log.warn(`Ignoring OCR cleanup completion for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                } else {
                    log.debug(`Ignoring late OCR cleanup completion for inactive job "${requestId}"`);
                }
                return;
            }

            const activeJob = activeJobs.get(scopedJobId);
            const result = activeJob?.pendingCompletionResult ?? null;
            if (!result) {
                if (!activeJob?.terminalResultSent) {
                    log.warn(`OCR cleanup completed before result for job "${requestId}"`);
                    const error = 'OCR worker completed cleanup before sending a result';
                    safeSendToWindow(window, OCR_EVENT_CHANNELS.complete, {
                        requestId,
                        success: false,
                        errors: [error],
                        errorEnvelope: createTerminalOcrErrorEnvelope(error),
                    });
                }
                terminateAndFinalizeActiveJob(scopedJobId, { reason: 'worker cleanup completed without result' });
                return;
            }

            if (activeJob) {
                sendPendingCompletionResult(activeJob);
            }

            finalizeActiveJob(scopedJobId);
            return;
        }
        default:
            assertNever(message);
    }
}

function isCurrentActiveWorker(scopedJobId: string, worker: Worker) {
    const activeJob = activeJobs.get(scopedJobId);
    return Boolean(activeJob && activeJob.worker === worker && !activeJob.completed && !activeJob.terminatedByUs);
}

function startQueuedJob(job: IOcrQueuedJob) {
    queuedJobIds.delete(job.scopedJobId);

    let worker: Worker;
    try {
        worker = createOcrWorker();
    } catch (error) {
        const message = getErrorMessage(error);
        sendJobFailure(job, `OCR worker unavailable: ${message}`, {
            code: 'OCR_WORKER_UNAVAILABLE',
            retryable: true,
        });
        log.error(`Failed to start OCR worker for job ${job.requestId}: ${message}`);
        dispatchQueuedJobs();
        return;
    }

    const activeJob: IOcrActiveJob = {
        ...job,
        lifecycleState: transitionOcrJobLifecycle(job.lifecycleState, 'active', job.scopedJobId),
        worker,
        completed: false,
        terminatedByUs: false,
        pendingCompletionResult: null,
        terminalResultSent: false,
        startedAtMs: Date.now(),
        watchdogTimer: null,
    };
    activeJobs.set(job.scopedJobId, activeJob);
    resetJobWatchdog(job);
    logQueueDepth(`OCR job ${job.requestId} activated`);

    worker.on('message', (message: unknown) => {
        if (isWorkerResourceMessage(message)) {
            resetJobWatchdog(job);
            handleWorkerResourceMessage(job.scopedJobId, worker, message, activeJobs);
            return;
        }
        const parsedMessage = parseWorkerMessage(message);
        if (!parsedMessage) {
            log.warn(`Ignoring malformed OCR worker message for job ${job.requestId}`);
            return;
        }
        resetJobWatchdog(job);
        handleWorkerMessage(job.scopedJobId, job.requestId, job.webContentsId, worker, parsedMessage);
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
        if (active.completed || active.terminatedByUs || active.terminalResultSent) {
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
            if (code !== 0) {
                log.error(`Worker exited with code ${code} after OCR job ${job.requestId} was no longer active`);
            }
            return;
        }
        const wasCompletedOrTerminated = wasCanceled || active.completed || active.terminatedByUs || active.terminalResultSent;

        if (code !== 0 && !wasCompletedOrTerminated) {
            log.error(`Worker exited with code ${code} for job ${job.requestId}`);
            sendJobFailure(job, `Worker exited unexpectedly with code ${code}`);
        } else if (active.pendingCompletionResult && !active.terminalResultSent) {
            sendPendingCompletionResult(active);
        }

        finalizeActiveJob(job.scopedJobId);
    });

    try {
        const data: Extract<TOcrWorkerInboundMessage, { type: 'start' }>['data'] = {
            sourcePdfPath: job.sourcePdfPath,
            pages: job.pages,
            options: job.options,
        };
        if (job.options.renderDpi !== undefined) {
            data.renderDpi = job.options.renderDpi;
        }
        const startMessage: TOcrWorkerInboundMessage = {
            type: 'start',
            // Keep worker-visible job ids sender-agnostic so renderer callbacks
            // continue matching the requestId generated in the UI.
            jobId: job.requestId,
            data,
        };
        worker.postMessage(startMessage);
    } catch (error) {
        const errMsg = getErrorMessage(error);
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

interface IOcrQueueStartResult {
    started: boolean;
    jobId: string;
    error?: string;
    errorCode?: TOcrErrorCode;
}

function createQueueFailure(
    requestId: string,
    error: string,
    errorCode: TOcrErrorCode = 'OCR_INTERNAL_ERROR',
): IOcrQueueStartResult {
    return {
        started: false,
        jobId: requestId,
        error,
        errorCode,
    };
}

function findQueueBlockingResult(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    requestId: string,
    options: { includePreparing: boolean },
): IOcrQueueStartResult | null {
    if (context.sender.isDestroyed()) {
        return createQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
    }

    const isExistingJob = activeJobs.has(scopedJobId)
        || queuedJobIds.has(scopedJobId)
        || (options.includePreparing && preparingJobs.has(scopedJobId));
    if (isExistingJob) {
        return createQueueFailure(
            requestId,
            `OCR job with id "${requestId}" already exists`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    if (pendingResultFileStore.find(context.senderId, requestId)) {
        return createQueueFailure(
            requestId,
            `OCR job with id "${requestId}" is waiting for result-file acknowledgement`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    return null;
}

function createPreparingJob(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    requestId: string,
): IOcrPreparingJob {
    return {
        lifecycleState: 'preparing',
        scopedJobId,
        requestId,
        webContentsId: context.senderId,
        requestedBytes: 0,
        startedAtMs: Date.now(),
        abortController: new AbortController(),
    };
}

function getAbortedPreparationResult(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    requestId: string,
    signal: AbortSignal,
) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error && reason.name === 'TimeoutError') {
        throw reason;
    }
    if (cancelledJobs.has(scopedJobId)) {
        return createQueueFailure(requestId, 'OCR job was cancelled before it started');
    }
    if (context.sender.isDestroyed()) {
        return createQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
    }
    return null;
}

async function prepareLanguageModelsForQueueJob(
    context: IOcrJobOperationContext,
    preparingJob: IOcrPreparingJob,
    scopedJobId: string,
    requestId: string,
    pages: IOcrPdfPageRequest[],
) {
    try {
        await prepareLanguageModelsForJob(
            preparingJob,
            pages,
            OCR_MODEL_PREP_TIMEOUT_MS,
        );
        return null;
    } catch (error) {
        if (preparingJob.abortController.signal.aborted) {
            const result = getAbortedPreparationResult(
                context,
                scopedJobId,
                requestId,
                preparingJob.abortController.signal,
            );
            if (result) {
                return result;
            }
        }
        throw error;
    }
}

function getCancelledBeforeStartResult(scopedJobId: string, requestId: string) {
    return cancelledJobs.has(scopedJobId)
        ? createQueueFailure(requestId, 'OCR job was cancelled before it started')
        : null;
}

function enqueuePreparedOcrJob(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    sourcePdfPath: string,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    requestBytes: number,
    options: IOcrSearchablePdfOptions,
) {
    const preparingLifecycleState = preparingJobs.get(scopedJobId)?.lifecycleState ?? 'preparing';
    const queuedJob: IOcrQueuedJob = {
        lifecycleState: transitionOcrJobLifecycle(
            preparingLifecycleState,
            'queued',
            scopedJobId,
        ),
        scopedJobId,
        requestId,
        webContentsId: context.senderId,
        sourcePdfPath,
        pages,
        options,
        queuedAtMs: Date.now(),
        requestedBytes: requestBytes,
    };
    preparingJobs.delete(scopedJobId);
    queuedJobs.splice(queuedJobs.length, 0, queuedJob);
    queuedJobIds.add(scopedJobId);
    logQueueDepth(`OCR job ${requestId} queued`);
    dispatchQueuedJobs();
}

function cleanupCancelledPreparation(scopedJobId: string) {
    if (
        cancelledJobs.has(scopedJobId)
        && !activeJobs.has(scopedJobId)
        && !queuedJobIds.has(scopedJobId)
        && !preparingJobs.has(scopedJobId)
    ) {
        cancelledJobs.delete(scopedJobId);
    }
}

export async function handleOcrCreateSearchablePdfAsync(
    context: IOcrJobOperationContext,
    sourcePdfPath: string,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    options: IOcrSearchablePdfOptions = {},
): Promise<IOcrQueueStartResult> {
    log.debug(`handleOcrCreateSearchablePdfAsync called: sourcePdfPath=${sourcePdfPath}, pages=${pages.length}, reqId=${requestId}, dpi=${options.renderDpi}, profile=${options.qualityProfile ?? 'balanced'}, preprocessing=${options.preprocessingMode ?? 'off'}`);
    const scopedJobId = toScopedOcrJobId(context.senderId, requestId);
    let isPreparingReserved = false;

    try {
        registerSenderCleanup(context);

        evictStaleQueuedJobs();
        await pendingResultFileStore.evictStale();

        const initialBlock = findQueueBlockingResult(context, scopedJobId, requestId, { includePreparing: true });
        if (initialBlock) {
            return initialBlock;
        }
        cancelledJobs.delete(scopedJobId);

        // Reserve the scoped id before long async prep to avoid duplicate in-flight
        // requests racing into the queue with the same requestId.
        const preparingJob = createPreparingJob(context, scopedJobId, requestId);
        preparingJobs.set(scopedJobId, preparingJob);
        isPreparingReserved = true;
        sendOcrProgressStage(context.senderId, requestId, pages, 'model-prep');

        const requestBytes = await estimateRequestBytes(sourcePdfPath, pages);
        preparingJob.requestedBytes = requestBytes;
        const capacityResult = ensureQueueCapacity(requestBytes, { excludePreparingJobId: scopedJobId });
        if (!capacityResult.ok) {
            return createQueueFailure(requestId, capacityResult.error, 'OCR_QUEUE_BACKPRESSURE');
        }

        const modelPrepResult = await prepareLanguageModelsForQueueJob(
            context,
            preparingJob,
            scopedJobId,
            requestId,
            pages,
        );
        if (modelPrepResult) {
            return modelPrepResult;
        }

        const canceledBeforeRecheck = getCancelledBeforeStartResult(scopedJobId, requestId);
        if (canceledBeforeRecheck) {
            return canceledBeforeRecheck;
        }
        const recheckBlock = findQueueBlockingResult(context, scopedJobId, requestId, { includePreparing: false });
        if (recheckBlock) {
            return recheckBlock;
        }
        const recheckedCapacityResult = ensureQueueCapacity(requestBytes, { excludePreparingJobId: scopedJobId });
        if (!recheckedCapacityResult.ok) {
            return createQueueFailure(requestId, recheckedCapacityResult.error, 'OCR_QUEUE_BACKPRESSURE');
        }
        const canceledBeforeEnqueue = getCancelledBeforeStartResult(scopedJobId, requestId);
        if (canceledBeforeEnqueue) {
            return canceledBeforeEnqueue;
        }

        enqueuePreparedOcrJob(
            context,
            scopedJobId,
            sourcePdfPath,
            pages,
            requestId,
            requestBytes,
            options,
        );
        isPreparingReserved = false;

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
                errorCode: 'OCR_INTERNAL_ERROR',
            };
        }
        const errMsg = getErrorMessage(err);
        log.error(`Failed to queue OCR worker job: ${errMsg}`);
        return {
            started: false,
            jobId: requestId,
            error: errMsg,
            errorCode: 'OCR_INTERNAL_ERROR',
        };
    } finally {
        if (isPreparingReserved) {
            preparingJobs.delete(scopedJobId);
            clearOcrProgressPump(scopedJobId, requestId);
        }
        cleanupCancelledPreparation(scopedJobId);
    }
}

export async function handleOcrAcknowledgeResultFile(
    context: IOcrJobOperationContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
): Promise<{
    cleaned: boolean;
    error?: string; 
}> {
    registerSenderCleanup(context);
    await pendingResultFileStore.evictStale();

    const requestId = typeof requestIdPayload === 'string' ? requestIdPayload.trim() : '';
    if (!requestId) {
        return {
            cleaned: false,
            error: 'requestId must be a non-empty string',
        };
    }

    return pendingResultFileStore.acknowledge(
        context.senderId,
        requestId,
        typeof pdfPathPayload === 'string' ? pdfPathPayload : undefined,
    );
}

export function handleOcrCancel(
    context: IOcrJobOperationContext,
    requestId: string,
): IOcrCancelResult {
    const scopedJobId = toScopedOcrJobId(context.senderId, requestId);
    log.info(`[${requestId}] Cancel requested`);

    if (preparingJobs.has(scopedJobId)) {
        abortPreparingJob(scopedJobId, 'explicit cancel request');
        log.info(`[${requestId}] Preparing OCR job marked as cancelled`);
        return { canceled: true };
    }

    const queued = removeQueuedJob(scopedJobId, 'cancelling');
    if (queued) {
        log.info(`[${requestId}] Queued OCR job cancelled`);
        return { canceled: true };
    }

    const activeJob = activeJobs.get(scopedJobId);
    if (!activeJob) {
        log.info(`[${requestId}] No active OCR job found for cancel`);
        return {
            canceled: false,
            reason: 'not-found',
        };
    }

    terminateAndFinalizeActiveJob(scopedJobId, {
        markCancelled: true,
        reason: 'explicit cancel request',
    });
    log.info(`[${requestId}] Active OCR job cancelled`);
    return { canceled: true };
}

export async function shutdownOcrJobManager() {
    for (const queuedJob of queuedJobs) {
        clearOcrProgressPump(queuedJob.scopedJobId, queuedJob.requestId);
    }
    queuedJobs.splice(0, queuedJobs.length);
    queuedJobIds.clear();
    for (const preparingJob of preparingJobs.values()) {
        clearOcrProgressPump(preparingJob.scopedJobId, preparingJob.requestId);
        if (!preparingJob.abortController.signal.aborted) {
            preparingJob.abortController.abort(createAbortError('OCR job manager shutdown'));
        }
    }
    preparingJobs.clear();

    const activeEntries = Array.from(activeJobs.entries());
    for (const [
        scopedJobId,
        activeJob,
    ] of activeEntries) {
        activeJob.completed = true;
        activeJob.terminatedByUs = true;
        removePendingCompletionResultFile(activeJob);
        clearJobWatchdog(scopedJobId);
    }
    await Promise.allSettled(
        activeEntries.map(([
            scopedJobId,
            activeJob,
        ]) =>
            terminateWorkerSafely(scopedJobId, activeJob.worker, 'app shutdown')),
    );
    for (const [scopedJobId] of activeEntries) {
        finalizeActiveJob(scopedJobId);
    }

    await pendingResultFileStore.shutdown();

    ocrResourceGovernor.reset();
    cancelledJobs.clear();
    registeredSenderCleanupIds.clear();
}
