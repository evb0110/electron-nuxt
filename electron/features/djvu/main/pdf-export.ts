import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { Worker } from 'worker_threads';
import {
    rename,
    rm,
    stat,
    unlink,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import {
    cancelConversion,
    convertDjvuToPdfFile,
} from '@electron/features/djvu/main/ddjvu-conversion';
import {
    getDjvuOutline,
    getDjvuPageCount,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { createLogger } from '@electron/utils/logger';
import { measureElectronPerfAsync } from '@electron/utils/dev-perf';
import { safeSendToWindow } from '@electron/djvu/ipc-shared';
import { embedBookmarksIntoPdfFile } from '@electron/djvu/pdf-bookmarks';
import { consumeAllowedDjvuWritePath } from '@electron/djvu/export-paths';
import { allowOpenPath } from '@electron/ipc/openPathCapabilities';
import {
    createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError,
} from '@electron/features/djvu/main/pdf-worker-client';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('djvu-pdf-export');
const canceledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const activeJobOwnerById = new Map<string, number>();
const activePdfWorkerByJobId = new Map<string, Worker>();
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
    const queueIndex = queuedConversionJobIds.indexOf(jobId);
    if (queueIndex === -1) {
        return false;
    }

    queuedConversionJobIds.splice(queueIndex, 1);
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

    while (activeConversionSlots < DJVU_MAX_CONCURRENT_CONVERSIONS && queuedConversionJobIds.length > 0) {
        const nextJobId = queuedConversionJobIds.shift();
        if (!nextJobId) {
            break;
        }

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

function requestDjvuCancel(jobId: string): boolean {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return false;
    }

    canceledJobIds.add(normalizedJobId);
    const removedQueuedJob = removeQueuedConversionJob(normalizedJobId);
    const canceledProcess = cancelConversion(normalizedJobId);
    const activePdfWorker = activePdfWorkerByJobId.get(normalizedJobId);
    if (activePdfWorker) {
        activePdfWorkerByJobId.delete(normalizedJobId);
        void activePdfWorker.terminate().catch(() => {});
    }
    return removedQueuedJob || canceledProcess || Boolean(activePdfWorker) || activeJobIds.has(normalizedJobId);
}

function setActivePdfWorker(jobId: string, worker: Worker) {
    activePdfWorkerByJobId.set(jobId, worker);
}

function clearActivePdfWorker(jobId: string, worker: Worker) {
    if (activePdfWorkerByJobId.get(jobId) === worker) {
        activePdfWorkerByJobId.delete(jobId);
    }
}

async function replaceFileAtomically(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
            throw error;
        }

        await unlink(targetPath);
        await rename(sourcePath, targetPath);
    }
}

async function embedPdfBookmarks(
    jobId: string,
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
): Promise<void> {
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
    djvuPath: string,
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
    const tempPdfPath = join(dirname(normalizedOutputPath), `.${conversionId}.convert.pdf`);
    const tempBookmarkedPdfPath = join(dirname(normalizedOutputPath), `.${conversionId}.bookmarks.pdf`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    activeJobOwnerById.set(jobId, event.sender.id);

    try {
        return await runDjvuConversionJobWithSlot(jobId, async () => {
            const [pageCount] = await Promise.all([getDjvuPageCount(djvuPath)]);

            const subsample = resolveSubsample(options.subsample);
            throwIfCanceled(jobId);

            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'converting' as const,
                percent: 0,
            });

            const outlinePromise = (options.preserveBookmarks !== false)
                ? getDjvuOutline(djvuPath).then(sexp => parseDjvuOutline(sexp)).catch(() => [] as IPdfBookmarkEntry[])
                : Promise.resolve([] as IPdfBookmarkEntry[]);

            const convertResult = await convertDjvuToPdfFile(djvuPath, tempPdfPath, jobId, {
                subsample: subsample > 1 ? subsample : undefined,
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
                    error: convertResult.error,
                };
            }
            throwIfCanceled(jobId);

            const bookmarks = await outlinePromise;
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
            allowOpenPath(normalizedOutputPath);
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
            error: getErrorMessage(error),
        };
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobOwnerById.delete(jobId);
        activePdfWorkerByJobId.delete(jobId);
        try {
            await rm(tempPdfPath, { force: true });
            await rm(tempBookmarkedPdfPath, { force: true });
        } catch {
            // Ignore cleanup errors
        }
    }
}

export function handleDjvuCancel(
    event: IpcMainInvokeEvent,
    jobId: string,
): { canceled: boolean } {
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

    const canceled = requestDjvuCancel(normalizedJobId);
    logger.info(`[${normalizedJobId}] Cancel result: ${canceled}`);
    return { canceled };
}

export async function shutdownDjvuConversions() {
    const jobIds = Array.from(new Set([
        ...activeJobIds,
        ...queuedConversionJobIds,
        ...activePdfWorkerByJobId.keys(),
    ]));

    if (jobIds.length === 0) {
        return;
    }

    logger.info(`Canceling ${jobIds.length} active/queued DjVu conversion job(s) during shutdown`);
    const workerTerminations: Array<Promise<unknown>> = [];
    for (const jobId of jobIds) {
        canceledJobIds.add(jobId);
        removeQueuedConversionJob(jobId);
        cancelConversion(jobId);
        const activePdfWorker = activePdfWorkerByJobId.get(jobId);
        if (activePdfWorker) {
            activePdfWorkerByJobId.delete(jobId);
            workerTerminations.push(activePdfWorker.terminate().catch(() => undefined));
        }
    }

    queuedConversionJobIds.length = 0;
    queuedConversionResolvers.clear();
    activeJobIds.clear();
    activeJobOwnerById.clear();
    activePdfWorkerByJobId.clear();
    activeConversionSlots = 0;

    await Promise.allSettled(workerTerminations);
}
