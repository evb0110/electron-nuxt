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
    TScanCleanupProgress,
    TScanCleanupSummary,
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
import { SCAN_CLEANUP_PLATFORM_FEATURE } from '@contracts/scanCleanupPlatformFeature';
import { runScanCleanupWorkerTask } from '@electron/features/scan-cleanup/runScanCleanupWorkerTask';
import {
    createScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
} from '@electron/features/scan-cleanup/scanCleanupGeneratedOutputs';
import {allowOpenPath} from '@electron/file-access/openPathCapabilities';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobRegistry,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';

interface IScanCleanupJobResult {
    completedPageNumbers: number[];
    outputPdfPath: string;
    partial: boolean;
    summary: TScanCleanupSummary;
}

type TScanCleanupJobError = IMainJobErrorEnvelope<TScanCleanupErrorCode>;
type TScanCleanupJobRegistry = IMainJobRegistry<TScanCleanupJobState, IScanCleanupJobResult, TScanCleanupJobError>;
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
        allowOpenPath(outputPdfPath, subscriber);
    }
}

function sendScanCleanupState(sender: WebContents, state: TScanCleanupJobState) {
    if (sender.isDestroyed()) {
        return;
    }
    if (state.status === 'completed') grantScanCleanupOutputAccess(state.outputPdfPath, [sender]);
    sender.send(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onJobState, state);
}

function publicState(
    snapshot: TMainJobSnapshot<TScanCleanupJobState, IScanCleanupJobResult, TScanCleanupJobError> | null,
) {
    return snapshot?.progress ?? null;
}

function ownerActor(sender: WebContents, owner: IScanCleanupOwnerContext) {
    return {
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    };
}

function completedProgress(
    latest: TScanCleanupJobState,
    result: IScanCleanupJobResult,
): TScanCleanupJobState {
    return {
        jobId: latest.jobId,
        status: 'completed',
        outputPdfPath: result.outputPdfPath,
        summary: result.summary,
        partial: result.partial,
        progress: {
            ...latest.progress,
            stage: 'handoff',
            completedUnits: result.summary.inputPages,
            totalUnits: result.summary.inputPages,
            percent: 100,
            completedPageNumbers: result.completedPageNumbers,
        },
        updatedAtMs: Date.now(),
    };
}

function terminalProgress(
    latest: TScanCleanupJobState,
    status: 'canceled' | 'failed',
    error: TScanCleanupJobError,
): TScanCleanupJobState {
    const base = {
        jobId: latest.jobId,
        progress: latest.progress,
        updatedAtMs: Date.now(),
    };
    return status === 'canceled'
        ? {
            ...base,
            status,
        }
        : {
            ...base,
            status,
            error: error.message,
            errorCode: error.code,
        };
}

function createScanCleanupJobRegistry(): TScanCleanupJobRegistry {
    return createMainJobRegistry({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause),
        }),
        terminalProgress: {
            completed: completedProgress,
            canceled: (latest, error) => terminalProgress(latest, 'canceled', error),
            failed: (latest, error) => terminalProgress(latest, 'failed', error),
        },
    });
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
    const jobs = createScanCleanupJobRegistry();
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
            const partial = request.sourcePageNumbers !== undefined;
            const outputPdfPath = await createScanCleanupGeneratedOutputPath(request.sourcePdfPath, partial);
            const workerRequest = {
                ...request,
                outputPdfPath,
            };
            const progress: TScanCleanupProgress = {
                stage: 'queued' as const,
                completedUnits: 0,
                totalUnits: 0,
                percent: 0,
                completedPageNumbers: [],
            };
            documentOutputService.start({
                operation: 'scan-cleanup',
                sourceKind: 'pdf',
                jobId,
                initialPhase: 'queued',
            });
            jobs.start({
                jobId,
                owner: ownerActor(sender, request),
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                },
                initialProgress: {
                    jobId,
                    status: 'queued',
                    progress,
                    updatedAtMs: Date.now(),
                },
                ownerLifecycle: {
                    destroyed: 'detach',
                    renderProcessGone: 'detach',
                    mainFrameNavigation: 'detach',
                },
                run: async job => {
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
                            signal: job.signal,
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
                            job.signal,
                            nextProgress => {
                                job.publish({
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
                        documentOutputService.handoff(jobId, outputPdfPath);
                        documentOutputService.finish(jobId, 'completed');
                        const completedPageNumbers = request.sourcePageNumbers
                        ?? Array.from({length: summary.inputPages}, (_, index) => index + 1);
                        return {
                            outputPdfPath,
                            summary,
                            partial,
                            completedPageNumbers,
                        };
                    } catch (error) {
                        const aborted = job.signal.aborted;
                        await rm(dirname(outputPdfPath), {
                            recursive: true,
                            force: true,
                        }).catch(() => undefined);
                        documentOutputService.finish(
                            jobId,
                            aborted ? 'canceled' : 'failed',
                            aborted ? undefined : getErrorMessage(error),
                        );
                        throw error;
                    } finally {
                        lease?.release();
                    }
                },
            });
            jobs.subscribe(jobId, ownerActor(sender, request), state => {
                sendScanCleanupState(sender, state.progress);
            });
            return {
                started: true,
                jobId,
                outputPdfPath,
            };
        },
        cancel(sender, jobId, owner) {
            const actor = ownerActor(sender, owner);
            const state = publicState(jobs.get(jobId, actor));
            if (!state) {
                return false;
            }
            if ([
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return true;
            }
            return jobs.cancel(jobId, actor, 'Scan cleanup canceled');
        },
        getState(sender, jobId, owner) {
            return publicState(jobs.get(jobId, ownerActor(sender, owner)));
        },
        subscribe(sender, jobId, owner) {
            const actor = ownerActor(sender, owner);
            const unsubscribe = jobs.subscribe(jobId, actor, state => {
                sendScanCleanupState(sender, state.progress);
            });
            const state = publicState(jobs.get(jobId, actor));
            if (!unsubscribe || !state) {
                return null;
            }
            return state;
        },
        pruneGeneratedOutputs(openPdfPaths) {
            return pruneScanCleanupGeneratedOutputs({openPdfPaths});
        },
    };
}
