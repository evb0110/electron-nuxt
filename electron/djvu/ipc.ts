import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
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
} from '@electron/djvu/conversion';
import { createLogger } from '@electron/utils/logger';
import {
    cleanupDjvuTempPdfPath,
    handleDjvuOpenForViewing,
    sweepStaleDjvuTempPdfs,
} from '@electron/djvu/viewing';

const logger = createLogger('djvu-ipc');

async function handleDjvuGetInfo(
    _event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}> {
    const [
        pageCount,
        sourceDpi,
        outlineSexp,
        hasText,
        metadata,
    ] = await Promise.all([
        getDjvuPageCount(djvuPath),
        getDjvuResolution(djvuPath),
        getDjvuOutline(djvuPath),
        getDjvuHasText(djvuPath),
        getDjvuMetadata(djvuPath),
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
    _event: IpcMainInvokeEvent,
    djvuPath: string,
) {
    const pageCount = await getDjvuPageCount(djvuPath);
    return estimateSizes(djvuPath, pageCount);
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

export function registerDjvuHandlers() {
    ipcMain.handle('djvu:openForViewing', handleDjvuOpenForViewing);
    ipcMain.handle('djvu:convertToPdf', handleDjvuConvertToPdf);
    ipcMain.handle('djvu:cancel', handleDjvuCancel);
    ipcMain.handle('djvu:getInfo', handleDjvuGetInfo);
    ipcMain.handle('djvu:estimateSizes', handleDjvuEstimateSizes);
    ipcMain.handle('djvu:cleanupTemp', handleDjvuCleanupTemp);

    if (process.env.EVB_DJVU_SWEEP_STALE_TEMP !== '0') {
        void sweepStaleDjvuTempPdfs().catch((error: unknown) => {
            logger.warn(`DjVu stale temp cleanup failed: ${String(error)}`);
        });
    }
}
