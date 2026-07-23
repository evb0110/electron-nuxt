import { dialog } from 'electron';
import { opendir } from 'fs/promises';
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
import type {
    TOpenBatchProgressOperation,
    TOpenDocumentDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import { DOCUMENT_MENU_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import { getErrorMessage } from '@electron/utils/error';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import { openInputPaths } from '@electron/features/documents/main/openInputPaths.service';
import { handlePdfOpeningGeometry } from '@electron/features/documents/main/nativePdfPreview';
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
const activeBatchCombines = new Map<string, AbortController>();

export async function collectSupportedFolderPaths(folderPath: string) {
    const supportedPaths: string[] = [];
    const directory = await opendir(folderPath);
    for await (const entry of directory) {
        if (!entry.isFile()) {
            continue;
        }
        const path = join(folderPath, entry.name);
        if (!isSupportedOpenPath(path)) {
            continue;
        }
        supportedPaths.push(path);
        if (supportedPaths.length > MAX_DIRECT_OPEN_BATCH_PATHS) {
            throw new Error(`Open batch exceeds maximum size (${MAX_DIRECT_OPEN_BATCH_PATHS})`);
        }
    }
    return sortBy(
        supportedPaths.map(path => ({
            path,
            name: basename(path),
        })),
        ['name'],
    ).map(entry => entry.path);
}

function isSinglePdfPath(paths: readonly string[]) {
    return paths.length === 1 && /\.pdf$/iu.test(paths[0] ?? '');
}

async function openInputPathsWithGeometryPreflight(
    context: IDocumentsWebContentsContext,
    paths: string[],
) {
    const result = await openInputPaths(paths, {}, context.sender);
    if (result?.kind !== 'pdf' || !isSinglePdfPath(paths)) {
        return result;
    }
    const openingGeometry = await handlePdfOpeningGeometry(context, result.workingPath)
        .catch((error: unknown) => {
            // Geometry improves the opening presentation but must not turn a
            // readable document into a failed open. The viewer can still
            // discover metadata from its managed working copy as a fallback.
            logger.warn(`PDF opening geometry preflight failed: ${getErrorMessage(error)}`);
            return null;
        });
    return openingGeometry
        ? {
            ...result,
            openingGeometry,
        }
        : result;
}

function getBatchCombineKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

export function handleCancelOpenDocumentDirectBatch(
    context: IDocumentsWebContentsContext,
    requestId: string,
) {
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId);
    if (!normalizedRequestId) {
        return false;
    }
    const controller = activeBatchCombines.get(getBatchCombineKey(context.sender.id, normalizedRequestId));
    if (!controller) {
        return false;
    }
    controller.abort(new DOMException('PDF combine was canceled.', 'AbortError'));
    return true;
}

function createOpenBatchProgressReporter(
    sender: Electron.WebContents,
    requestId: string,
    operation: TOpenBatchProgressOperation,
) {
    const pump = createIpcProgressPump<TOpenDocumentDirectBatchProgress>({
        channel: DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels.onOpenDocumentDirectBatchProgress,
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
    const normalizedPath = filePath;
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
    if (typeof filePath !== 'string' || filePath.length === 0) {
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
        const result = await openInputPathsWithGeometryPreflight(context, [normalizedPath]);
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
    batchOptions?: {forceCombine?: boolean},
): Promise<TOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }
    if (filePaths.length > MAX_DIRECT_OPEN_BATCH_PATHS) {
        throw new Error(`Open batch exceeds maximum size (${MAX_DIRECT_OPEN_BATCH_PATHS})`);
    }

    try {
        const normalizedPaths = filePaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
            .map(path => requireOpenPath(path, context.sender));

        const normalizedRequestId = normalizeOptionalIpcRequestId(requestId) ?? '';
        const abortController = batchOptions?.forceCombine && normalizedRequestId
            ? new AbortController()
            : null;
        const combineKey = abortController
            ? getBatchCombineKey(context.sender.id, normalizedRequestId)
            : null;
        if (combineKey && abortController) {
            activeBatchCombines.get(combineKey)?.abort(new Error('Superseded PDF combine request'));
            activeBatchCombines.set(combineKey, abortController);
        }
        const options = normalizedRequestId
            ? {onCombineProgress: createOpenBatchProgressReporter(context.sender, normalizedRequestId, 'document-open')}
            : {};
        try {
            return await openInputPaths(normalizedPaths, {
                ...options,
                forceCombine: batchOptions?.forceCombine === true,
                ...(abortController ? {signal: abortController.signal} : {}),
            }, context.sender);
        } finally {
            if (combineKey && activeBatchCombines.get(combineKey) === abortController) {
                activeBatchCombines.delete(combineKey);
            }
        }
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
        return await openInputPathsWithGeometryPreflight(context, result.filePaths);
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

    let sortedSupportedPaths: string[];
    try {
        sortedSupportedPaths = await collectSupportedFolderPaths(folderPath);
    } catch (err) {
        logger.error(`Failed to read folder contents: ${getErrorMessage(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }

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
