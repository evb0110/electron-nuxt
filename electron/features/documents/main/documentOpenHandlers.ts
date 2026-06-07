import { dialog } from 'electron';
import { readdir } from 'fs/promises';
import {
    basename,
    join,
} from 'path';
import { sortBy } from 'es-toolkit/array';
import {
    type ICreatePdfFromInputPathsProgress,
    isSupportedOpenPath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdfConversion';
import {
    allowOpenPath,
    logRejectedOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { getRecentFiles } from '@electron/recentFiles';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import { getErrorMessage } from '@electron/utils/error';
import {
    DOCUMENTS_EVENT_CHANNELS,
    type TOpenFileResult,
} from '@electron/features/documents/contract';
import { openInputPaths } from '@electron/features/documents/main/openInputPaths.service';
import {
    errorWithDetails,
    getDialogParentWindow,
    showOpenDocumentDialog,
} from '@electron/features/documents/main/documentDialogCommon';

const logger = createLogger('documents-dialogs');

type TOpenBatchProgressPayload = ICreatePdfFromInputPathsProgress & {requestId: string;};

function sendOpenBatchProgress(
    event: Electron.IpcMainInvokeEvent,
    payload: TOpenBatchProgressPayload,
) {
    try {
        event.sender.send(DOCUMENTS_EVENT_CHANNELS.openDocumentDirectBatchProgress, payload);
    } catch (error) {
        logger.debug(`Failed to send open-batch progress update: ${String(error)}`);
    }
}

async function allowRecentFileOpenPath(filePath: string, owner: Electron.WebContents) {
    const normalizedPath = filePath.trim();
    const recentFiles = await getRecentFiles();
    if (!recentFiles.some(file => file.originalPath === normalizedPath)) {
        return null;
    }

    return allowOpenPath(normalizedPath, owner);
}

export async function handleOpenPdfDirect(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<TOpenFileResult | null> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        logger.warn('openDocumentDirect received empty path');
        return null;
    }

    let normalizedPath: TOpenPath;
    try {
        normalizedPath = requireOpenPath(filePath, event.sender);
    } catch {
        const recentOpenPath = await allowRecentFileOpenPath(filePath, event.sender);
        if (!recentOpenPath) {
            logRejectedOpenPath(filePath);
            throw new Error(te('errors.file.invalid'));
        }
        normalizedPath = recentOpenPath;
    }

    logger.info(`openDocumentDirect request: ${normalizedPath}`);
    try {
        const result = await openInputPaths([normalizedPath], {}, event.sender);
        logger.info(`openDocumentDirect result for ${normalizedPath}: ${result?.kind ?? 'null'}`);
        return result;
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDirectBatch(
    event: Electron.IpcMainInvokeEvent,
    filePaths: unknown,
    requestId?: string,
): Promise<TOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }

    try {
        const normalizedPaths = normalizeNonEmptyStringPaths(filePaths)
            .map(path => requireOpenPath(path, event.sender));

        const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
        const options = normalizedRequestId
            ? {onCombineProgress: (progress: ICreatePdfFromInputPathsProgress) => {
                sendOpenBatchProgress(event, {
                    requestId: normalizedRequestId,
                    ...progress,
                });
            }}
            : {};
        return await openInputPaths(normalizedPaths, options, event.sender);
    } catch (err) {
        logger.error(`Failed to create working copy from batch: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDialog(event: Electron.IpcMainInvokeEvent): Promise<TOpenFileResult | null> {
    const result = await showOpenDocumentDialog(event, {
        title: te('dialogs.openDocument'),
        extensions: [
            'pdf',
            'djvu',
            'djv',
            ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths, {}, event.sender);
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenFolderDialog(event: Electron.IpcMainInvokeEvent): Promise<TOpenFileResult | null> {
    const parentWindow = getDialogParentWindow(event);
    const dialogOptions = {
        title: te('dialogs.openFolder'),
        properties: ['openDirectory'],
    } satisfies Electron.OpenDialogOptions;

    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const folderPath = result.filePaths[0]!;

    let entries: string[];
    try {
        entries = await readdir(folderPath);
    } catch (err) {
        logger.error(`Failed to read folder contents: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }

    const supportedPaths = entries
        .map(entry => join(folderPath, entry))
        .filter(path => isSupportedOpenPath(path));
    const sortedSupportedPaths = sortBy(
        supportedPaths.map(path => ({
            path,
            name: basename(path),
        })),
        ['name'],
    ).map(entry => entry.path);

    if (sortedSupportedPaths.length === 0) {
        throw new Error(te('errors.file.folderEmpty'));
    }

    try {
        return await openInputPaths(sortedSupportedPaths, {}, event.sender);
    } catch (err) {
        logger.error(`Failed to open folder contents: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenCombineDialog(event: Electron.IpcMainInvokeEvent): Promise<TOpenFileResult | null> {
    const result = await showOpenDocumentDialog(event, {
        title: te('dialogs.combineFiles'),
        extensions: [
            'pdf',
            ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths, {}, event.sender);
    } catch (err) {
        logger.error(`Failed to combine files: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenImageDialog(event: Electron.IpcMainInvokeEvent) {
    const parentWindow = getDialogParentWindow(event);
    const dialogOptions = {
        title: te('dialogs.openImage'),
        filters: [{
            name: te('dialogs.imagesFilter'),
            extensions: [
                'apng',
                'avif',
                'bmp',
                'gif',
                'jpeg',
                'jpg',
                'png',
                'svg',
                'svgz',
                'webp',
                'ico',
            ],
        }],
        properties: ['openFile'],
    } satisfies Electron.OpenDialogOptions;
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const imagePath = result.filePaths[0] ?? null;
    if (imagePath) {
        allowOpenPath(imagePath, event.sender);
    }
    return imagePath;
}
