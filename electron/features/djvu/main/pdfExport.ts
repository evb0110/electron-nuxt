import {
    app,
    BrowserWindow,
    type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'worker_threads';
import { uniq } from 'es-toolkit/array';
import {
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    statfs,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
    parse,
} from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';
import type {
    IDjvuConvertOptions,
    IDjvuConvertResult,
    IDjvuOpenResult,
    IDjvuPrintOptions,
    IDjvuPrintResult,
    IDjvuProgress,
    TDocumentOutputJobState,
    TDocumentOutputOperation,
} from '@contracts/electronApiDjvu';
import type {TDocumentRef} from '@contracts/documentRef';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import {
    cancelConversion,
    convertDjvuToPdfFile,
} from '@electron/features/djvu/main/ddjvuConversion';
import { buildCompactDjvuAwarePdfFromDjvu } from '@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu';
import {
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/parseDjvuOutline';
import {
    evaluateDjvuPdfConversionPolicy,
    resolveDjvuCompactFidelityPreset,
    resolveDjvuPdfExportStrategy,
    type IDjvuConversionPageMetrics,
    type IDjvuPdfConversionPolicyDecision,
    type TDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import { safeSendToWindow } from '@electron/djvu/safeSendToWindow';
import { embedBookmarksIntoPdfFile } from '@electron/djvu/embedBookmarksIntoPdfFile';
import { consumeAllowedDjvuWritePath } from '@electron/djvu/exportPaths';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError,
} from '@electron/features/djvu/main/pdfWorkerClient';
import { getErrorMessage } from '@electron/utils/error';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';
import { optimizeGeneratedPdfForInteraction } from '@electron/features/documents/public/pdfSaveAsOptimization';
import {
    assertPdfPathWithinSizeLimit,
    PRINT_DJVU_TEMP_PREFIX,
    printManagedTempPdfPath,
} from '@electron/utils/printHandoff';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getDjvuPageSizesForViewing } from '@electron/features/djvu/main/pagePreview';
import {
    buildPrintablePdfData,
    canPrintSourcePdfDirectly,
    normalizePrintPageNumbers,
} from '@pdf-core';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobRunContext,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import { mainJobBroker } from '@electron/resources/jobBroker';
import {adoptDjvuViewingPath} from '@electron/features/djvu/main/viewing';

const logger = createLogger('djvu-pdfExport');
interface IDjvuOperationContext extends IPlatformMainSenderContext<WebContents> {}
const activePdfWorkerByJobId = new Map<string, Worker>();
const activeNativeJobCancels = new Map<string, (reason: string) => boolean>();
const DJVU_TERMINAL_RECORD_RETENTION_MS = 60 * 60 * 1_000;
const DJVU_MAX_TERMINAL_RECORDS = 64;
const djvuProgressReplay = DJVU_PLATFORM_FEATURE.events.onProgress.subscription.replay;
const DJVU_SUBSAMPLE_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_SUBSAMPLE_MAX ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16;
    }
    return Math.min(parsed, 64);
})();
const DJVU_BOOKMARK_FALLBACK_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_BOOKMARK_FALLBACK_MAX_MB ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 64 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const DJVU_CONVERT_PROGRESS_CAP = 94;
const DJVU_BOOKMARK_PROGRESS_PERCENT = 95;
const DJVU_OPTIMIZE_PROGRESS_PERCENT = 98;

function scaleDjvuConversionProgress(percent: number) {
    if (!Number.isFinite(percent)) {
        return 0;
    }
    return Math.max(0, Math.min(
        DJVU_CONVERT_PROGRESS_CAP,
        Math.round((percent / 100) * DJVU_CONVERT_PROGRESS_CAP),
    ));
}

function resolveSubsample(rawSubsample: number | undefined) {
    if (rawSubsample === undefined) {
        return 1;
    }
    if (!Number.isFinite(rawSubsample)) {
        throw new Error('Invalid DjVu subsample value');
    }
    const subsample = Math.floor(rawSubsample);
    if (subsample < 1 || subsample > DJVU_SUBSAMPLE_MAX) {
        throw new Error(`Invalid DjVu subsample value (expected 1-${DJVU_SUBSAMPLE_MAX})`);
    }
    return subsample;
}

function throwIfCanceled(signal: AbortSignal) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
}

async function runDjvuConversionJobWithSlot<T>(
    jobId: string,
    signal: AbortSignal,
    run: () => Promise<T>,
): Promise<T> {
    throwIfCanceled(signal);
    const lease = await mainJobBroker.acquire({
        ownerId: jobId,
        kind: 'djvu-output',
        priority: 'user',
        perOwnerLimit: 1,
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal,
    });
    try {
        throwIfCanceled(signal);
        return await run();
    } finally {
        lease.release();
    }
}

async function requestDjvuNativeCancel(jobId: string) {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return;
    }

    mainJobBroker.cancelOwner(normalizedJobId, 'DjVu conversion canceled');
    await cancelConversion(normalizedJobId);
}

function setActivePdfWorker(jobId: string, worker: Worker) {
    activePdfWorkerByJobId.set(jobId, worker);
}

function clearActivePdfWorker(jobId: string, worker: Worker) {
    if (activePdfWorkerByJobId.get(jobId) === worker) {
        activePdfWorkerByJobId.delete(jobId);
    }
}

function formatEffectivePixels(pixels: number) {
    if (pixels >= 1_000_000_000) {
        return `${(pixels / 1_000_000_000).toFixed(1)}B`;
    }
    if (pixels >= 1_000_000) {
        return `${Math.round(pixels / 1_000_000)}M`;
    }
    return String(Math.max(0, Math.round(pixels)));
}

function describeRecommendedSubsample(subsample: number) {
    if (subsample <= 1) {
        return 'Full Quality';
    }
    if (subsample === 2) {
        return 'Good Quality';
    }
    if (subsample === 4) {
        return 'Compact';
    }
    return `subsample ${subsample}`;
}

function createDjvuConversionPolicyError(decision: IDjvuPdfConversionPolicyDecision) {
    return `Selected DjVu PDF quality is blocked because direct conversion would preserve about ${
        formatEffectivePixels(decision.effectivePixels)
    } effective pixels. Choose ${describeRecommendedSubsample(decision.recommendedSubsample)} or higher.`;
}

function resolveDjvuPrintPdfExportStrategy(strategy: TDjvuPdfExportStrategy | undefined) {
    return strategy === 'direct' ? 'direct' : 'compact-djvu-aware';
}

function resolveDjvuPrintJobId(requestId: unknown) {
    return `djvu-print-${normalizeOptionalIpcRequestId(requestId) ?? randomUUID()}`;
}

function resolveDjvuPrintPages(pageNumbers: number[] | undefined, pageCount: number) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return undefined;
    }
    return normalizePrintPageNumbers(pageNumbers, pageCount);
}

function formatDjvuPageSelection(pages: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previousPage: number | null = null;

    for (const page of pages) {
        if (rangeStart === null || previousPage === null) {
            rangeStart = page;
            previousPage = page;
            continue;
        }

        if (page === previousPage + 1) {
            previousPage = page;
            continue;
        }

        ranges.push(rangeStart === previousPage ? String(rangeStart) : `${rangeStart}-${previousPage}`);
        rangeStart = page;
        previousPage = page;
    }

    if (rangeStart !== null && previousPage !== null) {
        ranges.push(rangeStart === previousPage ? String(rangeStart) : `${rangeStart}-${previousPage}`);
    }

    return ranges.join(',');
}

function resolveDjvuPrintDocumentTitle(
    djvuPath: string,
    fileName: string | undefined,
    selectedPages: number[] | undefined,
) {
    const rawName = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim()
        : djvuPath;
    const baseName = basename(rawName) || 'document';
    const title = parse(baseName).name || baseName || 'document';
    if (!selectedPages || selectedPages.length === 0) {
        return title;
    }

    return `${title} p${formatDjvuPageSelection(selectedPages)}`;
}

async function getDjvuConversionPageSizes(
    jobId: string,
    djvuPath: string,
    pageCount: number,
    signal: AbortSignal,
) {
    try {
        const pageSizes: IDjvuConversionPageMetrics[] = await getDjvuPageSizesForViewing(djvuPath, pageCount, { signal });
        return pageSizes;
    } catch (error) {
        if (signal.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : createAbortError('DjVu conversion canceled');
        }
        logger.debug(`[${jobId}] Failed to read DjVu page sizes before conversion policy check: ${getErrorMessage(error)}`);
        return null;
    }
}

async function assertDjvuExportDiskSpace(sourcePath: string, targetPath: string) {
    const [
        source,
        fileSystem,
    ] = await Promise.all([
        stat(sourcePath),
        statfs(dirname(targetPath)),
    ]);
    const availableBytes = fileSystem.bavail * fileSystem.bsize;
    const requiredBytes = Math.max(128 * 1024 * 1024, source.size * 4);
    if (availableBytes < requiredBytes) {
        throw new Error(
            `Not enough disk space for DjVu export: ${requiredBytes} bytes required, ${availableBytes} available`,
        );
    }
}

async function copyFileCancellable(sourcePath: string, targetPath: string, signal: AbortSignal) {
    const source = await open(sourcePath, 'r');
    const target = await open(targetPath, 'wx');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    try {
        while (true) {
            if (signal.aborted) throw abortErrorFromSignal(signal);
            const {bytesRead} = await source.read(buffer, 0, buffer.byteLength, position);
            if (bytesRead === 0) break;
            await target.write(buffer, 0, bytesRead, position);
            position += bytesRead;
        }
        await syncFileHandleForDurability(target);
    } finally {
        await Promise.allSettled([
            source.close(),
            target.close(),
        ]);
    }
}

async function replaceFileAtomically(sourcePath: string, targetPath: string, signal: AbortSignal) {
    const stagedPath = makeSiblingTempPath(targetPath);
    let replaced = false;
    try {
        await copyFileCancellable(sourcePath, stagedPath, signal);
        if (signal.aborted) throw abortErrorFromSignal(signal);
        await atomicReplace(stagedPath, targetPath);
        replaced = true;
    } finally {
        if (!replaced) {
            await rm(stagedPath, { force: true }).catch(() => undefined);
        }
    }
}

type TDjvuProgressScope = Pick<IDjvuProgress, 'documentRef' | 'requestId'>;
type TDjvuPublicJobResult = IDjvuConvertResult | IDjvuOpenResult | IDjvuPrintResult;
type TDjvuJobError = IMainJobErrorEnvelope<'canceled' | 'failed' | 'duplicate-job-id' | 'not-found-or-unauthorized'>;
type TDjvuJobSnapshot = TMainJobSnapshot<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>;
type TDjvuRegistryContext = IMainJobRunContext<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>;
interface IDjvuJobRunContext {
    signal: AbortSignal;
    publish: TDjvuRegistryContext['publish'];
    handoff: (artifactPath: TDocumentRef, progress?: IDjvuProgress) => void;
}

function isDjvuCancellationError(error: unknown) {
    return getErrorMessage(error).toLowerCase().includes('djvu conversion canceled');
}

function getOptionalResultError(value: unknown) {
    if (typeof value !== 'object' || value === null || !('error' in value)) {
        return undefined;
    }
    const errorValue = (value as { error?: unknown }).error;
    return typeof errorValue === 'string' ? errorValue : undefined;
}

function createDjvuProgressScope(requestId: unknown, documentRef: unknown): TDjvuProgressScope {
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId);
    return {
        ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
        ...(typeof documentRef === 'string' && documentRef.trim().length > 0
            ? { documentRef: documentRef.trim() }
            : {}),
    };
}

function getDjvuOperation(jobId: string): TDocumentOutputOperation {
    if (jobId.startsWith('djvu-print-')) {
        return 'djvu-print';
    }
    if (jobId.startsWith('djvu-open-')) {
        return 'djvu-open';
    }
    return 'djvu-convert';
}

const djvuJobs = createMainJobRegistry<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>({
    retention: {
        eventReplayTtlMs: djvuProgressReplay.terminalRetentionMs,
        terminalRecordTtlMs: DJVU_TERMINAL_RECORD_RETENTION_MS,
        maxTerminalRecords: DJVU_MAX_TERMINAL_RECORDS,
    },
    progress: {
        channel: DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
        intervalMs: djvuProgressReplay.intervalMs,
        getEventKey: djvuProgressReplay.key,
        send: (sender, _channel, progress) => {
            safeSendToWindow(
                BrowserWindow.fromWebContents(sender),
                DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
                progress,
            );
        },
    },
    toError: (cause, kind) => ({
        code: kind === 'canceled' ? 'canceled' : kind,
        message: cause instanceof Error
            ? cause.message
            : getOptionalResultError(cause) ?? 'DjVu operation failed',
    }),
    terminalProgress: {
        completed: (latest, result) => result.success
            ? {
                ...latest,
                percent: 100,
                status: 'success',
            }
            : {
                ...latest,
                percent: 100,
                status: 'failed',
                error: result.error ?? 'DjVu operation failed',
            },
        canceled: (latest, error) => ({
            ...latest,
            percent: 100,
            status: 'canceled',
            error: error.message,
        }),
        failed: (latest, error) => ({
            ...latest,
            percent: 100,
            status: 'failed',
            error: error.message,
        }),
    },
});

function projectDjvuJob(snapshot: TDjvuJobSnapshot): TDocumentOutputJobState {
    const base = {
        jobId: snapshot.jobId,
        operation: getDjvuOperation(snapshot.jobId),
        progress: snapshot.progress,
        updatedAtMs: snapshot.updatedAtMs,
    };
    const handoffPath = snapshot.status === 'handoff' || snapshot.status === 'completed'
        ? snapshot.handoffResult && 'pdfPath' in snapshot.handoffResult
            ? snapshot.handoffResult.pdfPath
            : undefined
        : undefined;
    if (snapshot.status === 'handoff' && handoffPath) {
        return {
            ...base,
            status: 'handoff',
            artifactPath: handoffPath,
        };
    }
    if (snapshot.progress.status === 'canceled' || snapshot.status === 'canceled') {
        return {
            ...base,
            status: 'canceled',
            ...(snapshot.progress.error ? {error: snapshot.progress.error} : {}),
        };
    }
    if (snapshot.progress.status === 'failed' || snapshot.status === 'failed') {
        return {
            ...base,
            status: 'failed',
            ...(snapshot.progress.error ? {error: snapshot.progress.error} : {}),
        };
    }
    if (snapshot.progress.status === 'success' || snapshot.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            ...(handoffPath ? {artifactPath: handoffPath} : {}),
        };
    }
    return {
        ...base,
        status: snapshot.status === 'queued' ? 'queued' : 'running',
    };
}

function startDjvuJob(
    context: IDjvuOperationContext,
    options: {
        jobId: string;
        workingCopyPath: string;
        initialProgress: IDjvuProgress;
        durable?: boolean;
        nativeCancellation?: boolean;
        run: (job: IDjvuJobRunContext) => Promise<TDjvuPublicJobResult>;
    },
) {
    const handle = djvuJobs.start({
        jobId: options.jobId,
        owner: {sender: context.sender},
        operation: {
            kind: 'abortable-work',
            workingCopyPath: options.workingCopyPath,
        },
        initialProgress: options.initialProgress,
        duplicate: options.durable ? 'join' : 'reject',
        ownerLifecycle: options.durable
            ? {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            }
            : {
                destroyed: 'cancel',
                renderProcessGone: 'cancel',
                mainFrameNavigation: 'cancel',
            },
        ...(options.nativeCancellation ? {onCancel: () => requestDjvuNativeCancel(options.jobId)} : {}),
        run: job => options.run({
            signal: job.signal,
            publish: job.publish,
            handoff: (path, progress) => job.handoff({
                success: true,
                jobId: options.jobId,
                pdfPath: path,
            }, progress),
        }),
    });
    if (options.nativeCancellation) {
        activeNativeJobCancels.set(options.jobId, reason => handle.cancel(reason));
        void handle.settled.finally(() => {
            activeNativeJobCancels.delete(options.jobId);
        });
    }
    return handle;
}

async function awaitDjvuJob(
    context: IDjvuOperationContext,
    jobId: string,
    kind: 'convert' | 'open',
) {
    const normalizedJobId = jobId.trim();
    let terminal;
    try {
        terminal = await djvuJobs.await(normalizedJobId, {sender: context.sender});
    } catch {
        throw new Error(`Unknown or expired DjVu ${kind === 'open' ? 'open' : 'conversion'} job: ${normalizedJobId}`);
    }
    if (terminal.status === 'completed') {
        return terminal.result;
    }
    return {
        success: false,
        jobId: normalizedJobId,
        ...(terminal.progress.requestId ? {requestId: terminal.progress.requestId} : {}),
        ...(terminal.progress.documentRef ? {documentRef: terminal.progress.documentRef} : {}),
        error: terminal.error.message,
    } satisfies TDjvuPublicJobResult;
}

export function subscribeDjvuProgress(context: IDjvuOperationContext) {
    djvuJobs.subscribeOwner({sender: context.sender});
}

export function getDjvuOutputJobState(context: IDjvuOperationContext, jobId: string) {
    const snapshot = djvuJobs.get(jobId.trim(), {sender: context.sender});
    return snapshot ? projectDjvuJob(snapshot) : null;
}

export function subscribeDjvuOutputJob(context: IDjvuOperationContext, jobId: string) {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) {
        return null;
    }
    const unsubscribe = djvuJobs.subscribe(normalizedJobId, {sender: context.sender}, (snapshot) => {
        safeSendToWindow(
            BrowserWindow.fromWebContents(context.sender),
            DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
            snapshot.progress,
        );
    });
    return unsubscribe
        ? getDjvuOutputJobState(context, normalizedJobId)
        : null;
}

async function embedPdfBookmarks(
    jobId: string,
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal: AbortSignal,
) {
    if (bookmarks.length === 0) {
        return;
    }

    return measureElectronPerfAsync('djvu:embed-bookmarks', async () => {
        try {
            const task = createDjvuPdfBookmarkTask(inputPdfPath, outputPdfPath, bookmarks, { signal });
            setActivePdfWorker(jobId, task.worker);
            try {
                await task.promise;
                return;
            } catch (error) {
                if (signal.aborted) throw abortErrorFromSignal(signal);
                throw error;
            } finally {
                clearActivePdfWorker(jobId, task.worker);
            }
        } catch (error) {
            if (!(error instanceof DjvuPdfWorkerStartupError)) {
                throw error;
            }
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : createAbortError('DjVu conversion canceled');
            }

            const inputStats = await stat(inputPdfPath).catch(() => null);
            if (!inputStats || inputStats.size > DJVU_BOOKMARK_FALLBACK_MAX_BYTES) {
                const maxMb = Math.floor(DJVU_BOOKMARK_FALLBACK_MAX_BYTES / (1024 * 1024));
                throw new Error(
                    `DjVu bookmark embedding requires the PDF worker for files larger than ${maxMb}MB`,
                );
            }
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : createAbortError('DjVu conversion canceled');
            }

            logger.warn(`[${jobId}] DjVu PDF worker unavailable, falling back to in-process bookmark embedding: ${error.message}`);
            await embedBookmarksIntoPdfFile(inputPdfPath, outputPdfPath, bookmarks, signal);
        }
    }, {
        thresholdMs: 25,
        details: {
            jobId,
            bookmarkCount: bookmarks.length,
        },
    });
}

async function runDjvuPrintPath(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    options: IDjvuPrintOptions,
    jobId: string,
    progressScope: TDjvuProgressScope,
    job: IDjvuJobRunContext,
): Promise<IDjvuPrintResult> {
    const tempDir = await mkdtemp(join(getAppTempDir(), 'djvu-print-work-'));
    const sourcePdfPath = join(tempDir, `${jobId}.source.pdf`);
    const finalPdfPath = join(getAppTempDir(), `${PRINT_DJVU_TEMP_PREFIX}${jobId}.pdf`);
    let finalPdfHandedToPrint = false;

    logger.info(`[${jobId}] Preparing DjVu for print: ${djvuPath}`);
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        job.publish(scopedProgress);
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        const result = await runDjvuConversionJobWithSlot(jobId, job.signal, async () => {
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath, { signal: job.signal }),
                getDjvuResolution(djvuPath, { signal: job.signal }),
            ]);
            throwIfCanceled(job.signal);

            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount, job.signal);
            throwIfCanceled(job.signal);

            const selectedPages = resolveDjvuPrintPages(options.pageNumbers, pageCount);
            if (selectedPages && selectedPages.length === 0) {
                return {
                    success: false,
                    jobId,
                    error: 'No printable DjVu pages selected',
                };
            }

            const shouldPrintConvertedPdfDirectly = canPrintSourcePdfDirectly({
                viewMode: options.viewMode,
                orientation: options.orientation,
            });
            const convertedPdfPath = shouldPrintConvertedPdfDirectly ? finalPdfPath : sourcePdfPath;
            const strategy = resolveDjvuPrintPdfExportStrategy(options.pdfStrategy);
            const convertResult = strategy === 'compact-djvu-aware'
                ? await buildCompactDjvuAwarePdfFromDjvu({
                    jobId,
                    djvuPath,
                    outputPath: convertedPdfPath,
                    tempDir,
                    pageCount,
                    sourceDpi,
                    pageSizes,
                    qualityPreset: resolveDjvuCompactFidelityPreset(options.subsample),
                    signal: job.signal,
                    ...(selectedPages ? { pages: selectedPages } : {}),
                    onProgress: (percent: number) => {
                        sendProgress({
                            jobId,
                            phase: 'converting' as const,
                            percent,
                        });
                    },
                })
                : await (async () => {
                    const subsample = resolveSubsample(options.subsample);
                    const policy = evaluateDjvuPdfConversionPolicy({
                        pageCount,
                        sourceDpi,
                        pageSizes,
                    }, subsample);
                    if (!policy.isAllowed) {
                        return {
                            success: false as const,
                            outputPath: convertedPdfPath,
                            fileSize: 0,
                            error: createDjvuConversionPolicyError(policy),
                        };
                    }

                    return convertDjvuToPdfFile(djvuPath, convertedPdfPath, jobId, {
                        ...(subsample > 1 ? { subsample } : {}),
                        ...(selectedPages ? { pages: formatDjvuPageSelection(selectedPages) } : {}),
                        pageCount,
                        signal: job.signal,
                        onProgress: (percent: number) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent: scaleDjvuConversionProgress(percent),
                            });
                        },
                    });
                })();

            if (!convertResult.success) {
                return {
                    success: false,
                    jobId,
                    error: convertResult.error ?? 'DjVu print preparation failed',
                };
            }
            throwIfCanceled(job.signal);

            let printablePdfPath = convertedPdfPath;
            if (!shouldPrintConvertedPdfDirectly) {
                await assertPdfPathWithinSizeLimit(convertedPdfPath);
                const sourceData = await readFile(convertedPdfPath);
                const printableData = await buildPrintablePdfData(
                    new Uint8Array(sourceData),
                    {
                        viewMode: options.viewMode,
                        orientation: options.orientation,
                    },
                );
                throwIfCanceled(job.signal);
                if (!printableData) {
                    return {
                        success: false,
                        jobId,
                        error: 'Failed to prepare printable DjVu PDF data',
                    };
                }
                await writeFile(finalPdfPath, printableData);
                printablePdfPath = finalPdfPath;
            }

            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(printablePdfPath, { signal: job.signal });
            throwIfCanceled(job.signal);
            sendProgress({
                jobId,
                phase: 'printing' as const,
                percent: 100,
            });
            const printResult = await printManagedTempPdfPath(
                {window: BrowserWindow.fromWebContents(context.sender)},
                printablePdfPath,
                resolveDjvuPrintDocumentTitle(djvuPath, options.fileName, selectedPages),
                {
                    signal: job.signal,
                    surface: 'rasterized-html',
                },
            );
            if (job.signal.aborted) {
                return {
                    success: false,
                    canceled: true,
                    jobId,
                    error: 'DjVu print preparation canceled',
                };
            }
            finalPdfHandedToPrint = printResult.success && printablePdfPath === finalPdfPath;
            logger.info(`[${jobId}] DjVu print handoff complete: success=${printResult.success} canceled=${printResult.canceled === true}`);
            if (printResult.success) {
                job.handoff(printablePdfPath, {
                    jobId,
                    ...progressScope,
                    phase: 'printing',
                    percent: 100,
                    status: 'running',
                });
            }
            return {
                ...printResult,
                jobId,
            };
        });
        if (!result.success) {
            const canceled = result.canceled === true
                || job.signal.aborted
                || isDjvuCancellationError(result.error);
            if (canceled) {
                throw job.signal.reason ?? createAbortError('DjVu print preparation canceled');
            }
        }
        return result;
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        const canceled = job.signal.aborted
            || isDjvuCancellationError(error)
            || errorMessage.includes('DjVu conversion canceled')
            || errorMessage.includes('Print handoff canceled');
        if (canceled) {
            logger.info(`[${jobId}] DjVu print preparation canceled`);
        } else {
            logger.error(`[${jobId}] DjVu print preparation failed: ${errorMessage}`);
        }
        const result = {
            success: false,
            ...(canceled ? { canceled: true } : {}),
            jobId,
            error: canceled ? 'DjVu print preparation canceled' : errorMessage,
        };
        return result;
    } finally {
        activePdfWorkerByJobId.delete(jobId);
        await rm(tempDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        if (!finalPdfHandedToPrint) {
            await rm(finalPdfPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function handleDjvuPrintPath(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    options: IDjvuPrintOptions,
): Promise<IDjvuPrintResult> {
    const progressScope = createDjvuProgressScope(options.requestId, djvuPath);
    const jobId = resolveDjvuPrintJobId(progressScope.requestId);
    const handle = startDjvuJob(context, {
        jobId,
        workingCopyPath: djvuPath,
        initialProgress: {
            jobId,
            ...progressScope,
            phase: 'converting',
            percent: 0,
        },
        nativeCancellation: true,
        run: job => runDjvuPrintPath(context, djvuPath, options, jobId, progressScope, job),
    });
    const terminal = await handle.terminal;
    await handle.settled;
    return terminal.status === 'completed'
        ? terminal.result
        : {
            success: false,
            canceled: terminal.status === 'canceled',
            jobId,
            error: terminal.status === 'canceled'
                ? 'DjVu print preparation canceled'
                : terminal.error.message,
        };
}

async function runDjvuConvertToPdf(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    normalizedOutputPath: string,
    options: IDjvuConvertOptions,
    conversionId: string,
    jobId: string,
    progressScope: TDjvuProgressScope,
    job: IDjvuJobRunContext,
): Promise<IDjvuConvertResult> {
    const tempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-export-'));
    const tempPdfPath = join(tempDir, `${conversionId}.convert.pdf`);
    const tempBookmarkedPdfPath = join(tempDir, `${conversionId}.bookmarks.pdf`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        job.publish(scopedProgress);
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        await assertDjvuExportDiskSpace(djvuPath, normalizedOutputPath);
        const result = await runDjvuConversionJobWithSlot(jobId, job.signal, async () => {
            const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath, { signal: job.signal }),
                getDjvuResolution(djvuPath, { signal: job.signal }),
            ]);

            throwIfCanceled(job.signal);
            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount, job.signal);
            throwIfCanceled(job.signal);

            const convertResult = strategy === 'compact-djvu-aware'
                ? await buildCompactDjvuAwarePdfFromDjvu({
                    jobId,
                    djvuPath,
                    outputPath: tempPdfPath,
                    tempDir,
                    pageCount,
                    sourceDpi,
                    pageSizes,
                    qualityPreset: resolveDjvuCompactFidelityPreset(options.subsample),
                    signal: job.signal,
                    onProgress: (percent) => {
                        sendProgress({
                            jobId,
                            phase: 'converting' as const,
                            percent,
                        });
                    },
                })
                : await (async () => {
                    const subsample = resolveSubsample(options.subsample);
                    const policy = evaluateDjvuPdfConversionPolicy({
                        pageCount,
                        sourceDpi,
                        pageSizes,
                    }, subsample);
                    if (!policy.isAllowed) {
                        return {
                            success: false as const,
                            outputPath: tempPdfPath,
                            fileSize: 0,
                            error: createDjvuConversionPolicyError(policy),
                        };
                    }

                    return convertDjvuToPdfFile(djvuPath, tempPdfPath, jobId, {
                        ...(subsample > 1 ? { subsample } : {}),
                        pageCount,
                        signal: job.signal,
                        onProgress: (percent) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent: scaleDjvuConversionProgress(percent),
                            });
                        },
                    });
                })();

            if (!convertResult.success) {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: convertResult.error ?? 'DjVu conversion failed',
                };
            }
            throwIfCanceled(job.signal);

            const bookmarks = options.preserveBookmarks !== false
                ? await getDjvuOutline(djvuPath, { signal: job.signal })
                    .then(sexp => parseDjvuOutline(sexp))
                    .catch(() => [] as IPdfBookmarkEntry[])
                : [];
            if (bookmarks.length > 0) {
                throwIfCanceled(job.signal);
                sendProgress({
                    jobId,
                    phase: 'bookmarks' as const,
                    percent: DJVU_BOOKMARK_PROGRESS_PERCENT,
                });
                await embedPdfBookmarks(
                    jobId,
                    tempPdfPath,
                    tempBookmarkedPdfPath,
                    bookmarks,
                    job.signal,
                );
            }

            throwIfCanceled(job.signal);
            const finalTempPdfPath = bookmarks.length > 0 ? tempBookmarkedPdfPath : tempPdfPath;
            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(finalTempPdfPath, { signal: job.signal });
            throwIfCanceled(job.signal);
            await replaceFileAtomically(finalTempPdfPath, normalizedOutputPath, job.signal);

            job.handoff(normalizedOutputPath, {
                jobId,
                ...progressScope,
                phase: 'optimizing',
                percent: 100,
                status: 'running',
            });

            logger.info(`[${jobId}] Conversion to PDF complete: ${normalizedOutputPath}`);
            allowOpenPath(normalizedOutputPath, context.sender);
            return {
                success: true,
                pdfPath: normalizedOutputPath,
                jobId,
                ...progressScope,
            };
        });
        if (!result.success) {
            const error = getOptionalResultError(result);
            const canceled = job.signal.aborted
                || isDjvuCancellationError(error);
            if (canceled) {
                throw job.signal.reason ?? createAbortError('DjVu conversion canceled');
            }
        }
        return result;
    } catch (error) {
        const canceled = job.signal.aborted || isDjvuCancellationError(error);
        if (canceled) {
            logger.info(`[${jobId}] Conversion canceled`);
        } else {
            logger.error(`[${jobId}] Conversion failed: ${getErrorMessage(error)}`);
        }
        const result = {
            success: false,
            jobId,
            ...progressScope,
            error: canceled ? 'DjVu conversion canceled' : getErrorMessage(error),
        };
        return result;
    } finally {
        activePdfWorkerByJobId.delete(jobId);
        try {
            await rm(tempDir, {
                force: true,
                recursive: true,
            });
        } catch {
            // Ignore cleanup errors
        }
    }
}

function startDjvuConvertJob(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
    durable: boolean,
) {
    const conversionId = randomUUID();
    const jobId = options.jobId ?? `djvu-convert-${conversionId}`;
    const progressScope = createDjvuProgressScope(options.requestId, options.documentRef ?? djvuPath);
    return startDjvuJob(context, {
        jobId,
        workingCopyPath: djvuPath,
        initialProgress: {
            jobId,
            ...progressScope,
            phase: 'converting',
            percent: 0,
        },
        durable,
        nativeCancellation: true,
        run: async (job) => {
            let normalizedOutputPath: string | null = null;
            try {
                normalizedOutputPath = consumeAllowedDjvuWritePath(outputPath, context.senderId);
            } catch {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: 'Invalid output path',
                };
            }
            if (!normalizedOutputPath) {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: 'Invalid output path: please use Save dialog before converting DjVu to PDF',
                };
            }
            return runDjvuConvertToPdf(
                context,
                djvuPath,
                normalizedOutputPath,
                options,
                conversionId,
                jobId,
                progressScope,
                job,
            );
        },
    });
}

export async function handleDjvuConvertToPdf(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
): Promise<IDjvuConvertResult> {
    const handle = startDjvuConvertJob(context, djvuPath, outputPath, options, false);
    const terminal = await handle.terminal;
    await handle.settled;
    return terminal.status === 'completed'
        ? terminal.result
        : {
            success: false,
            jobId: handle.jobId,
            ...(terminal.progress.requestId ? {requestId: terminal.progress.requestId} : {}),
            ...(terminal.progress.documentRef ? {documentRef: terminal.progress.documentRef} : {}),
            error: terminal.status === 'canceled'
                ? 'DjVu conversion canceled'
                : terminal.error.message,
        };
}

export function startDurableDjvuConvertJob(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
) {
    return startDjvuConvertJob(context, djvuPath, outputPath, options, true);
}

export async function awaitDurableDjvuConvertJob(context: IDjvuOperationContext, jobId: string) {
    const result = await awaitDjvuJob(context, jobId, 'convert');
    const value = result as IDjvuConvertResult;
    if (value.success && value.pdfPath) {
        allowOpenPath(value.pdfPath, context.sender);
    }
    return value;
}

export function startDurableDjvuOpenJob(
    context: IDjvuOperationContext,
    jobId: string,
    path: TOpenPath,
    run: (signal: AbortSignal) => Promise<IDjvuOpenResult>,
) {
    return startDjvuJob(context, {
        jobId,
        workingCopyPath: path,
        initialProgress: {
            jobId,
            documentRef: path,
            phase: 'loading',
            percent: 0,
        },
        durable: true,
        run: async job => ({
            ...await run(job.signal),
            jobId,
        }),
    });
}

export async function awaitDurableDjvuOpenJob(context: IDjvuOperationContext, jobId: string) {
    const result = await awaitDjvuJob(context, jobId, 'open');
    const value = result as IDjvuOpenResult;
    const snapshot = djvuJobs.get(jobId.trim(), {sender: context.sender});
    if (value.success && snapshot?.progress.documentRef) {
        adoptDjvuViewingPath(context, snapshot.progress.documentRef);
    }
    return value;
}

export function handleDjvuCancel(
    context: IDjvuOperationContext,
    jobId: string,
): Promise<{ canceled: boolean }> {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return Promise.resolve({canceled: false});
    }

    logger.info(`[${normalizedJobId}] Cancel requested`);
    const canceled = djvuJobs.cancel(
        normalizedJobId,
        {sender: context.sender},
        normalizedJobId.startsWith('djvu-open-')
            ? 'DjVu operation canceled'
            : 'DjVu conversion canceled',
    );
    logger.info(`[${normalizedJobId}] Cancel result: ${canceled}`);
    return Promise.resolve({canceled});
}

export async function shutdownDjvuConversions() {
    const jobIds = uniq([
        ...activeNativeJobCancels.keys(),
        ...activePdfWorkerByJobId.keys(),
    ]);

    const workerTerminations: Array<Promise<unknown>> = [];
    if (jobIds.length > 0) {
        logger.info(`Canceling ${jobIds.length} active/queued DjVu conversion job(s) during shutdown`);
        for (const jobId of jobIds) {
            activeNativeJobCancels.get(jobId)?.('DjVu conversion canceled during shutdown');
            await requestDjvuNativeCancel(jobId);
            const activePdfWorker = activePdfWorkerByJobId.get(jobId);
            if (activePdfWorker) {
                activePdfWorkerByJobId.delete(jobId);
                workerTerminations.push(activePdfWorker.terminate().catch(() => undefined));
            }
        }
    }

    activeNativeJobCancels.clear();
    activePdfWorkerByJobId.clear();

    await Promise.allSettled(workerTerminations);
}

export async function clearDjvuJobsForTests() {
    await djvuJobs.clearForTests();
    activeNativeJobCancels.clear();
}
