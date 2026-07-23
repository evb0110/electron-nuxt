import { randomUUID } from 'crypto';
import {rm} from 'fs/promises';
import {
    dirname,
    isAbsolute,
} from 'path';
import { fileURLToPath } from 'url';
import type { WebContents } from 'electron';
import type {
    IScanCleanupStartRequest,
    IScanCleanupOwnerContext,
    TScanCleanupStartResult,
    TScanCleanupErrorCode,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import { documentOutputService } from '@electron/output/documentOutputService';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { resolveNativePdfImageCombinePath } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import { SCAN_CLEANUP_EVENT_CHANNELS } from '@electron/features/scan-cleanup/contract';
import { runScanCleanupWorkerTask } from '@electron/features/scan-cleanup/runScanCleanupWorkerTask';
import {
    createScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
} from '@electron/features/scan-cleanup/scanCleanupGeneratedOutputs';
import {allowOpenPath} from '@electron/file-access/openPathCapabilities';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {createOwnerScopedJobRegistry} from '@electron/features/scan-cleanup/createOwnerScopedJobRegistry';

interface IScanCleanupJob {
    abortController: AbortController;
    state: TScanCleanupJobState;
    subscribers: Set<WebContents>;
}

const jobs = createOwnerScopedJobRegistry<WebContents, IScanCleanupJob>();
const currentDir = dirname(fileURLToPath(import.meta.url));

export function resolveScanCleanupPath() {
    return resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-scan-cleanup.exe' : 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        currentDir,
        envOverridePath: process.env.EVB_SCAN_CLEANUP_PATH,
        isPackaged: currentDir.includes('app.asar'),
    });
}

export function grantScanCleanupOutputAccess(
    outputPdfPath: string,
    subscribers: Iterable<WebContents>,
) {
    for (const subscriber of subscribers) {
        if (!subscriber.isDestroyed()) allowOpenPath(outputPdfPath, subscriber);
    }
}

function publish(job: IScanCleanupJob, state: TScanCleanupJobState) {
    if (state.status === 'completed') {
        grantScanCleanupOutputAccess(state.outputPdfPath, job.subscribers);
    }
    job.state = state;
    for (const sender of job.subscribers) {
        if (!sender.isDestroyed()) sender.send(SCAN_CLEANUP_EVENT_CHANNELS.state, state);
    }
    if ([
        'completed',
        'failed',
        'canceled',
    ].includes(state.status)) jobs.expireTerminal(state.jobId);
}

export function classifyScanCleanupError(error: unknown, aborted: boolean): TScanCleanupErrorCode {
    if (aborted) {
        return 'canceled';
    }
    if (hasNativeErrorCode(error)) {
        return error.code;
    }
    const errorCode = error && typeof error === 'object' && 'code' in error
        ? (error as {code?: unknown}).code
        : undefined;
    if (errorCode === 'ENOENT') {
        return 'tools-unavailable';
    }
    return 'internal';
}

export interface IScanCleanupService {
    start: (sender: WebContents, request: IScanCleanupStartRequest) => Promise<TScanCleanupStartResult>;
    cancel: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getState: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    subscribe: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    pruneGeneratedOutputs: (openPdfPaths: string[]) => Promise<number>;
}

export function createScanCleanupService(): IScanCleanupService {
    return {
        async start(sender, request) {
            const jobId = `scan-cleanup-${randomUUID()}`;
            if (!isAbsolute(request.sourcePdfPath)) {
                return {
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                };
            }
            const outputPdfPath = await createScanCleanupGeneratedOutputPath(request.sourcePdfPath);
            const workerRequest = {
                ...request,
                outputPdfPath,
            };
            const abortController = new AbortController();
            const progress = {
                stage: 'queued' as const,
                completedUnits: 0,
                totalUnits: 0,
                percent: 0,
                completedPageNumbers: [],
            };
            const job: IScanCleanupJob = {
                abortController,
                state: {
                    jobId,
                    status: 'queued',
                    progress,
                    updatedAtMs: Date.now(),
                },
                subscribers: new Set<WebContents>(),
            };
            jobs.add(jobId, sender, request, job);
            documentOutputService.start({
                operation: 'scan-cleanup',
                sourceKind: 'pdf',
                jobId,
                initialPhase: 'queued',
            });
            void (async () => {
                let lease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
                try {
                    lease = await mainJobBroker.acquire({
                        ownerId: jobId,
                        kind: 'scan-cleanup',
                        priority: 'user',
                        resources: {
                            cpuTokens: 2,
                            estimatedResidentBytes: 384 * 1024 * 1024,
                            nativeProcesses: 1,
                            ioWeight: 4,
                        },
                        perOwnerLimit: 1,
                        signal: abortController.signal,
                    });
                    const pdfPaths = getPdfNativeToolPaths();
                    const scanCleanupBinary = resolveScanCleanupPath();
                    const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
                    const pdfPageOpsBinary = request.options.preserveOriginalQuality
                        ? resolveNativePageOpsPath()
                        : null;
                    if (!scanCleanupBinary || !pdfImageCombineBinary || (request.options.preserveOriginalQuality && !pdfPageOpsBinary)) {
                        throw new Error('Scan cleanup native tools are unavailable');
                    }
                    const summary = await runScanCleanupWorkerTask(
                        workerRequest,
                        {
                            qpdfBinary: pdfPaths.qpdf,
                            pdftoppmBinary: pdfPaths.pdftoppm,
                            ...(pdfPaths.pdfimages ? {pdfimagesBinary: pdfPaths.pdfimages} : {}),
                            scanCleanupBinary,
                            pdfImageCombineBinary,
                            ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                            tempDir: getAppTempDir(),
                        },
                        abortController.signal,
                        nextProgress => {
                            publish(job, {
                                jobId,
                                status: nextProgress.stage === 'handoff' ? 'handoff' : 'running',
                                progress: nextProgress,
                                updatedAtMs: Date.now(),
                            });
                            documentOutputService.update(jobId, {
                                phase: nextProgress.stage,
                                percent: nextProgress.percent,
                                current: nextProgress.completedUnits,
                                total: nextProgress.totalUnits,
                            });
                        },
                    );
                    const completed: TScanCleanupJobState = {
                        jobId,
                        status: 'completed',
                        outputPdfPath,
                        summary,
                        runOcrAfterCleanup: request.runOcrAfterCleanup === true,
                        progress: {
                            stage: 'handoff',
                            completedUnits: summary.inputPages,
                            totalUnits: summary.inputPages,
                            percent: 100,
                            completedPageNumbers: Array.from({length: summary.inputPages}, (_, index) => index + 1),
                        },
                        updatedAtMs: Date.now(),
                    };
                    publish(job, completed);
                    documentOutputService.handoff(jobId, outputPdfPath);
                    documentOutputService.finish(jobId, 'completed');
                } catch (error) {
                    const aborted = abortController.signal.aborted;
                    const errorCode = classifyScanCleanupError(error, aborted);
                    await rm(dirname(outputPdfPath), {
                        recursive: true,
                        force: true,
                    }).catch(() => undefined);
                    if (aborted) {
                        publish(job, {
                            ...job.state,
                            status: 'canceled',
                            updatedAtMs: Date.now(),
                        });
                        documentOutputService.finish(jobId, 'canceled');
                    } else {
                        const message = getErrorMessage(error);
                        publish(job, {
                            ...job.state,
                            status: 'failed',
                            error: message,
                            errorCode,
                            updatedAtMs: Date.now(),
                        });
                        documentOutputService.finish(jobId, 'failed', message);
                    }
                } finally {
                    lease?.release();
                }
            })();
            return {
                started: true,
                jobId,
                outputPdfPath,
            };
        },
        cancel(sender, jobId, owner) {
            const job = jobs.getOwned(jobId, sender, owner);
            if (!job || [
                'completed',
                'failed',
                'canceled',
            ].includes(job.state.status)) {
                return false;
            }
            publish(job, {
                ...job.state,
                status: 'canceling',
                updatedAtMs: Date.now(),
            });
            // AbortSignal is the sole cancellation transport. The worker adapter
            // translates it into cooperative cancel and, after its grace period, termination.
            job.abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
            return true;
        },
        getState(sender, jobId, owner) {
            return jobs.getOwned(jobId, sender, owner)?.state ?? null;
        },
        subscribe(sender, jobId, owner) {
            const job = jobs.subscribe(jobId, sender, owner);
            if (!job) {
                return null;
            }
            if (job.state.status === 'completed') {
                grantScanCleanupOutputAccess(job.state.outputPdfPath, [sender]);
            }
            return job.state;
        },
        pruneGeneratedOutputs(openPdfPaths) {
            return pruneScanCleanupGeneratedOutputs({openPdfPaths});
        },
    };
}
