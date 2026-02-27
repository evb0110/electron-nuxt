import {
    BrowserWindow,
    app,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import {
    readFile,
    readdir,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    join,
    resolve,
} from 'path';
import {
    PDFDocument,
    rgb,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import {
    cancelConversion,
    convertDjvuToPdf,
} from '@electron/djvu/convert';
import {
    getDjvuOutline,
    getDjvuPageCount,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { createLogger } from '@electron/utils/logger';
import { safeSendToWindow } from '@electron/djvu/ipc-shared';
import { embedBookmarksIntoPdf } from '@electron/djvu/pdf-bookmarks';
import { isAllowedDjvuTempPdfPath } from '@electron/djvu/temp-path';

const logger = createLogger('djvu-ipc');

let activeViewingJobId: string | null = null;
let activeViewingJobWindowId: number | null = null;
const trackedTempPdfs = new Set<string>();
const trackedWindowTempPdfs = new Map<number, Set<string>>();
const hookedWindowIds = new Set<number>();
let globalCleanupHooksInstalled = false;
const DJVU_SETTLED_CLEANUP_DELAY_MS = 60_000;
const DJVU_STALE_SWEEP_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_TEMP_STALE_MAX_AGE_MS ?? `${24 * 60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return parsed;
})();

async function cleanupAllTrackedTempPdfs() {
    const paths = Array.from(trackedTempPdfs.values());
    for (const path of paths) {
        await safeDeleteDjvuTempPdf(path);
    }
}

function normalizeTempPdfPath(tempPdfPath: string): string | null {
    if (!tempPdfPath || tempPdfPath.trim() === '') {
        return null;
    }

    try {
        return resolve(tempPdfPath.trim());
    } catch {
        return null;
    }
}

function canManageDjvuTempPdfPath(tempPdfPath: string) {
    return isAllowedDjvuTempPdfPath(tempPdfPath, app.getPath('temp'));
}

function trackDjvuTempPdfPath(windowId: number, tempPdfPath: string) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath)) {
        return;
    }

    trackedTempPdfs.add(normalizedPath);
    const windowPaths = trackedWindowTempPdfs.get(windowId) ?? new Set<string>();
    windowPaths.add(normalizedPath);
    trackedWindowTempPdfs.set(windowId, windowPaths);
}

function untrackDjvuTempPdfPath(tempPdfPath: string) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath) {
        return;
    }

    trackedTempPdfs.delete(normalizedPath);

    for (const [
        windowId,
        trackedPaths,
    ] of trackedWindowTempPdfs.entries()) {
        trackedPaths.delete(normalizedPath);
        if (trackedPaths.size === 0) {
            trackedWindowTempPdfs.delete(windowId);
        }
    }
}

async function safeDeleteDjvuTempPdf(tempPdfPath: string) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath)) {
        return;
    }

    untrackDjvuTempPdfPath(normalizedPath);

    try {
        await unlink(normalizedPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
            logger.warn(`Failed to remove DjVu temp PDF "${normalizedPath}": ${String(error)}`);
        }
    }
}

function registerGlobalCleanupHooks() {
    if (globalCleanupHooksInstalled) {
        return;
    }

    globalCleanupHooksInstalled = true;
    app.on('before-quit', () => {
        cancelActiveViewingJob();
        void cleanupAllTrackedTempPdfs();
    });
}

export async function cleanupDjvuTempPdfPath(tempPdfPath: string) {
    await safeDeleteDjvuTempPdf(tempPdfPath);
}

async function cleanupDjvuTempPdfsForWindow(windowId: number) {
    const windowPaths = trackedWindowTempPdfs.get(windowId);
    if (!windowPaths || windowPaths.size === 0) {
        return;
    }

    trackedWindowTempPdfs.delete(windowId);
    for (const path of windowPaths) {
        await safeDeleteDjvuTempPdf(path);
    }
}

function scheduleDjvuTempCleanup(tempPdfPath: string, delayMs = DJVU_SETTLED_CLEANUP_DELAY_MS) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath) {
        return;
    }

    const timer = setTimeout(() => {
        void safeDeleteDjvuTempPdf(normalizedPath);
    }, delayMs);
    timer.unref?.();
}

function attachWindowCleanup(window: BrowserWindow) {
    if (hookedWindowIds.has(window.id)) {
        return;
    }

    hookedWindowIds.add(window.id);
    const cleanupForWindow = () => {
        hookedWindowIds.delete(window.id);
        if (activeViewingJobWindowId === window.id) {
            cancelActiveViewingJob();
        }
        void cleanupDjvuTempPdfsForWindow(window.id);
    };

    window.on('closed', cleanupForWindow);
    window.webContents.on('destroyed', cleanupForWindow);
    window.webContents.on('render-process-gone', cleanupForWindow);
}

function cancelActiveViewingJob() {
    if (!activeViewingJobId) {
        return;
    }
    cancelConversion(activeViewingJobId);
    activeViewingJobId = null;
    activeViewingJobWindowId = null;
}

async function backgroundEmbedBookmarksAndSignal(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pdfPath: string,
    jobId: string,
) {
    try {
        const outlineSexp = await getDjvuOutline(djvuPath);
        const bookmarks = parseDjvuOutline(outlineSexp);

        if (bookmarks.length > 0) {
            const pdfData = await readFile(pdfPath);
            const withBookmarks = await embedBookmarksIntoPdf(new Uint8Array(pdfData), bookmarks);
            await writeFile(pdfPath, withBookmarks);
        }

        safeSendToWindow(window, 'djvu:viewingReady', {
            pdfPath,
            isPartial: false,
            jobId,
        });
    } catch (error) {
        safeSendToWindow(window, 'djvu:viewingError', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function addSkeletonPage(doc: PDFDocument, width: number, height: number) {
    const page = doc.addPage([
        width,
        height,
    ]);

    const bgColor = rgb(0.96, 0.96, 0.96);
    const barColor = rgb(0.88, 0.88, 0.88);

    page.drawRectangle({
        x: 0,
        y: 0,
        width,
        height,
        color: bgColor,
    });

    const margin = Math.min(width * 0.12, 72);
    const contentWidth = width - 2 * margin;
    const barHeight = Math.max(4, height * 0.008);
    const lineGap = Math.max(8, height * 0.016);
    const paragraphGap = lineGap * 2.5;

    let y = height - margin * 1.5;

    const paragraphs = [
        4,
        6,
        5,
        4,
        6,
        5,
        3,
        5,
        4,
    ];
    const widthPattern = [
        1.0,
        0.95,
        1.0,
        0.85,
        0.92,
        0.78,
    ];

    for (const lineCount of paragraphs) {
        if (y < margin) {
            break;
        }

        for (let j = 0; j < lineCount; j += 1) {
            if (y < margin) {
                break;
            }

            const fraction = widthPattern[j % widthPattern.length]!;
            page.drawRectangle({
                x: margin,
                y,
                width: contentWidth * fraction,
                height: barHeight,
                color: barColor,
            });

            y -= lineGap;
        }

        y -= paragraphGap - lineGap;
    }
}

async function buildSkeletonPdf(
    page1PdfPath: string,
    pageCount: number,
): Promise<string> {
    const page1Data = await readFile(page1PdfPath);
    const page1Doc = await PDFDocument.load(page1Data, { updateMetadata: false });
    const page1 = page1Doc.getPage(0);
    const {
        width,
        height,
    } = page1.getSize();

    const doc = await PDFDocument.create();
    const [copiedPage1] = await doc.copyPages(page1Doc, [0]);
    doc.addPage(copiedPage1);

    for (let i = 1; i < pageCount; i += 1) {
        addSkeletonPage(doc, width, height);
    }

    const skeletonPath = join(app.getPath('temp'), `djvu-skeleton-${randomUUID()}.pdf`);
    await writeFile(skeletonPath, new Uint8Array(await doc.save()));
    return skeletonPath;
}

async function backgroundConvertAll(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pageCount: number,
    jobId: string,
    previousPdfPath?: string,
) {
    logger.info(`[${jobId}] Background conversion starting: ${pageCount} pages`);
    let fullPdfPath: string | null = null;

    try {
        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'loading' as const,
            current: 0,
            total: pageCount,
            percent: 0,
        });

        const outlinePromise = getDjvuOutline(djvuPath)
            .then(sexp => parseDjvuOutline(sexp))
            .catch(() => [] as IPdfBookmarkEntry[]);

        fullPdfPath = join(app.getPath('temp'), `djvu-full-${randomUUID()}.pdf`);
        const windowId = window?.id;
        if (typeof windowId === 'number') {
            trackDjvuTempPdfPath(windowId, fullPdfPath);
        }
        const convertResult = await convertDjvuToPdf(
            djvuPath,
            fullPdfPath,
            jobId,
            {
                pageCount,
                onProgress: (percent) => {
                    const boundedPercent = Math.max(0, Math.min(90, percent));
                    const completed = Math.round((boundedPercent / 90) * pageCount);
                    safeSendToWindow(window, 'djvu:progress', {
                        jobId,
                        phase: 'loading' as const,
                        current: Math.max(0, Math.min(pageCount, completed)),
                        total: pageCount,
                        percent: boundedPercent,
                    });
                },
            },
        );

        if (!convertResult.success) {
            safeSendToWindow(window, 'djvu:viewingError', {
                jobId,
                error: convertResult.error ?? 'Conversion failed',
            });
            await safeDeleteDjvuTempPdf(fullPdfPath);
            return;
        }

        const bookmarks = await outlinePromise;
        if (bookmarks.length > 0) {
            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'loading' as const,
                current: pageCount,
                total: pageCount,
                percent: 92,
            });

            const fullData = await readFile(fullPdfPath);
            const withBookmarks = await embedBookmarksIntoPdf(new Uint8Array(fullData), bookmarks);
            await writeFile(fullPdfPath, withBookmarks);
        }

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'loading' as const,
            current: pageCount,
            total: pageCount,
            percent: 100,
        });

        logger.info(`[${jobId}] Background conversion complete, signaling renderer`);
        safeSendToWindow(window, 'djvu:viewingReady', {
            pdfPath: fullPdfPath,
            isPartial: false,
            jobId,
        });

        if (previousPdfPath && previousPdfPath !== fullPdfPath) {
            scheduleDjvuTempCleanup(previousPdfPath);
        }
    } catch (error) {
        if (fullPdfPath) {
            await safeDeleteDjvuTempPdf(fullPdfPath);
        }
        logger.error(`[${jobId}] Background conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        safeSendToWindow(window, 'djvu:viewingError', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        if (activeViewingJobId === jobId) {
            activeViewingJobId = null;
            activeViewingJobWindowId = null;
        }
    }
}

export async function sweepStaleDjvuTempPdfs(
    maxAgeMs = DJVU_STALE_SWEEP_MAX_AGE_MS,
): Promise<number> {
    const tempDir = app.getPath('temp');
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch (error) {
        logger.warn(`Failed to enumerate DjVu temp directory for stale cleanup: ${String(error)}`);
        return 0;
    }

    for (const entry of entries) {
        const normalizedEntry = entry.toLowerCase();
        if (!normalizedEntry.startsWith('djvu-') || !normalizedEntry.endsWith('.pdf')) {
            continue;
        }

        const candidatePath = join(tempDir, entry);
        const normalizedPath = normalizeTempPdfPath(candidatePath);
        if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath) || trackedTempPdfs.has(normalizedPath)) {
            continue;
        }

        try {
            const fileStat = await stat(normalizedPath);
            if (!fileStat.isFile()) {
                continue;
            }

            const lastTouchedAt = Math.max(fileStat.mtimeMs, fileStat.ctimeMs);
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                continue;
            }
        } catch {
            continue;
        }

        await safeDeleteDjvuTempPdf(normalizedPath);
        deletedCount += 1;
    }

    if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} stale DjVu temp PDF(s)`);
    }

    return deletedCount;
}

export async function handleDjvuOpenForViewing(
    event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    success: boolean;
    pdfPath?: string;
    pageCount?: number;
    jobId?: string;
    error?: string;
}> {
    registerGlobalCleanupHooks();
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
        attachWindowCleanup(window);
    }
    const windowId = window?.id;

    cancelActiveViewingJob();

    const openId = randomUUID();
    const jobId = `djvu-view-${openId}`;
    logger.info(`[${jobId}] Opening DjVu for viewing: ${djvuPath}`);
    let tempPage1Path: string | null = null;
    let initialPdfPath: string | null = null;

    try {
        const pageCount = await getDjvuPageCount(djvuPath);

        tempPage1Path = join(
            app.getPath('temp'),
            `djvu-page1-${openId}.pdf`,
        );
        const page1PdfPath = tempPage1Path;
        if (typeof windowId === 'number') {
            trackDjvuTempPdfPath(windowId, page1PdfPath);
        }

        const page1Result = await convertDjvuToPdf(djvuPath, page1PdfPath, jobId, { pages: '1' });

        if (!page1Result.success) {
            await safeDeleteDjvuTempPdf(page1PdfPath);
            return {
                success: false,
                error: page1Result.error,
            };
        }

        if (pageCount > 1) {
            initialPdfPath = await buildSkeletonPdf(page1PdfPath, pageCount);
            if (typeof windowId === 'number') {
                trackDjvuTempPdfPath(windowId, initialPdfPath);
            }

            await safeDeleteDjvuTempPdf(page1PdfPath);

            activeViewingJobId = jobId;
            activeViewingJobWindowId = typeof windowId === 'number' ? windowId : null;
            backgroundConvertAll(window, djvuPath, pageCount, jobId, initialPdfPath).catch(() => {
                // Error handling is done inside backgroundConvertAll via viewingError event
            });
        } else {
            initialPdfPath = page1PdfPath;
            backgroundEmbedBookmarksAndSignal(window, djvuPath, page1PdfPath, jobId).catch(() => {
                // Best effort for single-page files
            });
        }

        logger.info(`[${jobId}] Viewing ready: pageCount=${pageCount}, pdfPath=${initialPdfPath}`);
        return {
            success: true,
            pdfPath: initialPdfPath ?? undefined,
            pageCount,
            jobId,
        };
    } catch (error) {
        if (initialPdfPath && initialPdfPath !== tempPage1Path) {
            await safeDeleteDjvuTempPdf(initialPdfPath);
        }
        if (tempPage1Path) {
            await safeDeleteDjvuTempPdf(tempPage1Path);
        }

        logger.error(`[${jobId}] Open failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
