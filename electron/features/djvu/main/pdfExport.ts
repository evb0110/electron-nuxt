import {
    app,
    BrowserWindow,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type {
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import type { Worker } from 'worker_threads';
import {
    remove,
    uniq,
} from 'es-toolkit/array';
import {
    copyFile,
    mkdtemp,
    rm,
    stat,
} from 'fs/promises';
import { join } from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    cancelConversion,
    convertDjvuToPdfFile,
} from '@electron/features/djvu/main/ddjvuConversion';
import {
    getDjvuOutline,
    getDjvuPageCount,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/parseDjvuOutline';
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
    const activePdfWorker = activePdfWorkerByJobId.get(normalizedJobId);
    if (activePdfWorker) {
        activePdfWorkerByJobId.delete(normalizedJobId);
        await activePdfWorker.terminate().catch(() => undefined);
    }
    return removedQueuedJob || canceledProcess || Boolean(activePdfWorker) || activeJobIds.has(normalizedJobId);
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

    cleanup.sender.removeListener('destroyed', cleanup.handleDestroyed);
    cleanup.sender.removeListener('render-process-gone', cleanup.handleRenderProcessGone);
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

    senderCleanupById.set(webContentsId, {
        sender,
        handleDestroyed,
        handleRenderProcessGone,
    });
    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
}

function setActivePdfWorker(jobId: string, worker: Worker) {
    activePdfWorkerByJobId.set(jobId, worker);
    if (canceledJobIds.has(jobId)) {
        activePdfWorkerByJobId.delete(jobId);
        void worker.terminate().catch(() => {});
    }
}

function clearActivePdfWorker(jobId: string, worker: Worker) {
    if (activePdfWorkerByJobId.get(jobId) === worker) {
        activePdfWorkerByJobId.delete(jobId);
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

async function embedPdfBookmarks(
    jobId: string,
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
) {
    if (bookmarks.length === 0) {
        return;
    }

    return measureElectronPerfAsync('djvu:embed-bookmarks', async () => {
        try {
            const task = createDjvuPdfBookmarkTask(inputPdfPath, outputPdfPath, bookmarks);
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

export async function handleDjvuConvertToPdf(
    event: IpcMainInvokeEvent,
    djvuPath: TOpenPath,
    outputPath: string,
    options: {
        subsample?: number;
        preserveBookmarks?: boolean;
    },
): Promise<{
    success: boolean;
    pdfPath?: string;
    jobId?: string;
    error?: string;
}> {
    const window = BrowserWindow.fromWebContents(event.sender);
    let normalizedOutputPath: string | null = null;
    try {
        normalizedOutputPath = consumeAllowedDjvuWritePath(outputPath, event.sender.id);
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
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    activeJobOwnerById.set(jobId, event.sender.id);
    registerSenderLifecycleCleanup(event.sender);
    const abortController = new AbortController();
    activeJobAbortControllerById.set(jobId, abortController);
    safeSendToWindow(window, 'djvu:progress', {
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        return await runDjvuConversionJobWithSlot(jobId, async () => {
            const [pageCount] = await Promise.all([getDjvuPageCount(djvuPath, { signal: abortController.signal })]);

            const subsample = resolveSubsample(options.subsample);
            throwIfCanceled(jobId);

            const convertResult = await convertDjvuToPdfFile(djvuPath, tempPdfPath, jobId, {
                ...(subsample > 1 ? { subsample } : {}),
                pageCount,
                onProgress: (percent) => {
                    safeSendToWindow(window, 'djvu:progress', {
                        jobId,
                        phase: 'converting' as const,
                        percent,
                    });
                },
            });

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
                safeSendToWindow(window, 'djvu:progress', {
                    jobId,
                    phase: 'bookmarks' as const,
                    percent: 92,
                });
                await embedPdfBookmarks(jobId, tempPdfPath, tempBookmarkedPdfPath, bookmarks);
            }

            throwIfCanceled(jobId);
            await replaceFileAtomically(
                bookmarks.length > 0 ? tempBookmarkedPdfPath : tempPdfPath,
                normalizedOutputPath,
            );

            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'bookmarks' as const,
                percent: 100,
            });

            logger.info(`[${jobId}] Conversion to PDF complete: ${normalizedOutputPath}`);
            allowOpenPath(normalizedOutputPath, event.sender);
            return {
                success: true,
                pdfPath: normalizedOutputPath,
                jobId,
            };
        });
    } catch (error) {
        logger.error(`[${jobId}] Conversion failed: ${getErrorMessage(error)}`);
        return {
            success: false,
            jobId,
            error: canceledJobIds.has(jobId) ? 'DjVu conversion canceled' : getErrorMessage(error),
        };
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobOwnerById.delete(jobId);
        unregisterSenderLifecycleCleanupIfIdle(event.sender.id);
        activeJobAbortControllerById.delete(jobId);
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

export async function handleDjvuCancel(
    event: IpcMainInvokeEvent,
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
    if (ownerWebContentsId !== event.sender.id) {
        logger.warn(
            `[${normalizedJobId}] Cancel ignored: sender ${event.sender.id} does not own DjVu conversion job (owner=${ownerWebContentsId ?? 'unknown'})`,
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
