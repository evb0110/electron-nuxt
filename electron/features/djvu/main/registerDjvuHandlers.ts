import { ipcMain } from 'electron';
import type {
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { estimateSizes } from '@electron/djvu/estimateSizes';
import {
    getDjvuHasText,
    getDjvuMetadata,
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/parseDjvuOutline';
import {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
} from '@electron/features/djvu/main/pdfExport';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupDjvuTempPdfPath,
    handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath,
    releaseDjvuViewingPath,
    sweepStaleDjvuTempPdfs,
} from '@electron/features/djvu/main/viewing';
import {
    getDjvuPageSizesForViewing,
    renderDjvuPagePreview,
} from '@electron/features/djvu/main/pagePreview';
import { isDjvuPath } from '@electron/image/pdfConversion';
import {
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { TDjvuIpcMainRegistrar } from '@electron/features/djvu/ports';
import { DJVU_CHANNELS } from '@electron/features/djvu/contract';
import type { IDjvuPagePreviewOptions } from '@contracts/electronApiDjvu';

const logger = createLogger('djvu-ipc');

function requireDjvuOpenPath(
    path: unknown,
    owner?: WebContents,
    options: { requireExists?: boolean } = {},
): TOpenPath {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    const normalizedPath = rawPath
        ? (normalizePossiblyEncodedExistingPath(rawPath) ?? rawPath)
        : '';
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

async function handleDjvuGetPageSizes(
    event: IpcMainInvokeEvent,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, event.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, event.sender.id)) {
        throw new Error('DjVu viewing path is not active');
    }
    const pageCount = await getDjvuPageCount(normalizedDjvuPath);
    return getDjvuPageSizesForViewing(normalizedDjvuPath, pageCount);
}

async function handleDjvuRenderPagePreview(
    event: IpcMainInvokeEvent,
    djvuPath: string,
    pageNumber: number,
    options?: IDjvuPagePreviewOptions,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, event.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, event.sender.id)) {
        throw new Error('DjVu viewing path is not active');
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    return renderDjvuPagePreview(normalizedDjvuPath, pageNumber, options);
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

export function registerDjvuHandlers(registrar: TDjvuIpcMainRegistrar = ipcMain) {
    registrar.handle(DJVU_CHANNELS.openForViewing, (event, djvuPath) =>
        handleDjvuOpenForViewing(event, requireDjvuOpenPath(djvuPath, event.sender)),
    );
    registrar.handle(DJVU_CHANNELS.releaseViewingPath, (event, djvuPath) => {
        releaseDjvuViewingPath(event, normalizeDjvuReleasePath(djvuPath, event.sender));
    });
    registrar.handle(DJVU_CHANNELS.convertToPdf, (event, djvuPath, outputPath, options) =>
        handleDjvuConvertToPdf(
            event,
            requireDjvuOpenPath(djvuPath, event.sender),
            outputPath,
            options,
        ),
    );
    registrar.handle(DJVU_CHANNELS.cancel, handleDjvuCancel);
    registrar.handle(DJVU_CHANNELS.getInfo, handleDjvuGetInfo);
    registrar.handle(DJVU_CHANNELS.getPageSizes, handleDjvuGetPageSizes);
    registrar.handle(DJVU_CHANNELS.renderPagePreview, handleDjvuRenderPagePreview);
    registrar.handle(DJVU_CHANNELS.estimateSizes, handleDjvuEstimateSizes);
    registrar.handle(DJVU_CHANNELS.cleanupTemp, handleDjvuCleanupTemp);

    if (process.env.EVB_DJVU_SWEEP_STALE_TEMP !== '0') {
        void sweepStaleDjvuTempPdfs().catch((error: unknown) => {
            logger.warn(`DjVu stale temp cleanup failed: ${String(error)}`);
        });
    }
}
