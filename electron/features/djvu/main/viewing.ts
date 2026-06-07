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
import { isAllowedDjvuTempPdfPath } from '@electron/djvu/isAllowedDjvuTempPdfPath';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';

const logger = createLogger('djvu-viewing');
const allowedDjvuViewingPathsBySender = new Map<number, Map<string, number>>();
const senderCleanupRegistered = new Set<number>();
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
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
            logger.warn(`Failed to remove DjVu temp PDF "${normalizedPath}": ${String(error)}`);
        }
    }
}

export function performDjvuViewingShutdownCleanup() {
    allowedDjvuViewingPathsBySender.clear();
    senderCleanupRegistered.clear();
}

export async function cleanupDjvuTempPdfPath(tempPdfPath: string) {
    await safeDeleteDjvuTempPdf(tempPdfPath);
}

function registerSenderCleanup(event: IpcMainInvokeEvent) {
    const senderId = event.sender.id;
    if (senderCleanupRegistered.has(senderId)) {
        return;
    }

    const cleanup = () => {
        allowedDjvuViewingPathsBySender.delete(senderId);
        senderCleanupRegistered.delete(senderId);
        event.sender.removeListener('destroyed', cleanup);
        event.sender.removeListener('render-process-gone', cleanup);
    };

    senderCleanupRegistered.add(senderId);
    event.sender.once('destroyed', cleanup);
    event.sender.once('render-process-gone', cleanup);
}

function addAllowedDjvuViewingPath(event: IpcMainInvokeEvent, djvuPath: string) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return;
    }

    registerSenderCleanup(event);
    const senderId = event.sender.id;
    const allowedPaths = allowedDjvuViewingPathsBySender.get(senderId) ?? new Map<string, number>();
    allowedPaths.set(normalizedPath, (allowedPaths.get(normalizedPath) ?? 0) + 1);
    allowedDjvuViewingPathsBySender.set(senderId, allowedPaths);
}

export function releaseDjvuViewingPath(event: IpcMainInvokeEvent, djvuPath: string) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return;
    }

    const senderId = event.sender.id;
    const allowedPaths = allowedDjvuViewingPathsBySender.get(senderId);
    if (!allowedPaths) {
        return;
    }

    const nextCount = (allowedPaths.get(normalizedPath) ?? 0) - 1;
    if (nextCount > 0) {
        allowedPaths.set(normalizedPath, nextCount);
        return;
    }

    allowedPaths.delete(normalizedPath);
    if (allowedPaths.size === 0) {
        allowedDjvuViewingPathsBySender.delete(senderId);
    }
}

export function isAllowedDjvuViewingPath(djvuPath: string, senderId?: number) {
    const normalizedPath = normalizeDjvuViewingPath(djvuPath);
    if (!normalizedPath) {
        return false;
    }

    if (typeof senderId === 'number') {
        return (allowedDjvuViewingPathsBySender.get(senderId)?.get(normalizedPath) ?? 0) > 0;
    }

    for (const allowedPaths of allowedDjvuViewingPathsBySender.values()) {
        if ((allowedPaths.get(normalizedPath) ?? 0) > 0) {
            return true;
        }
    }

    return false;
}

export async function sweepStaleDjvuTempPdfs(
    maxAgeMs = DJVU_STALE_SWEEP_MAX_AGE_MS,
) {
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
    event: IpcMainInvokeEvent,
    djvuPath: TOpenPath,
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

        addAllowedDjvuViewingPath(event, djvuPath);

        logger.info(`Native DjVu viewing ready: ${djvuPath} (${pageCount} pages)`);
        return {
            success: true,
            pageCount,
        };
    } catch (error) {
        const message = getErrorMessage(error);
        logger.error(`DjVu open failed: ${message}`);
        return {
            success: false,
            error: message,
        };
    }
}
