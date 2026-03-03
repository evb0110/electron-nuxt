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

const logger = createLogger('djvu-ipc');
const canceledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const DJVU_SUBSAMPLE_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_SUBSAMPLE_MAX ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16;
    }
    return Math.min(parsed, 64);
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
    const conversionId = randomUUID();
    const jobId = `djvu-convert-${conversionId}`;
    const imageDir = join(app.getPath('temp'), `djvu-images-${conversionId}`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${outputPath}`);
    canceledJobIds.delete(jobId);
    activeJobIds.add(jobId);

    try {
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
        await writePdfAtomically(outputPath, pdfData);

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'bookmarks' as const,
            percent: 100,
        });

        logger.info(`[${jobId}] Conversion to PDF complete: ${outputPath}`);
        return {
            success: true,
            pdfPath: outputPath,
            jobId,
        };
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
    _event: IpcMainInvokeEvent,
    jobId: string,
): { canceled: boolean } {
    const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
    if (!normalizedJobId) {
        return { canceled: false };
    }

    logger.info(`[${normalizedJobId}] Cancel requested`);
    if (!activeJobIds.has(normalizedJobId)) {
        logger.info(`[${normalizedJobId}] Cancel ignored: no active job`);
        return { canceled: false };
    }

    canceledJobIds.add(normalizedJobId);
    cancelConversion(normalizedJobId);
    const canceled = true;
    logger.info(`[${normalizedJobId}] Cancel result: ${canceled}`);
    return { canceled };
}
