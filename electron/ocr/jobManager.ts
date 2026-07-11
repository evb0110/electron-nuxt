import type { Worker } from 'worker_threads';
import {
    OCR_MODEL_PREP_TIMEOUT_MS,
    OCR_QUEUE_MAX_AGE_MS,
    OCR_QUEUE_MAX_SIZE,
    OCR_RESULT_FILE_ACK_TTL_MS,
    OCR_WORKER_POOL_SIZE,
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
import { createOcrJobWorkerLifecycleController } from '@electron/ocr/ocrJobWorkerLifecycle';
import { ocrResourceGovernor } from '@electron/ocr/ocrResourceGovernor';
import {
    handleWorkerResourceMessage,
    isWorkerResourceMessage,
} from '@electron/ocr/ocrWorkerResourceMessages';
import { createPreparingOcrJob } from '@electron/ocr/createPreparingOcrJob';
import { createOcrWorkingCopyInvalidationController } from '@electron/ocr/createOcrWorkingCopyInvalidationController';
import {
    createOcrQueueFailure,
    type IOcrQueueStartResult,
} from '@electron/ocr/createOcrQueueFailure';
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
import {
    clearOcrProgressPump,
    enqueueOcrProgress,
    enqueueTerminalOcrProgress,
    getJobWindow,
    safeSendToWindow,
    sendOcrProgressStage,
} from '@electron/ocr/ocrProgressDispatch';
import type {
    IOcrCancelResult,
    IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import { createLogger } from '@electron/utils/createLogger';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';
import { getErrorMessage } from '@electron/utils/error';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { estimateOcrRequestWork } from '@electron/ocr/estimateOcrRequestWork';
import { runDetached } from '@electron/utils/runDetached';
import {documentOutputService} from '@electron/output/documentOutputService';
import {
    ensureOcrQueueCapacity,
    getBufferedOcrBytes,
} from '@electron/ocr/ocrQueueCapacity';
import {
    mainJobBroker,
    type IJobBrokerLease,
} from '@electron/resources/jobBroker';
import { removeOcrResultArtifacts } from '@electron/ocr/removeOcrResultArtifacts';
const log = createLogger('ocr-ipc');
export {
    safeSendToWindow,
    subscribeManagedOcrProgress,
} from '@electron/ocr/ocrProgressDispatch';
const activeJobs = new Map<string, IOcrActiveJob>();
const preparingJobs = new Map<string, IOcrPreparingJob>();
const pendingAdmissionPromises = new Map<string, Promise<void>>();
const scopedJobIdsByDocumentJobKey = new Map<string, string>();
const cancelledJobs = new Set<string>();
const registeredSenderCleanupIds = new Set<number>();
const workerCleanupTimersByScopedJobId = new Map<string, NodeJS.Timeout>();
const OCR_WORKER_BROKER_OWNER_ID = 'ocr-worker-pool';
const OCR_WORKER_ADMISSION_RESOURCES = {
    cpuTokens: 0.25,
    estimatedResidentBytes: 64 * 1024 * 1024,
    nativeProcesses: 0,
    ioWeight: 0.25,
};
function assertNever(value: never) {
    throw new Error(`Unhandled OCR worker message: ${JSON.stringify(value)}`);
}
function getOcrSourcePathKey(sourcePdfPath: string) {
    return normalizePathForLookup(sourcePdfPath) || sourcePdfPath;
}
function getOcrDocumentJobKey(sourcePdfPath: string, documentRevision: IOcrQueuedJob['documentRevision']) {
    return `${getOcrSourcePathKey(sourcePdfPath)}\0${documentRevision.token}`;
}

function reserveOcrDocumentJob(documentJobKey: string, scopedJobId: string) {
    const existingScopedJobId = scopedJobIdsByDocumentJobKey.get(documentJobKey);
    if (existingScopedJobId && existingScopedJobId !== scopedJobId) {
        return existingScopedJobId;
    }
    scopedJobIdsByDocumentJobKey.set(documentJobKey, scopedJobId);
    return null;
}
function releaseOcrDocumentJobReservation(scopedJobId: string, documentJobKey?: string) {
    if (documentJobKey !== undefined) {
        if (scopedJobIdsByDocumentJobKey.get(documentJobKey) === scopedJobId) {
            scopedJobIdsByDocumentJobKey.delete(documentJobKey);
        }
        return;
    }

    for (const [
        candidateDocumentJobKey,
        candidateScopedJobId,
    ] of scopedJobIdsByDocumentJobKey.entries()) {
        if (candidateScopedJobId === scopedJobId) {
            scopedJobIdsByDocumentJobKey.delete(candidateDocumentJobKey);
        }
    }
}

const pendingResultFileStore = createPendingResultFileStore({
    logger: log,
    ttlMs: OCR_RESULT_FILE_ACK_TTL_MS,
    removeResultFile: path => removeOcrResultArtifacts(path, log),
});
const {
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
} = createOcrJobWorkerLifecycleController({
    activeJobs,
    cancelledJobs,
    workerCleanupTimersByScopedJobId,
    pendingResultFileStore,
    logger: log,
    clearOcrProgressPump,
    enqueueOcrProgress: enqueueTerminalOcrProgress,
    getJobWindow,
    onFinalizeActiveJob: (scopedJobId, job) => {
        job?.workerAdmissionLease.release();
        releaseOcrDocumentJobReservation(scopedJobId, job?.documentJobKey);
    },
    removeResultFile: path => removeOcrResultArtifacts(path, log),
    safeSendToWindow,
});

function ensureQueueCapacity(
    additionalWork: {
        bytes: number;
        pageWork: number;
        documentJobKey: string
    },
    options: { excludePreparingJobId?: string } = {},
){
    return ensureOcrQueueCapacity({
        activeJobs: activeJobs.values(),
        preparingJobs,
    }, additionalWork, options);
}

function logQueueDepth(context: string) {
    log.debug(
        `${context}: active=${activeJobs.size}/${OCR_WORKER_POOL_SIZE}, broker-pending=${preparingJobs.size}/${OCR_QUEUE_MAX_SIZE}, bufferedMB=${(getBufferedOcrBytes({
            activeJobs: activeJobs.values(),
            preparingJobs,
        }) / (1024 * 1024)).toFixed(1)}`,
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

function cancelJobsForSender(webContentsId: number, reason: string) {
    for (const preparingJob of Array.from(preparingJobs.values())) {
        if (!isScopedJobOwnedBySender(preparingJob.scopedJobId, webContentsId)) {
            continue;
        }

        abortPreparingJob(preparingJob.scopedJobId, reason);
        sendJobCancellation(preparingJob, reason);
        log.info(`[${preparingJob.requestId}] Marked preparing OCR job as cancelled: ${reason}`);
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

    runDetached(
        () => pendingResultFileStore.cleanupForSender(webContentsId),
        {
            label: `cleanup OCR results for renderer ${webContentsId}`,
            logger: log,
        },
    );
}

export const { cancelOcrJobsForWorkingCopy } = createOcrWorkingCopyInvalidationController({
    abortPreparingJob,
    activeJobs,
    logger: log,
    sendJobCancellation,
    terminateAndFinalizeActiveJob,
    preparingJobs,
});

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
            enqueueOcrProgress(scopedJobId, message.progress);
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

function startBrokerAdmittedJob(job: IOcrQueuedJob, workerAdmissionLease: IJobBrokerLease) {
    let worker: Worker;
    try {
        worker = createOcrWorker();
    } catch (error) {
        const message = getErrorMessage(error);
        sendJobFailure(job, `OCR worker unavailable: ${message}`, {
            code: 'OCR_WORKER_UNAVAILABLE',
            retryable: true,
        });
        workerAdmissionLease.release();
        releaseOcrDocumentJobReservation(job.scopedJobId, job.documentJobKey);
        log.error(`Failed to start OCR worker for job ${job.requestId}: ${message}`);
        return;
    }

    const activeJob: IOcrActiveJob = {
        ...job,
        workerAdmissionLease,
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
            documentRevision: job.documentRevision,
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

function findQueueBlockingResult(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    requestId: string,
    options: {
        includePreparing: boolean;
        documentJobKey?: string
    },
): IOcrQueueStartResult | null {
    if (context.sender.isDestroyed()) {
        return createOcrQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
    }

    const isExistingJob = activeJobs.has(scopedJobId)
        || (options.includePreparing && preparingJobs.has(scopedJobId));
    if (isExistingJob) {
        return createOcrQueueFailure(
            requestId,
            `OCR job with id "${requestId}" already exists`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    if (options.documentJobKey) {
        const existingScopedJobId = scopedJobIdsByDocumentJobKey.get(options.documentJobKey);
        if (existingScopedJobId && existingScopedJobId !== scopedJobId) {
            return createOcrQueueFailure(
                requestId,
                'OCR job for this document revision is already in progress',
                'OCR_QUEUE_BACKPRESSURE',
            );
        }
    }

    if (pendingResultFileStore.find(context.senderId, requestId)) {
        return createOcrQueueFailure(
            requestId,
            `OCR job with id "${requestId}" is waiting for result-file acknowledgement`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    return null;
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
        return createOcrQueueFailure(requestId, 'OCR job was cancelled before it started');
    }
    if (context.sender.isDestroyed()) {
        return createOcrQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
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
        ? createOcrQueueFailure(requestId, 'OCR job was cancelled before it started')
        : null;
}

async function admitPreparedOcrJob(
    context: IOcrJobOperationContext,
    preparingJob: IOcrPreparingJob,
    queuedJob: IOcrQueuedJob,
) {
    const queueTimeout = setTimeout(() => {
        if (!preparingJob.abortController.signal.aborted) {
            preparingJob.abortController.abort(new DOMException(
                'OCR queue item expired before JobBroker admission',
                'TimeoutError',
            ));
        }
    }, OCR_QUEUE_MAX_AGE_MS);
    queueTimeout.unref?.();

    let workerAdmissionLease: IJobBrokerLease | null = null;
    try {
        workerAdmissionLease = await mainJobBroker.acquire({
            ownerId: OCR_WORKER_BROKER_OWNER_ID,
            kind: 'ocr-worker',
            priority: 'user',
            resources: OCR_WORKER_ADMISSION_RESOURCES,
            perOwnerLimit: OCR_WORKER_POOL_SIZE,
            signal: preparingJob.abortController.signal,
        });
        if (
            preparingJob.abortController.signal.aborted
            || cancelledJobs.has(queuedJob.scopedJobId)
            || context.sender.isDestroyed()
            || preparingJobs.get(queuedJob.scopedJobId) !== preparingJob
        ) {
            workerAdmissionLease.release();
            return;
        }

        preparingJobs.delete(queuedJob.scopedJobId);
        startBrokerAdmittedJob(queuedJob, workerAdmissionLease);
        workerAdmissionLease = null;
    } catch (error) {
        if (!cancelledJobs.has(queuedJob.scopedJobId)) {
            const message = error instanceof Error && error.name === 'TimeoutError'
                ? 'OCR queue item expired before processing'
                : `OCR worker admission failed: ${getErrorMessage(error)}`;
            sendJobFailure(queuedJob, message, {
                code: 'OCR_QUEUE_BACKPRESSURE',
                retryable: true,
            });
        }
    } finally {
        clearTimeout(queueTimeout);
        workerAdmissionLease?.release();
        if (!activeJobs.has(queuedJob.scopedJobId)) {
            preparingJobs.delete(queuedJob.scopedJobId);
            releaseOcrDocumentJobReservation(queuedJob.scopedJobId, queuedJob.documentJobKey);
            clearOcrProgressPump(queuedJob.scopedJobId, queuedJob.requestId);
        }
        cleanupCancelledPreparation(queuedJob.scopedJobId);
    }
}

function enqueuePreparedOcrJob(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    documentJobKey: string,
    sourcePdfPath: string,
    documentRevision: IOcrQueuedJob['documentRevision'],
    pages: IOcrPdfPageRequest[],
    requestId: string,
    requestBytes: number,
    pageWork: number,
    options: IOcrSearchablePdfOptions,
) {
    const preparingJob = preparingJobs.get(scopedJobId);
    if (!preparingJob) {
        throw new Error(`Missing preparing OCR job ${scopedJobId} before JobBroker admission`);
    }
    preparingJob.lifecycleState = transitionOcrJobLifecycle(
        preparingJob.lifecycleState,
        'queued',
        scopedJobId,
    );
    const queuedJob: IOcrQueuedJob = {
        lifecycleState: 'queued',
        scopedJobId,
        documentJobKey,
        requestId,
        webContentsId: context.senderId,
        sourcePdfPath,
        documentRevision,
        pages,
        options,
        queuedAtMs: Date.now(),
        requestedBytes: requestBytes,
        pageWork,
    };
    logQueueDepth(`OCR job ${requestId} submitted to JobBroker`);
    const admissionPromise = admitPreparedOcrJob(context, preparingJob, queuedJob);
    pendingAdmissionPromises.set(scopedJobId, admissionPromise);
    runDetached(
        () => admissionPromise.finally(() => pendingAdmissionPromises.delete(scopedJobId)),
        {
            label: `admit OCR worker ${requestId}`,
            logger: log,
        },
    );
}

function cleanupCancelledPreparation(scopedJobId: string) {
    if (
        cancelledJobs.has(scopedJobId)
        && !activeJobs.has(scopedJobId)
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

        await pendingResultFileStore.evictStale();

        const initialBlock = findQueueBlockingResult(context, scopedJobId, requestId, { includePreparing: true });
        if (initialBlock) {
            return initialBlock;
        }
        cancelledJobs.delete(scopedJobId);
        const documentRevision = await getWorkingCopyRevision(sourcePdfPath, context.senderId);
        const documentJobKey = getOcrDocumentJobKey(sourcePdfPath, documentRevision);
        const documentBlock = findQueueBlockingResult(context, scopedJobId, requestId, {
            includePreparing: true,
            documentJobKey,
        });
        if (documentBlock) {
            return documentBlock;
        }
        const existingDocumentJob = reserveOcrDocumentJob(documentJobKey, scopedJobId);
        if (existingDocumentJob) {
            return createOcrQueueFailure(
                requestId,
                'OCR job for this document revision is already in progress',
                'OCR_QUEUE_BACKPRESSURE',
            );
        }

        // Reserve the scoped id before long async prep to avoid duplicate in-flight
        // requests racing into the queue with the same requestId.
        const preparingJob = createPreparingOcrJob(context, scopedJobId, documentJobKey, requestId, sourcePdfPath, documentRevision);
        preparingJobs.set(scopedJobId, preparingJob);
        isPreparingReserved = true;
        sendOcrProgressStage(context.senderId, requestId, pages, 'model-prep');

        const requestWork = estimateOcrRequestWork(pages, options);
        preparingJob.requestedBytes = requestWork.bytes;
        preparingJob.pageWork = requestWork.pageWork;
        const capacityResult = ensureQueueCapacity({
            bytes: requestWork.bytes,
            pageWork: requestWork.pageWork,
            documentJobKey,
        }, { excludePreparingJobId: scopedJobId });
        if (!capacityResult.ok) {
            return createOcrQueueFailure(requestId, capacityResult.error, 'OCR_QUEUE_BACKPRESSURE');
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
        const recheckBlock = findQueueBlockingResult(context, scopedJobId, requestId, {
            includePreparing: false,
            documentJobKey,
        });
        if (recheckBlock) {
            return recheckBlock;
        }
        const recheckedCapacityResult = ensureQueueCapacity({
            bytes: requestWork.bytes,
            pageWork: requestWork.pageWork,
            documentJobKey,
        }, { excludePreparingJobId: scopedJobId });
        if (!recheckedCapacityResult.ok) {
            return createOcrQueueFailure(requestId, recheckedCapacityResult.error, 'OCR_QUEUE_BACKPRESSURE');
        }
        const canceledBeforeEnqueue = getCancelledBeforeStartResult(scopedJobId, requestId);
        if (canceledBeforeEnqueue) {
            return canceledBeforeEnqueue;
        }

        enqueuePreparedOcrJob(
            context,
            scopedJobId,
            documentJobKey,
            sourcePdfPath,
            documentRevision,
            pages,
            requestId,
            requestWork.bytes,
            requestWork.pageWork,
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
            const preparingJob = preparingJobs.get(scopedJobId);
            preparingJobs.delete(scopedJobId);
            releaseOcrDocumentJobReservation(scopedJobId, preparingJob?.documentJobKey);
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

    const pending = pendingResultFileStore.find(context.senderId, requestId);
    const result = await pendingResultFileStore.acknowledge(
        context.senderId,
        requestId,
        typeof pdfPathPayload === 'string' ? pdfPathPayload : undefined,
    );
    if (result.cleaned && pending) {
        documentOutputService.finish(pending.scopedJobId, 'completed');
    }
    return result;
}

export function handleOcrCancel(
    context: IOcrJobOperationContext,
    requestId: string,
): IOcrCancelResult {
    const scopedJobId = toScopedOcrJobId(context.senderId, requestId);
    log.info(`[${requestId}] Cancel requested`);

    if (preparingJobs.has(scopedJobId)) {
        const preparingJob = preparingJobs.get(scopedJobId);
        abortPreparingJob(scopedJobId, 'explicit cancel request');
        if (preparingJob) {
            sendJobCancellation(preparingJob, 'explicit cancel request');
        }
        log.info(`[${requestId}] Preparing OCR job marked as cancelled`);
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

async function stopOcrJobManager(options: {shutdownResultStore: boolean}) {
    for (const preparingJob of preparingJobs.values()) {
        clearOcrProgressPump(preparingJob.scopedJobId, preparingJob.requestId);
        releaseOcrDocumentJobReservation(preparingJob.scopedJobId, preparingJob.documentJobKey);
        if (!preparingJob.abortController.signal.aborted) {
            preparingJob.abortController.abort(createAbortError('OCR job manager shutdown'));
        }
    }
    await Promise.allSettled(pendingAdmissionPromises.values());
    pendingAdmissionPromises.clear();
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

    if (options.shutdownResultStore) {
        await pendingResultFileStore.shutdown();
    }

    ocrResourceGovernor.reset();
    scopedJobIdsByDocumentJobKey.clear();
    cancelledJobs.clear();
    registeredSenderCleanupIds.clear();
}

export function recoverOcrJobManager() {
    return stopOcrJobManager({shutdownResultStore: false});
}

export function shutdownOcrJobManager() {
    return stopOcrJobManager({shutdownResultStore: true});
}
