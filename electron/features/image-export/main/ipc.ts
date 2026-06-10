import {
    BrowserWindow,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { extname } from 'path';
import { uniq } from 'es-toolkit/array';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    normalizeImageExportPath,
} from '@electron/features/image-export/main/export';
import { IMAGE_EXPORT_EVENT_CHANNELS } from '@electron/features/image-export/contract';
import { te } from '@electron/te';
import type {
    IImageExportProgress,
    TImageExportProgressFormat,
} from '@contracts/electronApiDocuments';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/createLogger';

const logger = createLogger('image-export');

type TImageExportProgressPayload = Omit<IImageExportProgress, 'format' | 'percent' | 'requestId'> & {percent?: number;};

async function validateWorkingPdfPath(path: unknown, senderWebContentsId: number) {
    if (!path || typeof path !== 'string' || path.trim() === '') {
        throw new Error('Invalid working copy path');
    }

    if (!await ensureWorkingCopyDirectory(path, senderWebContentsId)) {
        throw new Error('Path is not a managed working copy');
    }

    const resolvedPath = await resolveAllowedWritePath(path);
    if (!resolvedPath) {
        throw new Error('Path is outside the allowed working directory');
    }

    if (!existsSync(resolvedPath)) {
        throw new Error(`Working copy not found: ${resolvedPath}`);
    }

    if (extname(resolvedPath).toLowerCase() !== '.pdf') {
        throw new Error('Working file must be a PDF');
    }

    return resolvedPath;
}

function normalizeRequestedPageNumbers(pageNumbers: unknown): number[] | undefined {
    if (!Array.isArray(pageNumbers)) {
        return undefined;
    }

    const normalized = uniq(pageNumbers)
        .filter(page => typeof page === 'number' && Number.isInteger(page) && page > 0)
        .sort((left, right) => left - right);

    if (normalized.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return normalized;
}

function buildImageSuggestedName(pageNumbers: number[] | undefined) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document-page.jpg';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.jpg`;
    }

    return 'document-pages.jpg';
}

function buildMultiPageTiffSuggestedName(pageNumbers: number[] | undefined) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document.tiff';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.tiff`;
    }

    return 'document-pages.tiff';
}

function createRendererLifecycleAbortController(sender: Electron.WebContents) {
    const abortController = new AbortController();
    const abort = () => {
        abortController.abort(new Error('Renderer lifecycle ended'));
    };
    const cleanup = () => {
        sender.removeListener('destroyed', abort);
        sender.removeListener('render-process-gone', abort);
    };

    if (sender.isDestroyed()) {
        abort();
        return {
            signal: abortController.signal,
            cleanup: () => {},
        };
    }

    sender.once('destroyed', abort);
    sender.once('render-process-gone', abort);

    return {
        signal: abortController.signal,
        cleanup,
    };
}

function isExportAborted(error: unknown) {
    return error instanceof Error
        && (
            error.name === 'AbortError'
            || error.message === 'The operation was aborted'
            || error.message === 'This operation was aborted'
            || error.message === 'Renderer lifecycle ended'
        );
}

function normalizeExportRequestId(requestId: unknown) {
    return typeof requestId === 'string' ? requestId.trim() : '';
}

function sendImageExportProgress(event: Electron.IpcMainInvokeEvent, progress: IImageExportProgress) {
    try {
        event.sender.send(IMAGE_EXPORT_EVENT_CHANNELS.progress, progress);
    } catch (error) {
        logger.debug(`Failed to send image export progress update: ${String(error)}`);
    }
}

function createImageExportProgressReporter(
    event: Electron.IpcMainInvokeEvent,
    format: TImageExportProgressFormat,
    requestId?: string,
) {
    const normalizedRequestId = normalizeExportRequestId(requestId);
    if (!normalizedRequestId) {
        return undefined;
    }

    return (progress: TImageExportProgressPayload) => {
        const total = Math.max(1, Math.trunc(progress.total));
        const processed = clamp(Math.trunc(progress.processed), 0, total);
        sendImageExportProgress(event, {
            requestId: normalizedRequestId,
            format,
            phase: progress.phase,
            processed,
            total,
            percent: clamp(progress.percent ?? ((processed / total) * 100), 0, 100),
        });
    };
}

async function showExportImageDialog(parentWindow: BrowserWindow | null, defaultName: string) {
    const dialogOptions = {
        title: te('dialogs.exportImages'),
        defaultPath: defaultName,
        filters: [
            {
                name: te('dialogs.jpegImages'),
                extensions: [
                    'jpg',
                    'jpeg',
                ],
            },
            {
                name: te('dialogs.pngImages'),
                extensions: ['png'],
            },
            {
                name: te('dialogs.tiffImages'),
                extensions: [
                    'tif',
                    'tiff',
                ],
            },
        ],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

async function showMultiPageTiffDialog(parentWindow: BrowserWindow | null, defaultName: string) {
    const dialogOptions = {
        title: te('dialogs.exportMultiPageTiff'),
        defaultPath: defaultName,
        filters: [{
            name: te('dialogs.tiffImages'),
            extensions: [
                'tif',
                'tiff',
            ],
        }],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

export async function handlePdfExportImages(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pageNumbers?: number[],
    requestId?: string,
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPaths?: string[];
}> {
    const normalizedWorkingCopyPath = await validateWorkingPdfPath(workingCopyPath, event.sender.id);
    const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const lifecycle = createRendererLifecycleAbortController(event.sender);

    try {
        const result = await showExportImageDialog(parentWindow, buildImageSuggestedName(normalizedPageNumbers));
        if (result.canceled || !result.filePath || lifecycle.signal.aborted) {
            return {
                success: false,
                canceled: true,
            };
        }

        const { normalizedPath } = normalizeImageExportPath(result.filePath, 'jpeg');
        const onProgress = createImageExportProgressReporter(event, 'images', requestId);
        const outputPaths = await exportPdfPagesAsImages(normalizedWorkingCopyPath, normalizedPath, {
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: lifecycle.signal,
            ...(onProgress ? { onProgress } : {}),
        });
        if (lifecycle.signal.aborted) {
            return {
                success: false,
                canceled: true,
            };
        }

        return {
            success: true,
            outputPaths,
        };
    } catch (error) {
        if (isExportAborted(error)) {
            return {
                success: false,
                canceled: true,
            };
        }
        throw error;
    } finally {
        lifecycle.cleanup();
    }
}

export async function handlePdfExportMultiPageTiff(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pageNumbers?: number[],
    requestId?: string,
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
    outputPaths?: string[];
}> {
    const normalizedWorkingCopyPath = await validateWorkingPdfPath(workingCopyPath, event.sender.id);
    const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const lifecycle = createRendererLifecycleAbortController(event.sender);

    try {
        const result = await showMultiPageTiffDialog(parentWindow, buildMultiPageTiffSuggestedName(normalizedPageNumbers));
        if (result.canceled || !result.filePath || lifecycle.signal.aborted) {
            return {
                success: false,
                canceled: true,
            };
        }

        const onProgress = createImageExportProgressReporter(event, 'multipage-tiff', requestId);
        const outputPaths = await exportPdfAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, {
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: lifecycle.signal,
            ...(onProgress ? { onProgress } : {}),
        });
        if (lifecycle.signal.aborted) {
            return {
                success: false,
                canceled: true,
            };
        }

        const outputPath = outputPaths[0];
        if (!outputPath) {
            throw new Error('Multi-page TIFF export did not produce an output file');
        }

        return {
            success: true,
            outputPath,
            outputPaths,
        };
    } catch (error) {
        if (isExportAborted(error)) {
            return {
                success: false,
                canceled: true,
            };
        }
        throw error;
    } finally {
        lifecycle.cleanup();
    }
}
