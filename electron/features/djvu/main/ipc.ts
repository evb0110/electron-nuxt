import { ipcMain } from 'electron';
import type {
    IpcMain,
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { estimateSizes } from '@electron/djvu/estimate';
import {
    getDjvuHasText,
    getDjvuMetadata,
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
} from '@electron/features/djvu/main/pdfExport';
import { createLogger } from '@electron/utils/logger';
import {
    cleanupDjvuTempPdfPath,
    handleDjvuOpenForViewing,
    releaseDjvuViewingPath,
    sweepStaleDjvuTempPdfs,
} from '@electron/features/djvu/main/viewing';
import { isDjvuPath } from '@electron/image/pdfConversion';
import {
    requireOpenPath,
    type TOpenPath,
} from '@electron/ipc/openPathCapabilities';

const logger = createLogger('djvu-ipc');

function requireDjvuOpenPath(
    path: unknown,
    owner?: WebContents,
    options: { requireExists?: boolean } = {},
): TOpenPath {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    if (options.requireExists !== false && !existsSync(normalizedPath)) {
        throw new Error(`DjVu file not found: ${normalizedPath}`);
    }
    return requireOpenPath(normalizedPath, owner);
}

function normalizeDjvuReleasePath(path: unknown, owner?: WebContents) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    try {
        return requireOpenPath(normalizedPath, owner);
    } catch {
        // The file may have been moved after opening; fall back to the renderer-held path for cleanup.
    }
    return resolve(normalizedPath);
}

async function handleDjvuGetInfo(
    event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}> {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, event.sender);
    const [
        pageCount,
        sourceDpi,
        outlineSexp,
        hasText,
        metadata,
    ] = await Promise.all([
        getDjvuPageCount(normalizedDjvuPath),
        getDjvuResolution(normalizedDjvuPath),
        getDjvuOutline(normalizedDjvuPath),
        getDjvuHasText(normalizedDjvuPath),
        getDjvuMetadata(normalizedDjvuPath),
    ]);

    const bookmarks = parseDjvuOutline(outlineSexp);

    return {
        pageCount,
        sourceDpi,
        hasBookmarks: bookmarks.length > 0,
        hasText,
        metadata,
    };
}

async function handleDjvuEstimateSizes(
    event: IpcMainInvokeEvent,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, event.sender);
    const pageCount = await getDjvuPageCount(normalizedDjvuPath);
    return estimateSizes(normalizedDjvuPath, pageCount);
}

async function handleDjvuCleanupTemp(
    _event: IpcMainInvokeEvent,
    tempPdfPath: string,
) {
    if (!tempPdfPath) {
        return;
    }

    try {
        await cleanupDjvuTempPdfPath(tempPdfPath);
    } catch (error) {
        logger.warn(`Failed to cleanup temporary DjVu PDF: ${String(error)}`);
    }
}

interface IIpcMainHandleRegistrar {handle: IpcMain['handle'];}

export function registerDjvuHandlers(registrar: IIpcMainHandleRegistrar = ipcMain) {
    registrar.handle('djvu:openForViewing', (event, djvuPath) =>
        handleDjvuOpenForViewing(event, requireDjvuOpenPath(djvuPath, event.sender)),
    );
    registrar.handle('djvu:releaseViewingPath', (event, djvuPath) => {
        releaseDjvuViewingPath(event, normalizeDjvuReleasePath(djvuPath, event.sender));
    });
    registrar.handle('djvu:convertToPdf', (event, djvuPath, outputPath, options) =>
        handleDjvuConvertToPdf(
            event,
            requireDjvuOpenPath(djvuPath, event.sender),
            outputPath,
            options,
        ),
    );
    registrar.handle('djvu:cancel', handleDjvuCancel);
    registrar.handle('djvu:getInfo', handleDjvuGetInfo);
    registrar.handle('djvu:estimateSizes', handleDjvuEstimateSizes);
    registrar.handle('djvu:cleanupTemp', handleDjvuCleanupTemp);

    if (process.env.EVB_DJVU_SWEEP_STALE_TEMP !== '0') {
        void sweepStaleDjvuTempPdfs().catch((error: unknown) => {
            logger.warn(`DjVu stale temp cleanup failed: ${String(error)}`);
        });
    }
}
