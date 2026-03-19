import { app } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    readdir,
    stat,
    unlink,
} from 'fs/promises';
import {
    join,
    resolve,
} from 'path';
import { getDjvuPageCount } from '@electron/djvu/metadata';
import { isAllowedDjvuTempPdfPath } from '@electron/djvu/temp-path';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('djvu-viewing');
const allowedDjvuViewingPaths = new Set<string>();
const DJVU_STALE_SWEEP_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_DJVU_TEMP_STALE_MAX_AGE_MS ?? `${24 * 60 * 60 * 1000}`,
        10,
    );
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return parsed;
})();

function normalizeTempPdfPath(tempPdfPath: string) {
    if (!tempPdfPath || tempPdfPath.trim() === '') {
        return null;
    }

    try {
        return resolve(tempPdfPath.trim());
    } catch {
        return null;
    }
}

function normalizeDjvuViewingPath(djvuPath: string) {
    if (!djvuPath || djvuPath.trim() === '') {
        return null;
    }

    try {
        return resolve(djvuPath.trim());
    } catch {
        return null;
    }
}

function canManageDjvuTempPdfPath(tempPdfPath: string) {
    return isAllowedDjvuTempPdfPath(tempPdfPath, app.getPath('temp'));
}

async function safeDeleteDjvuTempPdf(tempPdfPath: string) {
    const normalizedPath = normalizeTempPdfPath(tempPdfPath);
    if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath)) {
        return;
    }

    try {
        await unlink(normalizedPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
            logger.warn(`Failed to remove DjVu temp PDF "${normalizedPath}": ${String(error)}`);
        }
    }
}

export async function performDjvuViewingShutdownCleanup() {
    // Native DjVu viewing no longer creates temp PDFs on open.
}

export async function cleanupDjvuTempPdfPath(tempPdfPath: string) {
    await safeDeleteDjvuTempPdf(tempPdfPath);
}

export function isAllowedDjvuViewingPath(djvuPath: string) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return false;
    }

    return allowedDjvuViewingPaths.has(normalizedPath);
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
        if (!normalizedPath || !canManageDjvuTempPdfPath(normalizedPath)) {
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
    _event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    success: boolean;
    pageCount?: number;
    error?: string;
}> {
    try {
        const pageCount = await getDjvuPageCount(djvuPath);
        if (pageCount <= 0) {
            return {
                success: false,
                error: 'DjVu document has no pages',
            };
        }

        const normalizedPath = normalizeDjvuViewingPath(djvuPath);
        if (normalizedPath) {
            allowedDjvuViewingPaths.add(normalizedPath);
        }

        logger.info(`Native DjVu viewing ready: ${djvuPath} (${pageCount} pages)`);
        return {
            success: true,
            pageCount,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`DjVu open failed: ${message}`);
        return {
            success: false,
            error: message,
        };
    }
}
