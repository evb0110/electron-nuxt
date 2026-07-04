import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { Worker } from 'worker_threads';
import {
    remove,
    uniq,
} from 'es-toolkit/array';
import {
    copyFile,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    basename,
    join,
    parse,
} from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
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
import { createAbortError } from '@electron/utils/abort';
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

const logger = createLogger('djvu-pdfExport');
const canceledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const activeJobOwnerById = new Map<string, number>();
const activeJobAbortControllerById = new Map<string, AbortController>();
const activePdfWorkerByJobId = new Map<string, Worker>();
const senderCleanupById = new Map<number, {
    sender: WebContents;
    handleDestroyed: () => void;
    handleRenderProcessGone: () => void;
    handleNavigation: (
        event: Electron.Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => void;
}>();
const queuedConversionJobIds: string[] = [];
const queuedConversionResolvers = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
}>();
let activeConversionSlots = 0;
const DJVU_SUBSAMPLE_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_SUBSAMPLE_MAX ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16;
    }
    return Math.min(parsed, 64);
})();
const DJVU_MAX_CONCURRENT_CONVERSIONS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_MAX_CONCURRENT_CONVERSIONS ?? '1', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 1;
    }
    return Math.min(parsed, 4);
})();
const DJVU_MAX_QUEUED_CONVERSIONS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_MAX_QUEUED_CONVERSIONS ?? '8', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 8;
    }
    return Math.min(parsed, 128);
})();
const DJVU_BOOKMARK_FALLBACK_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_BOOKMARK_FALLBACK_MAX_MB ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 64 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

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

function removeQueuedConversionJob(jobId: string) {
    const removedJobIds = remove(queuedConversionJobIds, candidate => candidate === jobId);
    if (removedJobIds.length === 0) {
        return false;
    }

    const resolver = queuedConversionResolvers.get(jobId);
    queuedConversionResolvers.delete(jobId);
    if (resolver) {
        resolver.reject(new Error('DjVu conversion canceled'));
    }
    return true;
}

function releaseConversionSlot() {
    if (activeConversionSlots > 0) {
        activeConversionSlots -= 1;
    }

    const availableSlots = Math.max(0, DJVU_MAX_CONCURRENT_CONVERSIONS - activeConversionSlots);
    const nextJobIds = queuedConversionJobIds.slice(0, availableSlots);
    queuedConversionJobIds.splice(0, nextJobIds.length);

    for (const nextJobId of nextJobIds) {
        const queued = queuedConversionResolvers.get(nextJobId);
        queuedConversionResolvers.delete(nextJobId);
        if (!queued) {
            continue;
        }
        if (canceledJobIds.has(nextJobId)) {
            queued.reject(new Error('DjVu conversion canceled'));
            continue;
        }

        activeConversionSlots += 1;
        queued.resolve();
    }
}

async function acquireConversionSlot(jobId: string) {
    throwIfCanceled(jobId);

    if (activeConversionSlots < DJVU_MAX_CONCURRENT_CONVERSIONS) {
        activeConversionSlots += 1;
        return;
    }

    if (queuedConversionJobIds.length >= DJVU_MAX_QUEUED_CONVERSIONS) {
        throw new Error(`DjVu conversion queue is full (${DJVU_MAX_QUEUED_CONVERSIONS} queued jobs)`);
    }

    await new Promise<void>((resolve, reject) => {
        queuedConversionJobIds.push(jobId);
        queuedConversionResolvers.set(jobId, {
            resolve,
            reject,
        });
    });
}

async function runDjvuConversionJobWithSlot<T>(
    jobId: string,
    run: () => Promise<T>,
): Promise<T> {
    let hasAcquiredConversionSlot = false;
    try {
        await acquireConversionSlot(jobId);
        hasAcquiredConversionSlot = true;
        throwIfCanceled(jobId);
        return await run();
    } finally {
        if (hasAcquiredConversionSlot) {
            releaseConversionSlot();
        } else {
            removeQueuedConversionJob(jobId);
        }
        canceledJobIds.delete(jobId);
    }
}

async function requestDjvuCancel(jobId: string) {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return false;
    }

    canceledJobIds.add(normalizedJobId);
    const removedQueuedJob = removeQueuedConversionJob(normalizedJobId);
    const activeAbortController = activeJobAbortControllerById.get(normalizedJobId);
    activeAbortController?.abort(createAbortError('DjVu conversion canceled'));
    const canceledProcess = await cancelConversion(normalizedJobId);
    const hasActivePdfWorker = activePdfWorkerByJobId.has(normalizedJobId);
    return removedQueuedJob || canceledProcess || hasActivePdfWorker || activeJobIds.has(normalizedJobId);
}

function requestDjvuCancelForSender(webContentsId: number, reason: string) {
    const jobIds = Array.from(activeJobOwnerById.entries())
        .filter(([
            , ownerWebContentsId,
        ]) => ownerWebContentsId === webContentsId)
        .map(([jobId]) => jobId);

    if (jobIds.length === 0) {
        return;
    }

    logger.info(`Canceling ${jobIds.length} DjVu conversion job(s) for sender ${webContentsId}: ${reason}`);
    for (const jobId of jobIds) {
        void requestDjvuCancel(jobId);
    }
}

function unregisterSenderLifecycleCleanup(webContentsId: number) {
    const cleanup = senderCleanupById.get(webContentsId);
    if (!cleanup) {
        return;
    }

    cleanup.sender.removeListener?.('destroyed', cleanup.handleDestroyed);
    cleanup.sender.removeListener?.('render-process-gone', cleanup.handleRenderProcessGone);
    cleanup.sender.removeListener?.('did-start-navigation', cleanup.handleNavigation);
    senderCleanupById.delete(webContentsId);
}

function unregisterSenderLifecycleCleanupIfIdle(webContentsId: number) {
    if ([...activeJobOwnerById.values()].some(ownerWebContentsId => ownerWebContentsId === webContentsId)) {
        return;
    }
    unregisterSenderLifecycleCleanup(webContentsId);
}

function registerSenderLifecycleCleanup(sender: WebContents) {
    const webContentsId = sender.id;
    if (senderCleanupById.has(webContentsId)) {
        return;
    }

    const cleanup = (reason: string) => {
        requestDjvuCancelForSender(webContentsId, reason);
        unregisterSenderLifecycleCleanup(webContentsId);
    };
    const handleDestroyed = () => {
        cleanup('sender destroyed');
    };
    const handleRenderProcessGone = () => {
        cleanup('render process gone');
    };
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup('sender navigated');
        }
    };

    senderCleanupById.set(webContentsId, {
        sender,
        handleDestroyed,
        handleRenderProcessGone,
        handleNavigation,
    });
    sender.once?.('destroyed', handleDestroyed);
    sender.once?.('render-process-gone', handleRenderProcessGone);
    sender.on?.('did-start-navigation', handleNavigation);
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

async function getDjvuConversionPageSizes(jobId: string, djvuPath: string, pageCount: number) {
    try {
        const pageSizes: IDjvuConversionPageMetrics[] = await getDjvuPageSizesForViewing(djvuPath, pageCount);
        return pageSizes;
    } catch (error) {
        logger.debug(`[${jobId}] Failed to read DjVu page sizes before conversion policy check: ${getErrorMessage(error)}`);
        return null;
    }
}

async function replaceFileAtomically(sourcePath: string, targetPath: string) {
    const stagedPath = makeSiblingTempPath(targetPath);
    let replaced = false;
    try {
        await copyFile(sourcePath, stagedPath);
        await atomicReplace(stagedPath, targetPath);
        replaced = true;
    } finally {
        if (!replaced) {
            await rm(stagedPath, { force: true }).catch(() => undefined);
        }
    }
}

type TDjvuTerminalProgressStatus = Exclude<NonNullable<IDjvuProgress['status']>, 'running'>;

function isTerminalDjvuProgress(progress: IDjvuProgress) {
    return progress.percent >= 100
        || progress.status === 'success'
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

            const inputStats = await stat(inputPdfPath).catch(() => null);
            if (!inputStats || inputStats.size > DJVU_BOOKMARK_FALLBACK_MAX_BYTES) {
                const maxMb = Math.floor(DJVU_BOOKMARK_FALLBACK_MAX_BYTES / (1024 * 1024));
                throw new Error(
                    `DjVu bookmark embedding requires the PDF worker for files larger than ${maxMb}MB`,
                );
            }

            logger.warn(`[${jobId}] DjVu PDF worker unavailable, falling back to in-process bookmark embedding: ${error.message}`);
            await embedBookmarksIntoPdfFile(inputPdfPath, outputPdfPath, bookmarks);
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
    const jobId = resolveDjvuPrintJobId(options.requestId);
    const tempDir = await mkdtemp(join(getAppTempDir(), 'djvu-print-work-'));
    const sourcePdfPath = join(tempDir, `${jobId}.source.pdf`);
    const finalPdfPath = join(getAppTempDir(), `${PRINT_DJVU_TEMP_PREFIX}${jobId}.pdf`);
    let finalPdfHandedToPrint = false;

    logger.info(`[${jobId}] Preparing DjVu for print: ${djvuPath}`);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: djvuPath,
        cancel: () => {
            void requestDjvuCancel(jobId);
        },
    });
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    activeJobOwnerById.set(jobId, context.senderId);
    registerSenderLifecycleCleanup(context.sender);
    const abortController = new AbortController();
    activeJobAbortControllerById.set(jobId, abortController);
    const progressPump = createIpcProgressPump<IDjvuProgress>({
        channel: DJVU_EVENT_CHANNELS.progress,
        getTarget: () => ({
            isDestroyed: () => context.sender.isDestroyed?.() === true,
            send: (channel, payload) => safeSendToWindow(
                context.parentWindow,
                channel,
                payload,
            ),
        }),
        getKey: progress => progress.jobId,
        isTerminal: isTerminalDjvuProgress,
        onError: error => {
            logger.debug(`Failed to send DjVu print progress: ${getErrorMessage(error)}`);
        },
    });
    let lastProgressPhase: IDjvuProgress['phase'] = 'converting';
    let hasTerminalProgress = false;
    const sendProgress = (progress: IDjvuProgress) => {
        lastProgressPhase = progress.phase;
        if (hasDjvuTerminalProgressStatus(progress)) {
            hasTerminalProgress = true;
        }
        progressPump.enqueue(progress);
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

            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount);
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
                    signal: abortController.signal,
                    ...(selectedPages ? { pages: selectedPages } : {}),
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
                            outputPath: convertedPdfPath,
                            fileSize: 0,
                            error: createDjvuConversionPolicyError(policy),
                        };
                    }

                    return convertDjvuToPdfFile(djvuPath, convertedPdfPath, jobId, {
                        ...(subsample > 1 ? { subsample } : {}),
                        ...(selectedPages ? { pages: formatDjvuPageSelection(selectedPages) } : {}),
                        pageCount,
                        onProgress: (percent) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent,
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
                percent: 96,
            });
            await optimizeGeneratedPdfForInteraction(printablePdfPath);
            throwIfCanceled(jobId);
            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: 100,
                status: 'success',
            });
            progressPump.enqueue({
                jobId,
                phase: 'printing' as const,
                percent: 100,
            });

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
            return {
                ...printResult,
                jobId,
            };
        });
        if (!result.success) {
            sendTerminalProgress(result.canceled ? 'canceled' : 'failed', result.error);
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
        activeJobOwnerById.delete(jobId);
        unregisterSenderLifecycleCleanupIfIdle(context.senderId);
        activeJobAbortControllerById.delete(jobId);
        activePdfWorkerByJobId.delete(jobId);
        mainOperation.complete();
        progressPump.clear();
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
    options: {
        subsample?: number;
        preserveBookmarks?: boolean;
        pdfStrategy?: TDjvuPdfExportStrategy;
    },
): Promise<{
    success: boolean;
    pdfPath?: string;
    jobId?: string;
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
    const jobId = `djvu-convert-${conversionId}`;
    const tempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-export-'));
    const tempPdfPath = join(tempDir, `${conversionId}.convert.pdf`);
    const tempBookmarkedPdfPath = join(tempDir, `${conversionId}.bookmarks.pdf`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: djvuPath,
        cancel: () => {
            void requestDjvuCancel(jobId);
        },
    });
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    activeJobOwnerById.set(jobId, context.senderId);
    registerSenderLifecycleCleanup(context.sender);
    const abortController = new AbortController();
    activeJobAbortControllerById.set(jobId, abortController);
    const progressPump = createIpcProgressPump<IDjvuProgress>({
        channel: DJVU_EVENT_CHANNELS.progress,
        getTarget: () => ({
            isDestroyed: () => context.sender.isDestroyed?.() === true,
            send: (channel, payload) => safeSendToWindow(
                context.parentWindow,
                channel,
                payload,
            ),
        }),
        getKey: progress => progress.jobId,
        isTerminal: isTerminalDjvuProgress,
        onError: error => {
            logger.debug(`Failed to send DjVu progress: ${getErrorMessage(error)}`);
        },
    });
    let lastProgressPhase: IDjvuProgress['phase'] = 'converting';
    let hasTerminalProgress = false;
    const sendProgress = (progress: IDjvuProgress) => {
        lastProgressPhase = progress.phase;
        if (hasDjvuTerminalProgressStatus(progress)) {
            hasTerminalProgress = true;
        }
        progressPump.enqueue(progress);
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
            const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath, { signal: abortController.signal }),
                getDjvuResolution(djvuPath, { signal: abortController.signal }),
            ]);

            throwIfCanceled(jobId);
            const pageSizes = await getDjvuConversionPageSizes(jobId, djvuPath, pageCount);
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
                        onProgress: (percent) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent,
                            });
                        },
                    });
                })();

            if (!convertResult.success) {
                return {
                    success: false,
                    jobId,
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
                    percent: 92,
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
                percent: 96,
            });
            await optimizeGeneratedPdfForInteraction(finalTempPdfPath);
            throwIfCanceled(jobId);
            await replaceFileAtomically(finalTempPdfPath, normalizedOutputPath);

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
            };
        });
        if (!result.success) {
            sendTerminalProgress('failed', result.error);
        }
        return result;
    } catch (error) {
        logger.error(`[${jobId}] Conversion failed: ${getErrorMessage(error)}`);
        const canceled = canceledJobIds.has(jobId) || isDjvuCancellationError(error);
        const result = {
            success: false,
            jobId,
            error: canceled ? 'DjVu conversion canceled' : getErrorMessage(error),
        };
        sendTerminalProgress(canceled ? 'canceled' : 'failed', result.error);
        return result;
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobOwnerById.delete(jobId);
        unregisterSenderLifecycleCleanupIfIdle(context.senderId);
        activeJobAbortControllerById.delete(jobId);
        activePdfWorkerByJobId.delete(jobId);
        mainOperation.complete();
        progressPump.clear();
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
    const ownerWebContentsId = activeJobOwnerById.get(normalizedJobId);
    if (ownerWebContentsId !== context.senderId) {
        logger.warn(
            `[${normalizedJobId}] Cancel ignored: sender ${context.senderId} does not own DjVu conversion job (owner=${ownerWebContentsId ?? 'unknown'})`,
        );
        return { canceled: false };
    }

    const canceled = await requestDjvuCancel(normalizedJobId);
    logger.info(`[${normalizedJobId}] Cancel result: ${canceled}`);
    return { canceled };
}

export async function shutdownDjvuConversions() {
    const jobIds = uniq([
        ...activeJobIds,
        ...queuedConversionJobIds,
        ...activePdfWorkerByJobId.keys(),
    ]);

    const workerTerminations: Array<Promise<unknown>> = [];
    if (jobIds.length > 0) {
        logger.info(`Canceling ${jobIds.length} active/queued DjVu conversion job(s) during shutdown`);
        for (const jobId of jobIds) {
            canceledJobIds.add(jobId);
            removeQueuedConversionJob(jobId);
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
    queuedConversionJobIds.length = 0;
    queuedConversionResolvers.clear();
    activeJobIds.clear();
    activeJobOwnerById.clear();
    activeJobAbortControllerById.clear();
    activePdfWorkerByJobId.clear();
    for (const webContentsId of Array.from(senderCleanupById.keys())) {
        unregisterSenderLifecycleCleanup(webContentsId);
    }
    activeConversionSlots = 0;

    await Promise.allSettled(workerTerminations);
}
