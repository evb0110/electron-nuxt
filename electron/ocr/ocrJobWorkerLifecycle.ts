import type { BrowserWindow } from 'electron';
import type { Worker } from 'worker_threads';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
import {
    OCR_JOB_IDLE_TIMEOUT_MS,
    OCR_WORKER_TERMINATE_TIMEOUT_MS,
} from '@electron/ocr/jobManager.config';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/ocr/jobManager.types';
import type { createPendingResultFileStore } from '@electron/ocr/createPendingResultFileStore';
import { transitionOcrJobLifecycle } from '@electron/ocr/ocrJobLifecycle';
import { ocrResourceGovernor } from '@electron/ocr/ocrResourceGovernor';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';
import { buildOcrErrorEnvelope } from '@electron/ocr/contracts';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import type {
    IOcrErrorEnvelope,
    TOcrErrorCode,
} from '@contracts/electronApiOcr';

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

type TOcrPendingResultFileStore = ReturnType<typeof createPendingResultFileStore>;

interface IOcrJobWorkerLifecycleControllerOptions {
    activeJobs: Map<string, IOcrActiveJob>;
    cancelledJobs: Set<string>;
    workerCleanupTimersByScopedJobId: Map<string, NodeJS.Timeout>;
    pendingResultFileStore: TOcrPendingResultFileStore;
    logger: ILogger;
    clearOcrProgressPump: (scopedJobId: string, requestId?: string) => void;
    dispatchQueuedJobs: () => void;
    getJobWindow: (webContentsId: number) => BrowserWindow | null | undefined;
    onFinalizeActiveJob?: (scopedJobId: string, job: IOcrActiveJob | null) => void;
    removeResultFile: (path: string) => Promise<boolean>;
    safeSendToWindow: (
        window: BrowserWindow | null | undefined,
        channel: typeof OCR_EVENT_CHANNELS[keyof typeof OCR_EVENT_CHANNELS],
        ...args: unknown[]
    ) => void;
}

export interface IOcrTerminalErrorEnvelopeOptions {
    code?: TOcrErrorCode;
    details?: string;
    retryable?: boolean;
}

export interface IOcrTerminateActiveJobOptions {
    markCancelled?: boolean;
    reason: string;
}

export interface IOcrJobWorkerLifecycleController {
    clearJobWatchdog(scopedJobId: string): void;
    createTerminalOcrErrorEnvelope(error: string, envelopeOptions?: IOcrTerminalErrorEnvelopeOptions): IOcrErrorEnvelope;
    finalizeActiveJob(scopedJobId: string): void;
    isCurrentActiveWorker(scopedJobId: string, worker: Worker): boolean;
    removePendingCompletionResultFile(job: IOcrActiveJob): void;
    resetJobWatchdog(job: IOcrQueuedJob): void;
    sendJobFailure(job: IOcrQueuedJob, error: string, failureOptions?: IOcrTerminalErrorEnvelopeOptions): void;
    sendJobCancellation(job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'scopedJobId' | 'requestId' | 'webContentsId'>, reason: string): void;
    sendPendingCompletionResult(job: IOcrActiveJob): boolean;
    terminateAndFinalizeActiveJob(scopedJobId: string, terminateOptions: IOcrTerminateActiveJobOptions): void;
    terminateWorkerSafely(scopedJobId: string, worker: Worker, reason: string, requestId?: string): Promise<void>;
}

export function createOcrJobWorkerLifecycleController(
    options: IOcrJobWorkerLifecycleControllerOptions,
): IOcrJobWorkerLifecycleController {
    const {
        activeJobs,
        cancelledJobs,
        workerCleanupTimersByScopedJobId,
        pendingResultFileStore,
        logger,
        clearOcrProgressPump,
        dispatchQueuedJobs,
        getJobWindow,
        onFinalizeActiveJob,
        removeResultFile,
        safeSendToWindow,
    } = options;

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

    function createTerminalOcrErrorEnvelope(
        error: string,
        envelopeOptions: IOcrTerminalErrorEnvelopeOptions = {},
    ): IOcrErrorEnvelope {
        return buildOcrErrorEnvelope(
            envelopeOptions.code ?? 'OCR_INTERNAL_ERROR',
            error,
            {
                retryable: envelopeOptions.retryable ?? false,
                ...(envelopeOptions.details ? { details: envelopeOptions.details } : {}),
            },
        );
    }

    function sendJobFailure(
        job: IOcrQueuedJob,
        error: string,
        failureOptions: IOcrTerminalErrorEnvelopeOptions = {},
    ) {
        const window = getJobWindow(job.webContentsId);
        clearOcrProgressPump(job.scopedJobId, job.requestId);
        safeSendToWindow(window, OCR_EVENT_CHANNELS.complete, {
            requestId: job.requestId,
            success: false,
            errors: [error],
            errorEnvelope: createTerminalOcrErrorEnvelope(error, failureOptions),
        });
    }

    function sendJobCancellation(
        job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'scopedJobId' | 'requestId' | 'webContentsId'>,
        reason: string,
    ) {
        const message = 'OCR job was cancelled';
        const window = getJobWindow(job.webContentsId);
        clearOcrProgressPump(job.scopedJobId, job.requestId);
        safeSendToWindow(window, OCR_EVENT_CHANNELS.complete, {
            requestId: job.requestId,
            success: false,
            errors: [message],
            errorEnvelope: createTerminalOcrErrorEnvelope(message, { details: reason }),
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

    function removePendingCompletionResultFile(job: IOcrActiveJob) {
        const result = job.pendingCompletionResult;
        if (!result?.success) {
            return;
        }

        job.pendingCompletionResult = null;
        void removeResultFile(result.pdfPath);
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
            logger.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${getErrorMessage(error)}`);
        }
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
        onFinalizeActiveJob?.(scopedJobId, activeJob ?? null);
        dispatchQueuedJobs();
    }

    function terminateAndFinalizeActiveJob(
        scopedJobId: string,
        terminateOptions: IOcrTerminateActiveJobOptions,
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
        if (terminateOptions.markCancelled) {
            cancelledJobs.add(scopedJobId);
            if (!activeJob.terminalResultSent) {
                removePendingCompletionResultFile(activeJob);
                activeJob.lifecycleState = transitionOcrJobLifecycle(
                    activeJob.lifecycleState,
                    'terminal-result-sent',
                    scopedJobId,
                );
                activeJob.terminalResultSent = true;
                sendJobCancellation(activeJob, terminateOptions.reason);
            } else if (activeJob.lifecycleState !== 'terminal-result-sent') {
                activeJob.lifecycleState = transitionOcrJobLifecycle(
                    activeJob.lifecycleState,
                    'cancelling',
                    scopedJobId,
                );
            }
        }
        clearJobWatchdog(scopedJobId);
        clearWorkerCleanupTimer(scopedJobId);
        void terminateWorkerSafely(scopedJobId, activeJob.worker, terminateOptions.reason, activeJob.requestId).finally(() => {
            if (terminateOptions.markCancelled) {
                cancelledJobs.delete(scopedJobId);
            }
            finalizeActiveJob(scopedJobId);
        });
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

            logger.warn(`[${job.scopedJobId}] OCR worker cleanup did not complete within ${OCR_WORKER_CLEANUP_GRACE_MS}ms after terminal result`);
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
            pendingActiveJob.lifecycleState = transitionOcrJobLifecycle(
                pendingActiveJob.lifecycleState,
                'terminal-result-sent',
                job.scopedJobId,
            );
            pendingActiveJob.terminalResultSent = true;
            terminateAndFinalizeActiveJob(job.scopedJobId, {
                markCancelled: true,
                reason: `watchdog idle timeout (${OCR_JOB_IDLE_TIMEOUT_MS}ms)`,
            });
            logger.error(`OCR watchdog idle timed out job ${job.requestId}`);
        }, OCR_JOB_IDLE_TIMEOUT_MS);
        watchdog.unref?.();
        activeJob.watchdogTimer = watchdog;
    }

    function isCurrentActiveWorker(scopedJobId: string, worker: Worker) {
        const activeJob = activeJobs.get(scopedJobId);
        return Boolean(activeJob && activeJob.worker === worker && !activeJob.completed && !activeJob.terminatedByUs);
    }

    return {
        clearJobWatchdog,
        createTerminalOcrErrorEnvelope,
        finalizeActiveJob,
        isCurrentActiveWorker,
        removePendingCompletionResultFile,
        resetJobWatchdog,
        sendJobFailure,
        sendJobCancellation,
        sendPendingCompletionResult,
        terminateAndFinalizeActiveJob,
        terminateWorkerSafely,
    };
}
