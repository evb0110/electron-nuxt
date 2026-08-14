import { randomUUID } from 'crypto';
import {rm} from 'fs/promises';
import {
    dirname,
    isAbsolute,
    normalize,
    resolve,
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
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import {
    createStableJobBrokerOwnerId,
    type IJobResourceVector,
    mainJobBroker,
} from '@electron/resources/jobBroker';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { resolveNativePdfImageCombinePath } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import {
    SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE,
    ScanCleanupPageScopeError,
} from '@scan-cleanup-core/pageScope';
import { SCAN_CLEANUP_PLATFORM_FEATURE } from '@contracts/scanCleanupPlatformFeature';
import { runScanCleanupWorkerTask } from '@electron/features/scan-cleanup/runScanCleanupWorkerTask';
import {
    createScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {
    allowOpenPath,
    MAX_ALLOWED_OPEN_PATHS,
    OPEN_PATH_CAPABILITY_TTL_MS,
} from '@electron/file-access/openPathCapabilities';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobRegistry,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    getWorkingCopyBackingEntry,
    isWorkingCopyOriginalPathRegistered,
} from '@electron/file-access/workingCopyStore';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {ScanCleanupNativeToolUnavailableError} from '@scan-cleanup-core/errors';

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
        registerScanCleanupOutputAccess(outputPdfPath, subscriber);
    }
}

interface IScanCleanupOutputAccessRegistration {
    handleDestroyed: () => void;
    handleNavigation: (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    handleRenderProcessGone: () => void;
    paths: Map<string, number>;
    sender: WebContents;
}

const outputAccessRegistrations = new Map<number, IScanCleanupOutputAccessRegistration>();

function normalizedOutputAccessPath(outputPath: string) {
    const normalized = normalize(resolve(outputPath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function removeOutputAccessRegistration(senderId: number, expected?: IScanCleanupOutputAccessRegistration) {
    const registration = outputAccessRegistrations.get(senderId);
    if (!registration || (expected && registration !== expected)) {
        return;
    }
    registration.sender.removeListener('destroyed', registration.handleDestroyed);
    registration.sender.removeListener('render-process-gone', registration.handleRenderProcessGone);
    registration.sender.removeListener('did-start-navigation', registration.handleNavigation);
    outputAccessRegistrations.delete(senderId);
}

function createOutputAccessRegistration(sender: WebContents) {
    const registration: IScanCleanupOutputAccessRegistration = {
        handleDestroyed: () => removeOutputAccessRegistration(sender.id, registration),
        handleRenderProcessGone: () => removeOutputAccessRegistration(sender.id, registration),
        handleNavigation: (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) {
                removeOutputAccessRegistration(sender.id, registration);
            }
        },
        paths: new Map(),
        sender,
    };
    outputAccessRegistrations.set(sender.id, registration);
    sender.once('destroyed', registration.handleDestroyed);
    sender.once('render-process-gone', registration.handleRenderProcessGone);
    sender.on('did-start-navigation', registration.handleNavigation);
    return registration;
}

function registerScanCleanupOutputAccess(outputPath: string, sender: WebContents) {
    if (sender.isDestroyed()) {
        removeOutputAccessRegistration(sender.id);
        return;
    }
    let registration = outputAccessRegistrations.get(sender.id);
    if (registration?.sender !== sender) {
        removeOutputAccessRegistration(sender.id, registration);
        registration = undefined;
    }
    registration ??= createOutputAccessRegistration(sender);
    const now = Date.now();
    for (const [
        path,
        expiresAtMs,
    ] of registration.paths) {
        if (expiresAtMs <= now) {
            registration.paths.delete(path);
        }
    }
    const normalizedPath = normalizedOutputAccessPath(outputPath);
    if (registration.paths.has(normalizedPath)) {
        return;
    }
    if (allowOpenPath(outputPath, sender)) {
        registration.paths.set(normalizedPath, now + OPEN_PATH_CAPABILITY_TTL_MS);
        while (registration.paths.size > MAX_ALLOWED_OPEN_PATHS) {
            const oldestPath = registration.paths.keys().next().value;
            if (oldestPath === undefined) {
                break;
            }
            registration.paths.delete(oldestPath);
        }
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

function omitStageMetadata(progress: TScanCleanupProgress): TScanCleanupProgress {
    const {
        stageIndex: _stageIndex,
        stageCount: _stageCount,
        ...rest
    } = progress;
    return rest;
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
            ...omitStageMetadata(latest.progress),
            stage: 'handoff',
            completedUnits: result.summary.inputPages,
            totalUnits: result.summary.inputPages,
            percent: 100,
            ...(latest.progress.stageCount === undefined ? {} : {
                stageIndex: latest.progress.stageCount,
                stageCount: latest.progress.stageCount,
            }),
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
    if (error instanceof ScanCleanupNativeToolUnavailableError) {
        return error.code;
    }
    const errorCode = error && typeof error === 'object' && 'code' in error
        ? (error as {code?: unknown}).code
        : undefined;
    if (error instanceof ScanCleanupPageScopeError || errorCode === SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE) {
        return 'invalid-request';
    }
    if (hasNativeErrorCode(error)) {
        return error.code;
    }
    if (errorCode === 'ENOENT') {
        return 'tools-unavailable';
    }
    if (errorCode === 'SCAN_CLEANUP_INVALID_PAGE_SCOPE') {
        return 'invalid-request';
    }
    return 'internal';
}

export async function materializeScanCleanupSourcePath(
    sourcePdfPath: string,
    senderWebContentsId: number,
    signal?: AbortSignal,
) {
    if (!getWorkingCopyBackingEntry(sourcePdfPath, senderWebContentsId)) {
        throw new Error('Scan cleanup source is not a managed working copy');
    }
    const materialized = await ensureWorkingCopyMaterialized(sourcePdfPath, {
        ownerWebContentsId: senderWebContentsId,
        reason: 'scan-cleanup',
        ...(signal ? {signal} : {}),
    });
    return materialized.physicalWorkingCopyPath;
}

export interface IScanCleanupService {
    start: (sender: WebContents, request: IScanCleanupStartRequest) => Promise<TScanCleanupStartResult>;
    cancel: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getState: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    subscribe: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    pruneGeneratedOutputs: () => Promise<number>;
}

export const SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES = 128 * 1024 * 1024;
const SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE = 1;

export interface IScanCleanupRasterAdmissionPolicy {
    rasterConcurrency: number;
    rasterStreaming: boolean;
}

export function resolveScanCleanupRasterAdmissionPolicy(
    capacity: IJobResourceVector = mainJobBroker.getSnapshot().capacity,
    supportsRasterStreaming = process.platform !== 'win32',
): IScanCleanupRasterAdmissionPolicy {
    // Streaming overlaps the classifier with the raster producers. Reserve one
    // native slot for that sidecar and one for unrelated bulk work. Hosts with
    // only two native slots use the sequential handoff instead.
    const rasterStreaming = supportsRasterStreaming && capacity.nativeProcesses >= 3;
    const nativeProcessReserve = SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE
        + Number(rasterStreaming);
    const rasterConcurrency = Math.max(
        1,
        Math.min(
            Math.floor(capacity.cpuTokens),
            capacity.nativeProcesses - nativeProcessReserve,
            Math.floor(capacity.estimatedResidentBytes / SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES),
        ),
    );
    return {
        rasterConcurrency,
        rasterStreaming,
    };
}

function resolveScanCleanupRuntimePolicy(
    profile: IHostResourceProfileSnapshot,
): IScanCleanupRuntimePolicy {
    const rasterPolicy = resolveScanCleanupRasterAdmissionPolicy();
    return {
        ...rasterPolicy,
        logicalCpus: profile.logicalCpus,
        totalRamBytes: profile.totalRamBytes,
    };
}

export function createScanCleanupService(): IScanCleanupService {
    const jobs = createScanCleanupJobRegistry();
    const activeJobsByBrokerOwner = new Map<string, {
        jobId: string;
        outputPdfPath: string;
        request: IScanCleanupStartRequest;
        signature: string;
    }>();
    const startReservationsByBrokerOwner = new Map<string, Promise<void>>();
    return {
        async start(sender, request) {
            const jobId = `scan-cleanup-${randomUUID()}`;
            const brokerOwnerId = createStableJobBrokerOwnerId(
                'scan-cleanup',
                sender.id,
                request.ownerId,
            );
            if (!isAbsolute(request.sourcePdfPath)) {
                return {
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                };
            }
            const signature = JSON.stringify(request);
            const pendingStart = startReservationsByBrokerOwner.get(brokerOwnerId);
            if (pendingStart) {
                await pendingStart;
                return this.start(sender, request);
            }
            let releaseStartReservation!: () => void;
            const reservation = new Promise<void>(resolve => {
                releaseStartReservation = resolve;
            });
            startReservationsByBrokerOwner.set(brokerOwnerId, reservation);
            const releaseReservation = () => {
                releaseStartReservation();
                if (startReservationsByBrokerOwner.get(brokerOwnerId) === reservation) {
                    startReservationsByBrokerOwner.delete(brokerOwnerId);
                }
            };
            try {
                const previous = activeJobsByBrokerOwner.get(brokerOwnerId);
                if (previous) {
                    const previousState = publicState(jobs.get(
                        previous.jobId,
                        ownerActor(sender, previous.request),
                    ));
                    if (previousState && ![
                        'completed',
                        'failed',
                        'canceled',
                    ].includes(previousState.status)) {
                        if (previous.signature === signature) {
                            return {
                                started: true,
                                jobId: previous.jobId,
                                outputPdfPath: previous.outputPdfPath,
                            };
                        }
                        jobs.cancel(
                            previous.jobId,
                            ownerActor(sender, previous.request),
                            'Superseded scan cleanup request',
                        );
                    }
                }
                const partial = request.sourcePageNumbers !== undefined;
                const outputPdfPath = await createScanCleanupGeneratedOutputPath(request.sourcePdfPath, partial);
                const workerRequest = {
                    ...request,
                    outputPdfPath,
                };
                const runtimePolicy = resolveScanCleanupRuntimePolicy(
                    getHostResourceProfileSnapshot(),
                );
                const progress: TScanCleanupProgress = {
                    stage: 'queued' as const,
                    completedUnits: 0,
                    totalUnits: 0,
                    percent: 0,
                    completedPageNumbers: [],
                };
                const handle = jobs.start({
                    jobId,
                    owner: ownerActor(sender, request),
                    operation: {
                        // The worker may have atomically published its generated
                        // PDF immediately before its result reaches main. Main is
                        // the terminal-state authority: cancellation that arrived
                        // first removes that publication, while a result handled
                        // first enters a non-cancelable commit state.
                        kind: 'critical-write',
                        workingCopyPath: request.sourcePdfPath,
                    },
                    initialProgress: {
                        jobId,
                        status: 'queued',
                        progress,
                        updatedAtMs: Date.now(),
                    },
                    ownerLifecycle: {
                        // A destroyed or crashed renderer can never present this
                        // job again: authorization is bound to the original
                        // WebContents and a replacement renderer cannot adopt it,
                        // so the work would run to completion for nobody. Only a
                        // same-WebContents navigation can reconnect (getJobState/
                        // reconnectJob), so only it detaches.
                        destroyed: 'cancel',
                        renderProcessGone: 'cancel',
                        mainFrameNavigation: 'detach',
                    },
                    run: async job => {
                        let lease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
                        try {
                            lease = await mainJobBroker.acquire({
                                ownerId: brokerOwnerId,
                                kind: 'scan-cleanup',
                                priority: 'user',
                                resources: {
                                    cpuTokens: runtimePolicy.rasterConcurrency,
                                    estimatedResidentBytes: runtimePolicy.rasterConcurrency * SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                                    nativeProcesses: runtimePolicy.rasterConcurrency
                                        + Number(runtimePolicy.rasterStreaming),
                                    ioWeight: 4,
                                },
                                perOwnerLimit: 1,
                                signal: job.signal,
                            });
                            const pdfPaths = getPdfNativeToolPaths();
                            const scanCleanupBinary = resolveScanCleanupPath();
                            const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
                            // Page geometry is what matched page size is measured
                            // from, so the raster path asks for this tool too — and
                            // takes Poppler's answer when it is missing, rather than
                            // dropping matching without telling anyone. Only the
                            // lossless assembler needs the tool itself.
                            // Auto can retain an existing compact MRC/JPX page when
                            // its resolved Color result only needs page geometry.
                            // Page-ops applies that geometry without decoding or
                            // recompressing the source image objects.
                            const requiresPageOps = request.options.preserveOriginalQuality === true
                                || request.options.matchPageSize
                                || request.options.outputMode === 'auto';
                            const pdfPageOpsBinary = requiresPageOps && !isNativePageOpsDisabled()
                                ? resolveNativePageOpsPath()
                                : null;
                            const missingTools = [
                                scanCleanupBinary ? null : 'evb-scan-cleanup',
                                pdfImageCombineBinary ? null : 'evb-pdf-image-combine',
                                request.options.preserveOriginalQuality === true && !pdfPageOpsBinary
                                    ? 'evb-pdf-page-ops'
                                    : null,
                            ].filter((name): name is string => name !== null);
                            if (missingTools.length > 0 || !scanCleanupBinary || !pdfImageCombineBinary) {
                                throw new ScanCleanupNativeToolUnavailableError(
                                    missingTools[0] ?? 'unknown scan-cleanup native tool',
                                );
                            }
                            const summary = await runScanCleanupWorkerTask(
                                {
                                    ...workerRequest,
                                    sourcePdfPath: await materializeScanCleanupSourcePath(
                                        request.sourcePdfPath,
                                        sender.id,
                                        job.signal,
                                    ),
                                },
                                {
                                    qpdfBinary: pdfPaths.qpdf,
                                    pdftoppmBinary: pdfPaths.pdftoppm,
                                    ...(pdfPaths.pdfimages ? {pdfimagesBinary: pdfPaths.pdfimages} : {}),
                                    pdfinfoBinary: pdfPaths.pdfinfo,
                                    scanCleanupBinary,
                                    pdfImageCombineBinary,
                                    ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                                    tempDir: getAppTempDir(),
                                },
                                runtimePolicy,
                                job.signal,
                                nextProgress => {
                                    job.publish({
                                        jobId,
                                        status: nextProgress.stage === 'handoff' ? 'handoff' : 'running',
                                        progress: nextProgress,
                                        updatedAtMs: Date.now(),
                                    });
                                },
                            );
                            // Resolve the cancel-vs-publish race in the same main
                            // process that owns the job state. If cancel won while
                            // the worker was publishing, the catch path removes the
                            // generated-output directory. Otherwise later cancel
                            // requests are rejected as soon as commit begins.
                            job.signal.throwIfAborted();
                            job.markCommitStarted();
                            const completedPageNumbers = request.sourcePageNumbers
                                ?? Array.from({length: summary.inputPages}, (_, index) => index + 1);
                            return {
                                outputPdfPath,
                                summary,
                                partial,
                                completedPageNumbers,
                            };
                        } catch (error) {
                            await rm(dirname(outputPdfPath), {
                                recursive: true,
                                force: true,
                            }).catch(() => undefined);
                            throw error;
                        } finally {
                            lease?.release();
                        }
                    },
                });
                const activeEntry = {
                    jobId,
                    outputPdfPath,
                    request,
                    signature,
                };
                activeJobsByBrokerOwner.set(brokerOwnerId, activeEntry);
                void handle.settled.finally(() => {
                    if (activeJobsByBrokerOwner.get(brokerOwnerId) === activeEntry) {
                        activeJobsByBrokerOwner.delete(brokerOwnerId);
                    }
                }).catch(() => undefined);
                return {
                    started: true,
                    jobId,
                    outputPdfPath,
                };
            } finally {
                releaseReservation();
            }
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
        pruneGeneratedOutputs() {
            return pruneScanCleanupGeneratedOutputs({isOutputLive: isWorkingCopyOriginalPathRegistered});
        },
    };
}
