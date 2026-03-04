import {
    BrowserWindow,
    app,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import {
    mkdir,
    rename,
    rm,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import {
    cancelConversion,
    convertAllPagesToImages,
} from '@electron/djvu/convert';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import {
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { createLogger } from '@electron/utils/logger';
import { safeSendToWindow } from '@electron/djvu/ipc-shared';
import { embedBookmarksIntoPdf } from '@electron/djvu/pdf-bookmarks';
import { consumeAllowedDjvuWritePath } from '@electron/djvu/export-paths';

const logger = createLogger('djvu-ipc');
const canceledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const activeJobOwnerById = new Map<string, number>();
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

export async function runDjvuConversionJobWithSlot<T>(
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

export function requestDjvuCancel(jobId: string): boolean {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return false;
    }

    canceledJobIds.add(normalizedJobId);
    const removedQueuedJob = removeQueuedConversionJob(normalizedJobId);
    const canceledProcess = cancelConversion(normalizedJobId);
    return removedQueuedJob || canceledProcess || activeJobIds.has(normalizedJobId);
}

async function writePdfAtomically(outputPath: string, data: Uint8Array) {
    const tempPath = join(dirname(outputPath), `.${randomUUID()}.tmp.pdf`);
    try {
        await writeFile(tempPath, data);
        await rename(tempPath, outputPath);
    } finally {
        try {
            await unlink(tempPath);
        } catch {
            // Ignore if temp file does not exist or was already moved.
        }
    }
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
    const imageDir = join(app.getPath('temp'), `djvu-images-${conversionId}`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);
    activeJobOwnerById.set(jobId, event.sender.id);

    try {
        return await runDjvuConversionJobWithSlot(jobId, async () => {
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                getDjvuPageCount(djvuPath),
                getDjvuResolution(djvuPath),
            ]);

            const subsample = resolveSubsample(options.subsample);
            const effectiveDpi = Math.round(sourceDpi / subsample);
            if (!Number.isFinite(effectiveDpi) || effectiveDpi <= 0) {
                throw new Error('Invalid effective DPI for DjVu conversion');
            }
            throwIfCanceled(jobId);

            await mkdir(imageDir, { recursive: true });

            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'converting' as const,
                percent: 0,
            });

            const outlinePromise = (options.preserveBookmarks !== false)
                ? getDjvuOutline(djvuPath).then(sexp => parseDjvuOutline(sexp)).catch(() => [] as IPdfBookmarkEntry[])
                : Promise.resolve([] as IPdfBookmarkEntry[]);

            const imageResult = await convertAllPagesToImages(djvuPath, imageDir, pageCount, jobId, {
                subsample: subsample > 1 ? subsample : undefined,
                format: 'ppm',
                onPageConverted: (completed, total) => {
                    safeSendToWindow(window, 'djvu:progress', {
                        jobId,
                        phase: 'converting' as const,
                        percent: Math.round((completed / total) * 70),
                    });
                },
            });

            if (!imageResult.success) {
                return {
                    success: false,
                    jobId,
                    error: imageResult.error,
                };
            }
            throwIfCanceled(jobId);

            const imagePaths = Array.from(
                { length: pageCount },
                (_, index) => join(imageDir, `page-${index + 1}.ppm`),
            );

            let pdfData: Uint8Array = await buildOptimizedPdf(imagePaths, effectiveDpi, (page, total) => {
                safeSendToWindow(window, 'djvu:progress', {
                    jobId,
                    phase: 'converting' as const,
                    percent: 70 + Math.round((page / total) * 20),
                });
            });
            throwIfCanceled(jobId);

            const bookmarks = await outlinePromise;
            if (bookmarks.length > 0) {
                throwIfCanceled(jobId);
                safeSendToWindow(window, 'djvu:progress', {
                    jobId,
                    phase: 'bookmarks' as const,
                    percent: 92,
                });
                pdfData = await embedBookmarksIntoPdf(pdfData, bookmarks);
            }

            throwIfCanceled(jobId);
            await writePdfAtomically(normalizedOutputPath, pdfData);

            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'bookmarks' as const,
                percent: 100,
            });

            logger.info(`[${jobId}] Conversion to PDF complete: ${normalizedOutputPath}`);
            return {
                success: true,
                pdfPath: normalizedOutputPath,
                jobId,
            };
        });
    } catch (error) {
        logger.error(`[${jobId}] Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
            success: false,
            jobId,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        canceledJobIds.delete(jobId);
        activeJobIds.delete(jobId);
        activeJobOwnerById.delete(jobId);
        try {
            await rm(imageDir, {
                recursive: true,
                force: true,
            });
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
