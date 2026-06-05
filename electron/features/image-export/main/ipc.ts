import {
    BrowserWindow,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { extname } from 'path';
import { uniq } from 'es-toolkit/array';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import {
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    normalizeImageExportPath,
} from '@electron/features/image-export/main/export';
import { te } from '@electron/i18n';

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
        return 'document-page.png';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.png`;
    }

    return 'document-pages.png';
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

async function showExportImageDialog(parentWindow: BrowserWindow | null, defaultName: string) {
    const dialogOptions = {
        title: te('dialogs.exportImages'),
        defaultPath: defaultName,
        filters: [
            {
                name: te('dialogs.pngImages'),
                extensions: ['png'],
            },
            {
                name: te('dialogs.jpegImages'),
                extensions: [
                    'jpg',
                    'jpeg',
                ],
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

        const { normalizedPath } = normalizeImageExportPath(result.filePath, 'png');
        const outputPaths = await exportPdfPagesAsImages(normalizedWorkingCopyPath, normalizedPath, {
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: lifecycle.signal,
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
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
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

        const outputPath = await exportPdfAsMultiPageTiff(normalizedWorkingCopyPath, result.filePath, {
            ...(normalizedPageNumbers ? { pageNumbers: normalizedPageNumbers } : {}),
            signal: lifecycle.signal,
        });
        if (lifecycle.signal.aborted) {
            return {
                success: false,
                canceled: true,
            };
        }

        return {
            success: true,
            outputPath,
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
