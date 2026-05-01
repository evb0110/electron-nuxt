import {
    BrowserWindow,
    dialog,
    shell,
} from 'electron';
import { existsSync } from 'fs';
import { copyFile } from 'fs/promises';
import {
    extname,
    basename,
    isAbsolute,
    resolve,
} from 'path';
import { uniq } from 'es-toolkit/array';
import {
    buildCombinedPdfOutputPath,
    createPdfFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-conversion';
import {
    refreshMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import { addRecentFile } from '@electron/recent-files';
import { allowDocxWritePath } from '@electron/ipc/docxExportPaths';
import { allowDjvuWritePath } from '@electron/djvu/export-paths';
import {
    createWorkingCopy,
    createWorkingCopyFromData,
    createWorkingCopyFromPath,
    isKnownWorkingCopyOriginalPath,
    workingCopyMap,
} from '@electron/ipc/workingCopy';
import {
    allowOpenPaths,
    isAllowedOpenPath,
    logRejectedOpenPath,
} from '@electron/ipc/openPathCapabilities';
import { resolveAllowedReadPath } from '@electron/utils/path-validator';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-dialogs');
function getOpenDialogParentWindow() {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: string;
    originalPath: string;
    isGenerated?: boolean;
}

interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: string;
}

type IOpenFileResult = IOpenPdfResult | IOpenDjvuResult;
type TOpenBatchProgressPayload = ICreatePdfFromInputPathsProgress & {requestId: string;};
const OPEN_PDF_DIRECT_BATCH_PROGRESS_CHANNEL = 'dialog:openPdfDirectBatch:progress';

function toRecentDocumentPaths(paths: string[]) {
    return paths.filter(path => isPdfPath(path) || isDjvuPath(path));
}

async function addRecentInputs(paths: string[]) {
    const uniquePaths = uniq(paths);
    allowOpenPaths(uniquePaths);
    for (const path of uniquePaths) {
        await addRecentFile(path);
    }
    updateRecentFilesMenu();
}

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

function normalizeInputPaths(paths: string[]) {
    return paths
        .filter((path): path is string => typeof path === 'string')
        .map(path => path.trim())
        .filter(path => path.length > 0);
}

function errorWithDetails(fallbackMessage: string, details: unknown): Error {
    const detailText = details instanceof Error ? details.message : String(details ?? '').trim();
    if (!detailText) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage}: ${detailText}`);
}

interface IOpenInputPathsOptions {onCombineProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
): Promise<IOpenFileResult | null> {
    const normalizedPaths = normalizeInputPaths(paths);
    logger.info(`openInputPaths normalized ${normalizedPaths.length} path(s): ${normalizedPaths.join(' | ')}`);
    if (normalizedPaths.length === 0) {
        return null;
    }

    if (normalizedPaths.some(path => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (normalizedPaths.some(path => !isSupportedOpenPath(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    const djvuPaths = normalizedPaths.filter(path => isDjvuPath(path));
    if (djvuPaths.length > 0) {
        if (normalizedPaths.length !== 1 || djvuPaths.length !== 1) {
            throw new Error(te('errors.file.invalid'));
        }

        const djvuPath = djvuPaths[0]!;
        logger.info(`openInputPaths resolved DjVu path: ${djvuPath}`);
        await addRecentInputs([djvuPath]);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: djvuPath,
        };
    }

    if (normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const originalPath = normalizedPaths[0]!;
        logger.info(`openInputPaths creating working copy for PDF: ${originalPath}`);
        const workingPath = await createWorkingCopy(originalPath);
        await addRecentInputs([originalPath]);
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    }

    const mergedPdf = await createPdfFromInputPaths(normalizedPaths, {onProgress: options.onCombineProgress});
    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    logger.info(`openInputPaths created combined PDF for batch; output: ${outputPath}`);
    const workingPath = await createWorkingCopyFromData(
        basename(outputPath),
        mergedPdf,
        outputPath,
    );

    const recentDocumentPaths = toRecentDocumentPaths(normalizedPaths);
    if (recentDocumentPaths.length > 0) {
        await addRecentInputs(recentDocumentPaths);
    }

    return {
        kind: 'pdf',
        workingPath,
        originalPath: outputPath,
        isGenerated: true,
    };
}

export async function handleOpenPdfDirect(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IOpenFileResult | null> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        logger.warn('openPdfDirect received empty path');
        return null;
    }

    const normalizedPath = filePath.trim();
    if (!isAllowedOpenPath(normalizedPath)) {
        logRejectedOpenPath(normalizedPath);
        throw new Error(te('errors.file.invalid'));
    }

    logger.info(`openPdfDirect request: ${normalizedPath}`);
    try {
        const result = await openInputPaths([normalizedPath]);
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
        const normalizedPaths = normalizeInputPaths(filePaths);
        const rejectedPath = normalizedPaths.find(path => !isAllowedOpenPath(path));
        if (rejectedPath) {
            logRejectedOpenPath(rejectedPath);
            throw new Error(te('errors.file.invalid'));
        }

        const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
        return await openInputPaths(normalizedPaths, {onCombineProgress: normalizedRequestId
            ? (progress) => {
                sendOpenBatchProgress(event, {
                    requestId: normalizedRequestId,
                    ...progress,
                });
            }
            : undefined});
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

    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    if (normalizedOriginalPath && (!isAbsolute(normalizedOriginalPath) || !isSupportedOpenPath(normalizedOriginalPath))) {
        throw new Error('Invalid original path');
    }
    const trustedOriginalPath = normalizedOriginalPath && isKnownWorkingCopyOriginalPath(normalizedOriginalPath)
        ? normalizedOriginalPath
        : undefined;
    if (normalizedOriginalPath && !trustedOriginalPath) {
        // Ignore renderer-supplied write targets unless they originated from a
        // previously trusted working-copy mapping.
        logger.warn('Ignoring untrusted original path for createWorkingCopyFromData');
    }

    return createWorkingCopyFromData(normalizedName, data, trustedOriginalPath);
}

export async function handleCreateWorkingCopyFromPath(
    _event: Electron.IpcMainInvokeEvent,
    sourcePath: string,
    originalPath?: string,
): Promise<string> {
    const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (!normalizedSourcePath) {
        throw new Error('Invalid source path');
    }

    if (!existsSync(normalizedSourcePath)) {
        throw new Error(`File not found: ${normalizedSourcePath}`);
    }
    if (!isSupportedOpenPath(normalizedSourcePath)) {
        throw new Error('Invalid source file type');
    }

    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    if (normalizedOriginalPath && (!isAbsolute(normalizedOriginalPath) || !isSupportedOpenPath(normalizedOriginalPath))) {
        throw new Error('Invalid original path');
    }
    const trustedOriginalPath = normalizedOriginalPath && (
        normalizedOriginalPath === normalizedSourcePath
        || isKnownWorkingCopyOriginalPath(normalizedOriginalPath)
    )
        ? normalizedOriginalPath
        : undefined;
    if (normalizedOriginalPath && !trustedOriginalPath) {
        logger.warn('Ignoring untrusted original path for createWorkingCopyFromPath');
    }

    return createWorkingCopyFromPath(normalizedSourcePath, trustedOriginalPath);
}

export function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        const normalizedTitle = typeof title === 'string' ? title : '';
        window.setTitle(normalizedTitle || te('app.title'));
        refreshMenu();
    }
}

async function resolveRevealablePath(filePath: string) {
    const resolvedReadPath = await resolveAllowedReadPath(filePath);
    if (resolvedReadPath) {
        return resolvedReadPath;
    }

    const normalizedPath = resolve(filePath);
    if (!isKnownWorkingCopyOriginalPath(normalizedPath) || !existsSync(normalizedPath)) {
        return null;
    }
    return normalizedPath;
}

export async function handleShowItemInFolder(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<boolean> {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return false;
    }

    try {
        const revealablePath = await resolveRevealablePath(normalizedPath);
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

export async function handleOpenPdfDialog(): Promise<IOpenFileResult | null> {
    const parentWindow = getOpenDialogParentWindow();
    const dialogOptions = {
        title: te('dialogs.openDocument'),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                'djvu',
                'djv',
                ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    } satisfies Electron.OpenDialogOptions;
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths);
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenCombineDialog(): Promise<IOpenFileResult | null> {
    const parentWindow = getOpenDialogParentWindow();
    const dialogOptions = {
        title: te('dialogs.combineFiles'),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    } satisfies Electron.OpenDialogOptions;
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths);
    } catch (err) {
        logger.error(`Failed to combine files: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenImageDialog(): Promise<string | null> {
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

    return result.filePaths[0] ?? null;
}

export async function handleSavePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return null;
    }

    const extension = extname(normalizedWorkingPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }

    const originalPath = workingCopyMap.get(normalizedWorkingPath);
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(normalizedWorkingPath);

    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.pdf') {
        targetPath += '.pdf';
    }

    await copyFile(normalizedWorkingPath, targetPath);

    workingCopyMap.set(normalizedWorkingPath, targetPath);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return targetPath;
}

export async function handleSavePdfDialog(
    event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
): Promise<string | null> {
    const normalizedSuggestedName = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim()
        : 'document.pdf';
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.savePdf'),
        defaultPath: normalizedSuggestedName.endsWith('.pdf') ? normalizedSuggestedName : `${normalizedSuggestedName}.pdf`,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.pdf') {
        targetPath += '.pdf';
    }

    // Save dialog approval is the capability boundary for DjVu export writes.
    allowDjvuWritePath(targetPath, event.sender.id);

    return targetPath;
}

export async function handleSaveDocxAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';

    const suggestedBase = normalizedWorkingPath
        ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
        : 'ocr-text';

    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filters: [{
            name: te('dialogs.wordDocuments'),
            extensions: ['docx'],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.docx') {
        targetPath += '.docx';
    }

    allowDocxWritePath(targetPath);

    return targetPath;
}
