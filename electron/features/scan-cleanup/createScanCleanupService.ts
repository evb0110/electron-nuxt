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
    IScanCleanupStartResult,
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

interface IScanCleanupJob {
    abortController: AbortController;
    state: TScanCleanupJobState;
    subscribers: Set<WebContents>;
}

const jobs = new Map<string, IScanCleanupJob>();
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

function publish(job: IScanCleanupJob, state: TScanCleanupJobState) {
    job.state = state;
    for (const sender of job.subscribers) {
        if (!sender.isDestroyed()) sender.send(SCAN_CLEANUP_EVENT_CHANNELS.state, state);
    }
}

export function classifyScanCleanupError(error: unknown, aborted: boolean): TScanCleanupErrorCode {
    if (aborted) {
        return 'canceled';
    }
    const message = getErrorMessage(error);
    if (/not found|unavailable|ENOENT/iu.test(message)) {
        return 'tools-unavailable';
    }
    if (/evb-scan-cleanup/iu.test(message)) {
        return 'sidecar-failed';
    }
    return 'internal';
}

export interface IScanCleanupService {
    start: (sender: WebContents, request: IScanCleanupStartRequest) => Promise<IScanCleanupStartResult>;
    cancel: (jobId: string) => boolean;
    getState: (jobId: string) => TScanCleanupJobState | null;
    subscribe: (sender: WebContents, jobId: string) => TScanCleanupJobState | null;
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
                phase: 'queued' as const,
                processedCount: 0,
                totalPages: 1,
                percent: 0,
            };
            const job: IScanCleanupJob = {
                abortController,
                state: {
                    jobId,
                    status: 'queued',
                    progress,
                    updatedAtMs: Date.now(),
                },
                subscribers: new Set([sender]),
            };
            jobs.set(jobId, job);
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
                    if (!scanCleanupBinary || !pdfImageCombineBinary) throw new Error('Scan cleanup native tools are unavailable');
                    const summary = await runScanCleanupWorkerTask(
                        workerRequest,
                        {
                            qpdfBinary: pdfPaths.qpdf,
                            pdftoppmBinary: pdfPaths.pdftoppm,
                            ...(pdfPaths.pdfimages ? {pdfimagesBinary: pdfPaths.pdfimages} : {}),
                            scanCleanupBinary,
                            pdfImageCombineBinary,
                            tempDir: getAppTempDir(),
                        },
                        abortController.signal,
                        nextProgress => {
                            publish(job, {
                                jobId,
                                status: nextProgress.phase === 'handoff' ? 'handoff' : 'running',
                                progress: nextProgress,
                                updatedAtMs: Date.now(),
                            });
                            documentOutputService.update(jobId, {
                                phase: nextProgress.phase,
                                percent: nextProgress.percent,
                                current: nextProgress.processedCount,
                                total: nextProgress.totalPages,
                            });
                        },
                    );
                    const completed: TScanCleanupJobState = {
                        jobId,
                        status: 'completed',
                        outputPdfPath,
                        summary,
                        progress: {
                            phase: 'handoff',
                            processedCount: summary.inputPages,
                            totalPages: summary.inputPages,
                            percent: 100,
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
        cancel(jobId) {
            const job = jobs.get(jobId);
            if (!job || [
                'completed',
                'failed',
                'canceled',
            ].includes(job.state.status)) {
                return false;
            }
            job.abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
            mainJobBroker.cancelOwner(jobId, 'Scan cleanup canceled');
            return true;
        },
        getState(jobId) {
            return jobs.get(jobId)?.state ?? null;
        },
        subscribe(sender, jobId) {
            const job = jobs.get(jobId);
            if (!job) {
                return null;
            }
            job.subscribers.add(sender);
            return job.state;
        },
        pruneGeneratedOutputs(openPdfPaths) {
            return pruneScanCleanupGeneratedOutputs({openPdfPaths});
        },
    };
}
