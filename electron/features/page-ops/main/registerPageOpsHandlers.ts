import {
    BrowserWindow,
    dialog,
    ipcMain,
} from 'electron';
import { existsSync } from 'fs';
import {
    basename,
    extname,
} from 'path';
import type { ICropMargins } from '@contracts/shared';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import { PAGE_OPS_CHANNELS } from '@electron/features/page-ops/contract';
import { DOCUMENTS_EVENT_CHANNELS } from '@electron/features/documents/contract';
import { te } from '@electron/te';
import { SUPPORTED_IMAGE_EXTENSIONS } from '@electron/image/pdfConversion';
import {
    cropPages,
    getPageGeometry,
    removeCropFromPages,
} from '@electron/features/page-ops/main/crop';
import {
    deletePages,
    extractPages,
    getPdfPageCount,
    reorderPages,
    rotatePages,
} from '@electron/features/page-ops/main/qpdf';
import type { TRotationAngle } from '@electron/features/page-ops/main/qpdf';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import {
    allowOpenPath,
    allowOpenPaths,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import {
    formatPageRange,
    validatePageNumbers,
    validateReorderPermutation,
} from '@electron/features/page-ops/domain/pageNumbers';
import { insertPagesFromSourcePaths } from '@electron/features/page-ops/main/insertPagesFromSourcePaths.service';
import {
    clearWorkingCopyOcrArtifacts,
    enqueueWorkingCopyMutation,
} from '@electron/file-access/workingCopyMutationQueue';
import type { ICreatePdfFromInputPathsProgress } from '@electron/image/pdfConversion';
import type { TPageOpsIpcMainRegistrar } from '@electron/features/page-ops/ports';

type TOpenBatchProgressPayload = ICreatePdfFromInputPathsProgress & {requestId: string;};

function sendOpenBatchProgress(
    event: Electron.IpcMainInvokeEvent,
    payload: TOpenBatchProgressPayload,
) {
    try {
        event.sender.send(DOCUMENTS_EVENT_CHANNELS.openDocumentDirectBatchProgress, payload);
    } catch {
        // Progress is best effort; the page operation result remains authoritative.
    }
}

async function validateWorkingCopyPath(path: unknown, senderWebContentsId?: number) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid working copy path');
    }

    const isManagedWorkingCopy = await ensureWorkingCopyDirectory(normalizedPath, senderWebContentsId);
    if (!isManagedWorkingCopy) {
        throw new Error('Path is not a managed working copy');
    }

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Path is outside the allowed working directory');
    }
    if (!existsSync(resolvedPath)) {
        throw new Error(`Working copy not found: ${resolvedPath}`);
    }

    return resolvedPath;
}

async function validateQueuedWorkingCopyPath(path: string, senderWebContentsId?: number) {
    return validateWorkingCopyPath(path, senderWebContentsId);
}

async function resolveWorkingCopyPath(path: unknown, senderWebContentsId?: number) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid working copy path');
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderWebContentsId);
    const workingCopyPath = mappedWorkingCopyPath ?? normalizedPath;

    return validateWorkingCopyPath(workingCopyPath, senderWebContentsId);
}

function validateInsertPageArgs(
    workingCopyPath: unknown,
    totalPages: unknown,
    afterPage: unknown,
) {
    const normalizedWorkingCopyPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingCopyPath) {
        throw new Error('Invalid working copy path');
    }

    if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    const normalizedTotalPages = totalPages;
    if (
        typeof afterPage !== 'number'
        || !Number.isSafeInteger(afterPage)
        || afterPage < 0
        || afterPage > normalizedTotalPages
    ) {
        throw new Error('Invalid afterPage');
    }
    const normalizedAfterPage = afterPage;

    return {
        normalizedWorkingCopyPath,
        totalPages: normalizedTotalPages,
        afterPage: normalizedAfterPage,
    };
}

async function handlePageOpsDelete(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        const mainTotalPages = await getPdfPageCount(queuedWorkingCopyPath);
        if (mainTotalPages !== totalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageNumbers(pages, 'deletePages', {
            totalPages: mainTotalPages,
            requireUnique: true,
        });
        const operationResult = await deletePages(queuedWorkingCopyPath, pages, totalPages, event.sender?.id);
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
        return operationResult;
    });
    return {
        success: true,
        pageCount: result.pageCount,
    };
}

async function handlePageOpsExtract(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    validatePageNumbers(pages, 'extractPages', {requireUnique: true});

    const baseName = basename(normalizedWorkingCopyPath, extname(normalizedWorkingCopyPath));
    const rangeLabel = formatPageRange(pages);
    const suggestedName = `${baseName} (${rangeLabel}).pdf`;
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
        title: te('dialogs.extractPages'),
        defaultPath: suggestedName,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    let destPath = result.filePath;
    if (extname(destPath).toLowerCase() !== '.pdf') {
        destPath += '.pdf';
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await extractPages(queuedWorkingCopyPath, destPath, pages);
    });
    allowOpenPath(destPath, event.sender);
    return {
        success: true,
        destPath,
    };
}

async function handlePageOpsReorder(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    newOrder: number[],
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    validatePageNumbers(newOrder, 'reorderPages', {requireUnique: true});
    validateReorderPermutation(newOrder);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        const operationResult = await reorderPages(queuedWorkingCopyPath, newOrder, event.sender?.id);
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
        return operationResult;
    });
    return {
        success: true,
        pageCount: result.pageCount,
    };
}

async function handlePageOpsInsert(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, event.sender?.id);

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
        title: te('dialogs.insertPagesFromPdf'),
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
        ] as Array<'openFile' | 'multiSelections'>,
    };
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return {
            success: false,
            canceled: true,
        };
    }
    allowOpenPaths(result.filePaths, event.sender);
    const trustedSourcePaths = normalizeNonEmptyStringPaths(result.filePaths)
        .map(path => requireOpenPath(path, event.sender));

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await insertPagesFromSourcePaths(
            queuedWorkingCopyPath,
            insertArgs.totalPages,
            trustedSourcePaths,
            insertArgs.afterPage,
            event.sender?.id,
        );
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
    });
    return {success: true};
}

async function handlePageOpsRotate(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    validatePageNumbers(pages, 'rotatePages', {requireUnique: true});

    if (![
        90,
        180,
        270,
    ].includes(angle)) {
        throw new Error(`Invalid rotation angle: ${angle}`);
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await rotatePages(queuedWorkingCopyPath, pages, angle, event.sender?.id);
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
    });
    return {success: true};
}

async function handlePageOpsInsertFile(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    sourcePaths: string[],
    requestId?: string,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, event.sender?.id);
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        throw new Error('Invalid source paths');
    }
    const trustedSourcePaths = normalizeNonEmptyStringPaths(sourcePaths)
        .map(path => requireOpenPath(path, event.sender));
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await insertPagesFromSourcePaths(
            queuedWorkingCopyPath,
            insertArgs.totalPages,
            trustedSourcePaths,
            insertArgs.afterPage,
            event.sender?.id,
            normalizedRequestId
                ? progress => sendOpenBatchProgress(event, {
                    requestId: normalizedRequestId,
                    ...progress,
                })
                : undefined,
        );
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
    });
    return {success: true};
}

async function handlePageOpsCrop(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    validatePageNumbers(pages, 'cropPages', {requireUnique: true});
    if (
        !margins
        || !Number.isFinite(margins.top)
        || !Number.isFinite(margins.bottom)
        || !Number.isFinite(margins.left)
        || !Number.isFinite(margins.right)
        || margins.top < 0
        || margins.bottom < 0
        || margins.left < 0
        || margins.right < 0
    ) {
        throw new Error('Invalid crop margins');
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await cropPages(queuedWorkingCopyPath, pages, margins, event.sender?.id);
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
    });
    return {success: true};
}

async function handlePageOpsRemoveCrop(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    validatePageNumbers(pages, 'removeCrop', {requireUnique: true});

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = await validateQueuedWorkingCopyPath(normalizedWorkingCopyPath, event.sender?.id);
        await removeCropFromPages(queuedWorkingCopyPath, pages, event.sender?.id);
        await clearWorkingCopyOcrArtifacts(queuedWorkingCopyPath);
    });
    return {success: true};
}

async function handlePageOpsGetPageGeometry(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pageNumber: number,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, event.sender?.id);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error('Invalid page number');
    }

    return getPageGeometry(normalizedWorkingCopyPath, pageNumber, event.sender?.id);
}

export function registerPageOpsHandlers(registrar: TPageOpsIpcMainRegistrar = ipcMain) {
    registrar.handle(PAGE_OPS_CHANNELS.delete, handlePageOpsDelete);
    registrar.handle(PAGE_OPS_CHANNELS.extract, handlePageOpsExtract);
    registrar.handle(PAGE_OPS_CHANNELS.reorder, handlePageOpsReorder);
    registrar.handle(PAGE_OPS_CHANNELS.insert, handlePageOpsInsert);
    registrar.handle(PAGE_OPS_CHANNELS.insertFile, handlePageOpsInsertFile);
    registrar.handle(PAGE_OPS_CHANNELS.rotate, handlePageOpsRotate);
    registrar.handle(PAGE_OPS_CHANNELS.crop, handlePageOpsCrop);
    registrar.handle(PAGE_OPS_CHANNELS.removeCrop, handlePageOpsRemoveCrop);
    registrar.handle(PAGE_OPS_CHANNELS.getPageGeometry, handlePageOpsGetPageGeometry);
}
