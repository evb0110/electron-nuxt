import {
    BrowserWindow,
    dialog,
    shell,
} from 'electron';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import {
    extname,
    basename,
    isAbsolute,
    join,
    resolve,
} from 'path';
import {
    type ICreatePdfFromInputPathsProgress,
    isSupportedOpenPath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-conversion';
import { refreshMenu } from '@electron/menu';
import {
    createWorkingCopyFromData,
    createWorkingCopyFromPath,
    isKnownWorkingCopyOriginalPath,
} from '@electron/ipc/workingCopy';
import {
    allowOpenPath,
    logRejectedOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/ipc/openPathCapabilities';
import { resolveAllowedReadPath } from '@electron/utils/path-validator';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import { getErrorMessage } from '@electron/utils/error';
import {
    openInputPaths,
    type IOpenFileResult,
} from '@electron/features/documents/main/document-open.service';
import {
    saveDocxAs,
    savePdfAs,
    savePdfDialog,
} from '@electron/features/documents/main/document-save.service';

const logger = createLogger('documents-dialogs');
function getOpenDialogParentWindow() {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

type TOpenBatchProgressPayload = ICreatePdfFromInputPathsProgress & {requestId: string;};
type TOpenPathOwner = number | Electron.WebContents;
const OPEN_PDF_DIRECT_BATCH_PROGRESS_CHANNEL = 'dialog:openPdfDirectBatch:progress';

function sendOpenBatchProgress(
    event: Electron.IpcMainInvokeEvent,
    payload: TOpenBatchProgressPayload,
) {
    try {
        event.sender.send(OPEN_PDF_DIRECT_BATCH_PROGRESS_CHANNEL, payload);
    } catch (error) {
        logger.debug(`Failed to send open-batch progress update: ${String(error)}`);
    }
}

function errorWithDetails(fallbackMessage: string, details: unknown): Error {
    const detailText = details instanceof Error ? details.message : String(details ?? '').trim();
    if (!detailText) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage}: ${detailText}`);
}

interface IOpenDocumentDialogOptions {
    title: string;
    extensions: string[];
}

interface ISaveDialogOptions {
    title: string;
    defaultPath: string;
    filterName: string;
    extension: string;
}

interface ITrustedOriginalPathOptions {
    sourcePath?: string;
    warningContext: string;
}

function resolveTrustedOriginalPath(
    originalPath: string | undefined,
    options: ITrustedOriginalPathOptions,
) {
    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    if (normalizedOriginalPath && (!isAbsolute(normalizedOriginalPath) || !isSupportedOpenPath(normalizedOriginalPath))) {
        throw new Error('Invalid original path');
    }

    const trustedOriginalPath = normalizedOriginalPath && (
        normalizedOriginalPath === options.sourcePath
        || isKnownWorkingCopyOriginalPath(normalizedOriginalPath)
    )
        ? normalizedOriginalPath
        : undefined;
    if (normalizedOriginalPath && !trustedOriginalPath) {
        logger.warn(`Ignoring untrusted original path for ${options.warningContext}`);
    }

    return trustedOriginalPath;
}

export async function handleOpenPdfDirect(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IOpenFileResult | null> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        logger.warn('openPdfDirect received empty path');
        return null;
    }

    let normalizedPath: TOpenPath;
    try {
        normalizedPath = requireOpenPath(filePath, event.sender);
    } catch {
        logRejectedOpenPath(filePath);
        throw new Error(te('errors.file.invalid'));
    }

    logger.info(`openPdfDirect request: ${normalizedPath}`);
    try {
        const result = await openInputPaths([normalizedPath], {}, event.sender);
        logger.info(`openPdfDirect result for ${normalizedPath}: ${result?.kind ?? 'null'}`);
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
): Promise<IOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }

    try {
        const normalizedPaths = normalizeNonEmptyStringPaths(filePaths)
            .map(path => requireOpenPath(path, event.sender));

        const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
        return await openInputPaths(normalizedPaths, {onCombineProgress: normalizedRequestId
            ? (progress) => {
                sendOpenBatchProgress(event, {
                    requestId: normalizedRequestId,
                    ...progress,
                });
            }
            : undefined}, event.sender);
    } catch (err) {
        logger.error(`Failed to create working copy from batch: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleCreateWorkingCopyFromData(
    _event: Electron.IpcMainInvokeEvent,
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
): Promise<string> {
    const normalizedName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!normalizedName) {
        throw new Error('Invalid file name');
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('Invalid PDF payload');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(originalPath, {warningContext: 'createWorkingCopyFromData'});

    return createWorkingCopyFromData(normalizedName, data, trustedOriginalPath);
}

export async function handleCreateWorkingCopyFromPath(
    _event: Electron.IpcMainInvokeEvent,
    sourcePath: TOpenPath,
    originalPath?: string,
): Promise<string> {
    if (!existsSync(sourcePath)) {
        throw new Error(`File not found: ${sourcePath}`);
    }
    if (!isSupportedOpenPath(sourcePath)) {
        throw new Error('Invalid source file type');
    }

    const trustedOriginalPath = resolveTrustedOriginalPath(originalPath, {
        sourcePath,
        warningContext: 'createWorkingCopyFromPath',
    });

    return createWorkingCopyFromPath(sourcePath, trustedOriginalPath);
}

export function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        const normalizedTitle = typeof title === 'string' ? title : '';
        window.setTitle(normalizedTitle || te('app.title'));
        refreshMenu();
    }
}

async function resolveRevealablePath(filePath: string, owner?: TOpenPathOwner) {
    const resolvedReadPath = await resolveAllowedReadPath(filePath);
    if (resolvedReadPath) {
        return resolvedReadPath;
    }

    const allowedRevealPath = (() => {
        try {
            return requireOpenPath(resolve(filePath), owner);
        } catch {
            return null;
        }
    })();
    if (allowedRevealPath && existsSync(allowedRevealPath)) {
        return allowedRevealPath;
    }

    const normalizedPath = resolve(filePath);
    if (!isKnownWorkingCopyOriginalPath(normalizedPath) || !existsSync(normalizedPath)) {
        return null;
    }
    return normalizedPath;
}

export async function handleShowItemInFolder(
    event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<boolean> {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return false;
    }

    try {
        const revealablePath = await resolveRevealablePath(normalizedPath, event.sender);
        if (!revealablePath) {
            return false;
        }
        shell.showItemInFolder(revealablePath);
        return true;
    } catch (error) {
        logger.error(`Failed to show item in folder: ${getErrorMessage(error)}`);
        return false;
    }
}

async function showOpenDocumentDialog(options: IOpenDocumentDialogOptions) {
    const parentWindow = getOpenDialogParentWindow();
    const dialogOptions = {
        title: options.title,
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: options.extensions,
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    } satisfies Electron.OpenDialogOptions;

    return parentWindow
        ? dialog.showOpenDialog(parentWindow, dialogOptions)
        : dialog.showOpenDialog(dialogOptions);
}

async function showSaveDialogWithExtension(
    event: Electron.IpcMainInvokeEvent,
    options: ISaveDialogOptions,
) {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: [{
            name: options.filterName,
            extensions: [options.extension],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return null;
    }

    const extension = `.${options.extension}`;
    return extname(result.filePath).toLowerCase() === extension
        ? result.filePath
        : `${result.filePath}${extension}`;
}

export async function handleOpenPdfDialog(event: Electron.IpcMainInvokeEvent): Promise<IOpenFileResult | null> {
    const result = await showOpenDocumentDialog({
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

export async function handleOpenFolderDialog(event: Electron.IpcMainInvokeEvent): Promise<IOpenFileResult | null> {
    const parentWindow = getOpenDialogParentWindow();
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
        .filter(path => isSupportedOpenPath(path))
        .sort((a, b) => basename(a).localeCompare(basename(b)));

    if (supportedPaths.length === 0) {
        throw new Error(te('errors.file.folderEmpty'));
    }

    try {
        return await openInputPaths(supportedPaths, {}, event.sender);
    } catch (err) {
        logger.error(`Failed to open folder contents: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenCombineDialog(event: Electron.IpcMainInvokeEvent): Promise<IOpenFileResult | null> {
    const result = await showOpenDocumentDialog({
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

export async function handleOpenImageDialog(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
    const parentWindow = getOpenDialogParentWindow();
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

export async function handleSavePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    return savePdfAs(event, workingPath, showSaveDialogWithExtension);
}

export async function handleSavePdfDialog(
    event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
): Promise<string | null> {
    return savePdfDialog(event, suggestedName, showSaveDialogWithExtension);
}

export async function handleSaveDocxAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    return saveDocxAs(event, workingPath, showSaveDialogWithExtension);
}
