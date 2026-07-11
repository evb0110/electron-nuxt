import { app } from 'electron';
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
import type {
    IDjvuConvertOptions,
    IDjvuPrintOptions,
    IDjvuPrintResult,
    IDjvuProgress,
} from '@contracts/electronApiDjvu';
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
    PRINT_DJVU_TEMP_PREFIX,
    printManagedTempPdfPath,
} from '@electron/utils/printHandoff';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { DJVU_EVENT_CHANNELS } from '@electron/features/djvu/contract';
import type { IDjvuOperationContext } from '@electron/features/djvu/ports';
import { getDjvuPageSizesForViewing } from '@electron/features/djvu/main/pagePreview';
import {
    buildPrintablePdfData,
    canPrintSourcePdfDirectly,
    normalizePrintPageNumbers,
} from '@pdf-core';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    getDocumentOutputJobState,
    recordDocumentOutputHandoff,
    recordDocumentOutputProgress,
    subscribeDocumentOutputJob,
} from '@electron/features/djvu/main/documentOutputJobStore';
import { mainJobBroker } from '@electron/resources/jobBroker';

const logger = createLogger('djvu-pdfExport');
const canceledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const activeJobAbortControllerById = new Map<string, AbortController>();
const activePdfWorkerByJobId = new Map<string, Worker>();
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

function throwIfCanceled(jobId: string) {
    if (canceledJobIds.has(jobId)) {
        throw new Error('DjVu conversion canceled');
    }
}

async function runDjvuConversionJobWithSlot<T>(
    jobId: string,
    run: () => Promise<T>,
): Promise<T> {
    throwIfCanceled(jobId);
    const signal = activeJobAbortControllerById.get(jobId)?.signal;
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
        ...(signal ? {signal} : {}),
    });
    try {
        throwIfCanceled(jobId);
        return await run();
    } finally {
        lease.release();
        canceledJobIds.delete(jobId);
    }
}

async function requestDjvuCancel(jobId: string) {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return false;
    }

    canceledJobIds.add(normalizedJobId);
    mainJobBroker.cancelOwner(normalizedJobId, 'DjVu conversion canceled');
    const activeAbortController = activeJobAbortControllerById.get(normalizedJobId);
    activeAbortController?.abort(createAbortError('DjVu conversion canceled'));
    const canceledProcess = await cancelConversion(normalizedJobId);
    const hasActivePdfWorker = activePdfWorkerByJobId.has(normalizedJobId);
    return canceledProcess || hasActivePdfWorker || activeJobIds.has(normalizedJobId);
}

function setActivePdfWorker(jobId: string, worker: Worker) {
    activePdfWorkerByJobId.set(jobId, worker);
    if (canceledJobIds.has(jobId)) {
        activeJobAbortControllerById
            .get(jobId)
            ?.abort(createAbortError('DjVu conversion canceled'));
    }
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
        await target.sync();
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

type TDjvuTerminalProgressStatus = Exclude<NonNullable<IDjvuProgress['status']>, 'running'>;
type TDjvuProgressScope = Pick<IDjvuProgress, 'documentRef' | 'requestId'>;

function isTerminalDjvuProgress(progress: IDjvuProgress) {
    return progress.status === 'success'
        || progress.status === 'canceled'
        || progress.status === 'failed';
}

function hasDjvuTerminalProgressStatus(progress: IDjvuProgress) {
    return progress.status === 'success'
        || progress.status === 'canceled'
        || progress.status === 'failed';
}

function createDjvuTerminalProgress(
    jobId: string,
    phase: IDjvuProgress['phase'],
    status: TDjvuTerminalProgressStatus,
    error?: string,
): IDjvuProgress {
    return {
        jobId,
        phase,
        percent: 100,
        status,
        ...(error ? { error } : {}),
    };
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

const progressPumpsBySenderId = new Map<number, ReturnType<typeof createIpcProgressPump<IDjvuProgress>>>();
const progressPumpCleanupSenderIds = new Set<number>();

function getDjvuProgressPump(context: IDjvuOperationContext) {
    let pump = progressPumpsBySenderId.get(context.senderId);
    if (pump) {
        return pump;
    }

    pump = createIpcProgressPump<IDjvuProgress>({
        channel: DJVU_EVENT_CHANNELS.progress,
        getTarget: () => ({
            key: `web-contents:${context.senderId}`,
            isDestroyed: () => context.sender.isDestroyed?.() === true,
            send: (_channel: string, payload: IDjvuProgress) => safeSendToWindow(
                context.parentWindow,
                DJVU_EVENT_CHANNELS.progress,
                payload,
            ),
        }),
        getKey: (progress: IDjvuProgress) => progress.jobId,
        isTerminal: isTerminalDjvuProgress,
        onError: (error: unknown) => {
            logger.debug(`Failed to send DjVu progress: ${getErrorMessage(error)}`);
        },
        onIdle: () => {
            progressPumpsBySenderId.delete(context.senderId);
        },
    });
    progressPumpsBySenderId.set(context.senderId, pump);

    if (!progressPumpCleanupSenderIds.has(context.senderId)) {
        progressPumpCleanupSenderIds.add(context.senderId);
        context.sender.once('destroyed', () => {
            progressPumpsBySenderId.get(context.senderId)?.dispose();
            progressPumpsBySenderId.delete(context.senderId);
            progressPumpCleanupSenderIds.delete(context.senderId);
        });
    }

    return pump;
}

export function subscribeDjvuProgress(context: IDjvuOperationContext) {
    progressPumpsBySenderId.get(context.senderId)?.subscribe({
        key: `web-contents:${context.senderId}`,
        isDestroyed: () => context.sender.isDestroyed?.() === true,
        send: (_channel: string, payload: IDjvuProgress) => safeSendToWindow(
            context.parentWindow,
            DJVU_EVENT_CHANNELS.progress,
            payload,
        ),
    });
}

export function getDjvuOutputJobState(jobId: string) {
    return getDocumentOutputJobState(jobId.trim());
}

export function subscribeDjvuOutputJob(context: IDjvuOperationContext, jobId: string) {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) {
        return null;
    }
    const unsubscribe = subscribeDocumentOutputJob(normalizedJobId, (state) => {
        safeSendToWindow(context.parentWindow, DJVU_EVENT_CHANNELS.progress, state.progress);
    });
    context.sender.once('destroyed', unsubscribe);
    return getDocumentOutputJobState(normalizedJobId);
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
                if (canceledJobIds.has(jobId)) {
                    throw new Error('DjVu conversion canceled');
                }
                throw error;
            } finally {
                clearActivePdfWorker(jobId, task.worker);
            }
        } catch (error) {
            if (!(error instanceof DjvuPdfWorkerStartupError)) {
                throw error;
            }
            if (signal.aborted || canceledJobIds.has(jobId)) {
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
            if (signal.aborted || canceledJobIds.has(jobId)) {
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

export async function handleDjvuPrintPath(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    options: IDjvuPrintOptions,
): Promise<IDjvuPrintResult> {
    const progressScope = createDjvuProgressScope(options.requestId, djvuPath);
    const jobId = resolveDjvuPrintJobId(progressScope.requestId);
    const tempDir = await mkdtemp(join(getAppTempDir(), 'djvu-print-work-'));
    const sourcePdfPath = join(tempDir, `${jobId}.source.pdf`);
    const finalPdfPath = join(getAppTempDir(), `${PRINT_DJVU_TEMP_PREFIX}${jobId}.pdf`);
    let finalPdfHandedToPrint = false;

    logger.info(`[${jobId}] Preparing DjVu for print: ${djvuPath}`);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        workingCopyPath: djvuPath,
        cancel: () => {
            void requestDjvuCancel(jobId);
        },
    });
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    const abortController = new AbortController();
    activeJobAbortControllerById.set(jobId, abortController);
    const handleSenderGone = () => {
        void requestDjvuCancel(jobId);
    };
    context.sender.once('destroyed', handleSenderGone);
    context.sender.once('render-process-gone', handleSenderGone);
    const progressPump = getDjvuProgressPump(context);
    let lastProgressPhase: IDjvuProgress['phase'] = 'converting';
    let hasTerminalProgress = false;
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        lastProgressPhase = scopedProgress.phase;
        if (hasDjvuTerminalProgressStatus(scopedProgress)) {
            hasTerminalProgress = true;
        }
        recordDocumentOutputProgress(scopedProgress);
        progressPump.enqueue(scopedProgress);
    };
    const sendTerminalProgress = (status: TDjvuTerminalProgressStatus, error?: string) => {
        if (hasTerminalProgress) {
            return;
        }
        sendProgress(createDjvuTerminalProgress(jobId, lastProgressPhase, status, error));
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        const result = await runDjvuConversionJobWithSlot(jobId, async () => {
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath, { signal: abortController.signal }),
                getDjvuResolution(djvuPath, { signal: abortController.signal }),
            ]);
            throwIfCanceled(jobId);

            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount, abortController.signal);
            throwIfCanceled(jobId);

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
                    signal: abortController.signal,
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
                        signal: abortController.signal,
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
            throwIfCanceled(jobId);

            let printablePdfPath = convertedPdfPath;
            if (!shouldPrintConvertedPdfDirectly) {
                const sourceData = await readFile(convertedPdfPath);
                const printableData = await buildPrintablePdfData(
                    new Uint8Array(sourceData),
                    {
                        viewMode: options.viewMode,
                        orientation: options.orientation,
                    },
                );
                throwIfCanceled(jobId);
                if (!printableData) {
                    return {
                        success: false,
                        jobId,
                        error: 'Failed to prepare printable DjVu PDF data',
                    };
                }
                await writeFile(finalPdfPath, Buffer.from(printableData));
                printablePdfPath = finalPdfPath;
            }

            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(printablePdfPath, { signal: abortController.signal });
            throwIfCanceled(jobId);
            sendProgress({
                jobId,
                phase: 'printing' as const,
                percent: 100,
            });
            progressPump.flush(jobId);

            const printResult = await printManagedTempPdfPath(
                {window: context.parentWindow},
                printablePdfPath,
                resolveDjvuPrintDocumentTitle(djvuPath, options.fileName, selectedPages),
                {
                    signal: abortController.signal,
                    surface: 'rasterized-html',
                },
            );
            if (abortController.signal.aborted || canceledJobIds.has(jobId)) {
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
                recordDocumentOutputHandoff(jobId, printablePdfPath, {
                    jobId,
                    ...progressScope,
                    phase: 'printing',
                    percent: 100,
                    status: 'running',
                });
                sendTerminalProgress('success');
            }
            return {
                ...printResult,
                jobId,
            };
        });
        if (!result.success) {
            const canceled = result.canceled === true
                || abortController.signal.aborted
                || canceledJobIds.has(jobId)
                || isDjvuCancellationError(result.error);
            sendTerminalProgress(canceled ? 'canceled' : 'failed', result.error);
        }
        return result;
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        const canceled = abortController.signal.aborted
            || canceledJobIds.has(jobId)
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
        sendTerminalProgress(canceled ? 'canceled' : 'failed', result.error);
        return result;
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobAbortControllerById.delete(jobId);
        activePdfWorkerByJobId.delete(jobId);
        context.sender.removeListener('destroyed', handleSenderGone);
        context.sender.removeListener('render-process-gone', handleSenderGone);
        mainOperation.complete();
        progressPump.clearKey(jobId);
        await rm(tempDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        if (!finalPdfHandedToPrint) {
            await rm(finalPdfPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function handleDjvuConvertToPdf(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
    lifecycle: {cancelOnSenderGone?: boolean} = {},
): Promise<{
    success: boolean;
    pdfPath?: string;
    jobId?: string;
    requestId?: string;
    documentRef?: string;
    error?: string;
}> {
    let normalizedOutputPath: string | null = null;
    try {
        normalizedOutputPath = consumeAllowedDjvuWritePath(outputPath, context.senderId);
    } catch {
        return {
            success: false,
            error: 'Invalid output path',
        };
    }
    if (!normalizedOutputPath) {
        return {
            success: false,
            error: 'Invalid output path: please use Save dialog before converting DjVu to PDF',
        };
    }
    const conversionId = randomUUID();
    const jobId = options.jobId ?? `djvu-convert-${conversionId}`;
    const tempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-export-'));
    const tempPdfPath = join(tempDir, `${conversionId}.convert.pdf`);
    const tempBookmarkedPdfPath = join(tempDir, `${conversionId}.bookmarks.pdf`);
    const progressScope = createDjvuProgressScope(options.requestId, options.documentRef ?? djvuPath);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        workingCopyPath: djvuPath,
        cancel: () => {
            void requestDjvuCancel(jobId);
        },
    });
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    const abortController = new AbortController();
    activeJobAbortControllerById.set(jobId, abortController);
    const handleSenderGone = () => {
        void requestDjvuCancel(jobId);
    };
    if (lifecycle.cancelOnSenderGone !== false) {
        context.sender.once('destroyed', handleSenderGone);
        context.sender.once('render-process-gone', handleSenderGone);
    }
    const progressPump = getDjvuProgressPump(context);
    let lastProgressPhase: IDjvuProgress['phase'] = 'converting';
    let hasTerminalProgress = false;
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        lastProgressPhase = scopedProgress.phase;
        if (hasDjvuTerminalProgressStatus(scopedProgress)) {
            hasTerminalProgress = true;
        }
        recordDocumentOutputProgress(scopedProgress);
        progressPump.enqueue(scopedProgress);
    };
    const sendTerminalProgress = (status: TDjvuTerminalProgressStatus, error?: string) => {
        if (hasTerminalProgress) {
            return;
        }
        sendProgress(createDjvuTerminalProgress(jobId, lastProgressPhase, status, error));
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        await assertDjvuExportDiskSpace(djvuPath, normalizedOutputPath);
        const result = await runDjvuConversionJobWithSlot(jobId, async () => {
            const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath, { signal: abortController.signal }),
                getDjvuResolution(djvuPath, { signal: abortController.signal }),
            ]);

            throwIfCanceled(jobId);
            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount, abortController.signal);
            throwIfCanceled(jobId);

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
                    signal: abortController.signal,
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
                        signal: abortController.signal,
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
            throwIfCanceled(jobId);

            const bookmarks = options.preserveBookmarks !== false
                ? await getDjvuOutline(djvuPath, { signal: abortController.signal })
                    .then(sexp => parseDjvuOutline(sexp))
                    .catch(() => [] as IPdfBookmarkEntry[])
                : [];
            if (bookmarks.length > 0) {
                throwIfCanceled(jobId);
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
                    abortController.signal,
                );
            }

            throwIfCanceled(jobId);
            const finalTempPdfPath = bookmarks.length > 0 ? tempBookmarkedPdfPath : tempPdfPath;
            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(finalTempPdfPath, { signal: abortController.signal });
            throwIfCanceled(jobId);
            await replaceFileAtomically(finalTempPdfPath, normalizedOutputPath, abortController.signal);

            recordDocumentOutputHandoff(jobId, normalizedOutputPath, {
                jobId,
                ...progressScope,
                phase: 'optimizing',
                percent: 100,
                status: 'running',
            });
            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: 100,
                status: 'success',
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
            const canceled = abortController.signal.aborted
                || canceledJobIds.has(jobId)
                || isDjvuCancellationError(error);
            sendTerminalProgress(canceled ? 'canceled' : 'failed', error);
        }
        return result;
    } catch (error) {
        const canceled = abortController.signal.aborted || canceledJobIds.has(jobId) || isDjvuCancellationError(error);
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
        sendTerminalProgress(canceled ? 'canceled' : 'failed', result.error);
        return result;
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobAbortControllerById.delete(jobId);
        activePdfWorkerByJobId.delete(jobId);
        if (lifecycle.cancelOnSenderGone !== false) {
            context.sender.removeListener('destroyed', handleSenderGone);
            context.sender.removeListener('render-process-gone', handleSenderGone);
        }
        mainOperation.complete();
        progressPump.clearKey(jobId);
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

export async function handleDjvuCancel(
    context: IDjvuOperationContext,
    jobId: string,
): Promise<{ canceled: boolean }> {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return { canceled: false };
    }

    logger.info(`[${normalizedJobId}] Cancel requested`);
    if (!activeJobIds.has(normalizedJobId)) {
        logger.info(`[${normalizedJobId}] Cancel ignored: no active or queued job`);
        return { canceled: false };
    }
    const canceled = await requestDjvuCancel(normalizedJobId);
    logger.info(`[${normalizedJobId}] Cancel result: ${canceled}`);
    return { canceled };
}

export async function shutdownDjvuConversions() {
    const jobIds = uniq([
        ...activeJobIds,
        ...activePdfWorkerByJobId.keys(),
    ]);

    const workerTerminations: Array<Promise<unknown>> = [];
    if (jobIds.length > 0) {
        logger.info(`Canceling ${jobIds.length} active/queued DjVu conversion job(s) during shutdown`);
        for (const jobId of jobIds) {
            canceledJobIds.add(jobId);
            mainJobBroker.cancelOwner(jobId, 'DjVu conversion canceled during shutdown');
            const activeAbortController = activeJobAbortControllerById.get(jobId);
            activeAbortController?.abort(createAbortError('DjVu conversion canceled'));
            await cancelConversion(jobId);
            const activePdfWorker = activePdfWorkerByJobId.get(jobId);
            if (activePdfWorker) {
                activePdfWorkerByJobId.delete(jobId);
                workerTerminations.push(activePdfWorker.terminate().catch(() => undefined));
            }
        }
    }

    canceledJobIds.clear();
    activeJobIds.clear();
    activeJobAbortControllerById.clear();
    activePdfWorkerByJobId.clear();

    await Promise.allSettled(workerTerminations);
}
