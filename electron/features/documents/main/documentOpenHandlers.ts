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
} from '@electron/image/pdfConversion';
import { PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS } from '@electron/image/pdfCombineShared';
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
import type { TOpenBatchProgressOperation } from '@contracts/electronApiDocuments';
import { getErrorMessage } from '@electron/utils/error';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import {
    DOCUMENTS_EVENT_CHANNELS,
    type TOpenBatchProgressPayload,
    type TOpenFileResult,
} from '@electron/features/documents/contract';
import { openInputPaths } from '@electron/features/documents/main/openInputPaths.service';
import {
    errorWithDetails,
    showOpenDocumentDialogForContext,
} from '@electron/features/documents/main/documentDialogCommon';
import type {
    IDocumentsDialogContext,
    IDocumentsWebContentsContext,
} from '@electron/features/documents/documentsService';

const logger = createLogger('documents-dialogs');
const MAX_DIRECT_OPEN_BATCH_PATHS = 512;

function createOpenBatchProgressReporter(
    sender: Electron.WebContents,
    requestId: string,
    operation: TOpenBatchProgressOperation,
) {
    const pump = createIpcProgressPump<TOpenBatchProgressPayload>({
        channel: DOCUMENTS_EVENT_CHANNELS.openDocumentDirectBatchProgress,
        getTarget: () => sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.processed >= payload.total,
        onError: error => {
            logger.debug(`Failed to send open-batch progress update: ${String(error)}`);
        },
    });
    return (progress: ICreatePdfFromInputPathsProgress) => {
        pump.enqueue({
            operation,
            requestId,
            ...progress,
        });
    };
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
    context: IDocumentsWebContentsContext,
    filePath: unknown,
): Promise<TOpenFileResult | null> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        logger.warn('openDocumentDirect received empty path');
        return null;
    }

    let normalizedPath: TOpenPath;
    try {
        normalizedPath = requireOpenPath(filePath, context.sender);
    } catch {
        const recentOpenPath = await allowRecentFileOpenPath(filePath, context.sender);
        if (!recentOpenPath) {
            logRejectedOpenPath(filePath);
            throw new Error(te('errors.file.invalid'));
        }
        normalizedPath = recentOpenPath;
    }

    logger.info(`openDocumentDirect request: ${normalizedPath}`);
    try {
        const result = await openInputPaths([normalizedPath], {}, context.sender);
        logger.info(`openDocumentDirect result for ${normalizedPath}: ${result?.kind ?? 'null'}`);
        return result;
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDirectBatch(
    context: IDocumentsWebContentsContext,
    filePaths: unknown,
    requestId?: string,
): Promise<TOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }
    if (filePaths.length > MAX_DIRECT_OPEN_BATCH_PATHS) {
        throw new Error(`Open batch exceeds maximum size (${MAX_DIRECT_OPEN_BATCH_PATHS})`);
    }

    try {
        const normalizedPaths = normalizeNonEmptyStringPaths(filePaths)
            .map(path => requireOpenPath(path, context.sender));

        const normalizedRequestId = normalizeOptionalIpcRequestId(requestId) ?? '';
        const options = normalizedRequestId
            ? {onCombineProgress: createOpenBatchProgressReporter(context.sender, normalizedRequestId, 'document-open')}
            : {};
        return await openInputPaths(normalizedPaths, options, context.sender);
    } catch (err) {
        logger.error(`Failed to create working copy from batch: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    const result = await showOpenDocumentDialogForContext(context, {
        title: te('dialogs.openDocument'),
        extensions: [
            'pdf',
            'djvu',
            'djv',
            ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths, {}, context.sender);
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenFolderDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    const dialogOptions = {
        title: te('dialogs.openFolder'),
        properties: ['openDirectory'],
    } satisfies Electron.OpenDialogOptions;

    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
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
        return await openInputPaths(sortedSupportedPaths, {}, context.sender);
    } catch (err) {
        logger.error(`Failed to open folder contents: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenCombineDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    const result = await showOpenDocumentDialogForContext(context, {
        title: te('dialogs.combineFiles'),
        extensions: [
            'pdf',
            ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths, {}, context.sender);
    } catch (err) {
        logger.error(`Failed to combine files: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenImageDialog(context: IDocumentsDialogContext) {
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
    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const imagePath = result.filePaths[0] ?? null;
    if (imagePath) {
        allowOpenPath(imagePath, context.sender);
    }
    return imagePath;
}
