import {
    BrowserWindow,
    ipcMain,
    dialog,
} from 'electron';
import type { IpcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    existsSync,
    realpathSync,
} from 'fs';
import {
    rename,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    extname,
    join,
    resolve,
} from 'path';
import {
    createPdfFromInputPaths,
    isPdfOrImagePath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-conversion';
import { isAllowedWritePath } from '@electron/utils/path-validator';
import {
    deletePages,
    extractPages,
    reorderPages,
    rotatePages,
} from '@electron/page-ops/qpdf';
import type { TRotationAngle } from '@electron/page-ops/qpdf';
import { createLogger } from '@electron/utils/logger';
import { te } from '@electron/i18n';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';

const log = createLogger('page-ops-ipc');
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const workingCopyMutationQueue = new Map<string, Promise<void>>();

function enqueueWorkingCopyMutation<T>(
    workingCopyPath: string,
    operation: () => Promise<T>,
) {
    const previousTail = workingCopyMutationQueue.get(workingCopyPath) ?? Promise.resolve();
    const operationPromise = previousTail.then(operation);

    const nextTail = operationPromise
        .then(() => undefined, () => undefined)
        .finally(() => {
            if (workingCopyMutationQueue.get(workingCopyPath) === nextTail) {
                workingCopyMutationQueue.delete(workingCopyPath);
            }
        });

    workingCopyMutationQueue.set(workingCopyPath, nextTail);
    return operationPromise;
}

function canonicalizePath(path: string) {
    const resolvedPath = resolve(path);
    try {
        return realpathSync.native(resolvedPath);
    } catch {
        return resolvedPath;
    }
}

function validateWorkingCopyPath(path: unknown): string {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid working copy path');
    }

    const canonicalPath = canonicalizePath(normalizedPath);
    if (!isAllowedWritePath(canonicalPath)) {
        throw new Error('Path is outside the allowed working directory');
    }
    if (!existsSync(canonicalPath)) {
        throw new Error(`Working copy not found: ${canonicalPath}`);
    }

    return canonicalPath;
}

function formatPageRange(pages: number[]) {
    const sorted = [...pages].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
        const start = sorted[i]!;
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
            end = sorted[++i]!;
        }
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        i++;
    }
    return `p${parts.join(',')}`;
}

function validatePageNumbers(
    pages: unknown,
    label: string,
    options: {
        totalPages?: number;
        requireUnique?: boolean;
    } = {},
): asserts pages is number[] {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`${label}: must be a non-empty array of page numbers`);
    }

    const pageSet = new Set<number>();
    for (const p of pages) {
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) {
            throw new Error(`${label}: invalid page number ${p}`);
        }
        if (
            typeof options.totalPages === 'number'
            && Number.isInteger(options.totalPages)
            && options.totalPages > 0
            && p > options.totalPages
        ) {
            throw new Error(`${label}: page number ${p} is out of range 1-${options.totalPages}`);
        }
        if (options.requireUnique && pageSet.has(p)) {
            throw new Error(`${label}: duplicate page number ${p}`);
        }
        pageSet.add(p);
    }
}

function validateReorderPermutation(newOrder: number[]) {
    const maxPage = newOrder.length;
    for (let pageNumber = 1; pageNumber <= maxPage; pageNumber += 1) {
        if (!newOrder.includes(pageNumber)) {
            throw new Error(`reorderPages: missing page ${pageNumber} in reorder payload`);
        }
    }
}

async function handlePageOpsDelete(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    validatePageNumbers(pages, 'deletePages', {
        totalPages,
        requireUnique: true,
    });

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        return deletePages(queuedWorkingCopyPath, pages, totalPages);
    });
    return {
        success: true,
        pageCount: result.pageCount,
    };
}

async function handlePageOpsExtract(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(pages, 'extractPages', {requireUnique: true});

    const baseName = basename(normalizedWorkingCopyPath, extname(normalizedWorkingCopyPath));
    const rangeLabel = formatPageRange(pages);
    const suggestedName = `${baseName} (${rangeLabel}).pdf`;
    const parentWindow = BrowserWindow.getFocusedWindow();
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
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        await extractPages(queuedWorkingCopyPath, destPath, pages);
    });
    return {
        success: true,
        destPath, 
    };
}

async function handlePageOpsReorder(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    newOrder: number[],
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(newOrder, 'reorderPages', {requireUnique: true});
    validateReorderPermutation(newOrder);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        return reorderPages(queuedWorkingCopyPath, newOrder);
    });
    return {
        success: true,
        pageCount: result.pageCount,
    };
}

async function handlePageOpsInsert(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);

    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    if (!Number.isSafeInteger(afterPage) || afterPage < 0 || afterPage > totalPages) {
        throw new Error('Invalid afterPage');
    }

    const parentWindow = BrowserWindow.getFocusedWindow();
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

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        await insertPagesFromSourcePaths(queuedWorkingCopyPath, totalPages, result.filePaths, afterPage);
    });
    return {success: true};
}

async function prepareInsertionSourcePdf(
    workingCopyPath: string,
    sourcePaths: string[],
) {
    const normalizedPaths = sourcePaths
        .filter((path): path is string => typeof path === 'string')
        .map(path => path.trim())
        .filter(path => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('At least one source file is required');
    }

    for (const sourcePath of normalizedPaths) {
        if (!existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }
        if (!isPdfOrImagePath(sourcePath)) {
            throw new Error(`Unsupported source file type: ${sourcePath}`);
        }
    }

    if (normalizedPaths.length === 1 && extname(normalizedPaths[0]!).toLowerCase() === '.pdf') {
        return {
            sourcePdfPath: normalizedPaths[0]!,
            cleanup: async () => {},
        };
    }

    const mergedPdf = await createPdfFromInputPaths(normalizedPaths);
    const tempSourcePdfPath = join(
        workingCopyPath,
        '..',
        `insert-source-${randomUUID()}.pdf`,
    );
    await writeFile(tempSourcePdfPath, mergedPdf);

    return {
        sourcePdfPath: tempSourcePdfPath,
        cleanup: async () => {
            try {
                if (existsSync(tempSourcePdfPath)) {
                    await unlink(tempSourcePdfPath);
                }
            } catch (cleanupError) {
                log.debug(`Failed to cleanup insertion source PDF "${tempSourcePdfPath}": ${
                    cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`);
            }
        },
    };
}

async function insertPagesFromSourcePaths(
    workingCopyPath: string,
    totalPages: number,
    sourcePaths: string[],
    afterPage: number,
) {
    const qpdf = getNativeToolPaths().qpdf;
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${randomUUID()}`;
    const tempPath = join(dir, `${id}.pdf`);

    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(workingCopyPath, sourcePaths);

    try {
        const pagesArgs: string[] = [];

        if (afterPage >= 1) {
            pagesArgs.push(workingCopyPath, `1-${afterPage}`);
        }

        pagesArgs.push(sourcePdfPath, '1-z');

        if (afterPage < totalPages) {
            pagesArgs.push(workingCopyPath, `${afterPage + 1}-${totalPages}`);
        }

        const args = [
            workingCopyPath,
            '--pages',
            ...pagesArgs,
            '--',
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(insert-pages)',
        });
        await rename(tempPath, workingCopyPath);
    } catch (err) {
        try {
            if (existsSync(tempPath)) {
                await unlink(tempPath);
            }
        } catch (cleanupError) {
            log.debug(`Failed to cleanup temporary insert output "${tempPath}": ${
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`);
        }
        throw err;
    } finally {
        await cleanup();
    }
}

async function handlePageOpsRotate(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(pages, 'rotatePages', {requireUnique: true});

    if (![
        90,
        180,
        270,
    ].includes(angle)) {
        throw new Error(`Invalid rotation angle: ${angle}`);
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        await rotatePages(queuedWorkingCopyPath, pages, angle);
    });
    return {success: true};
}

async function handlePageOpsInsertFile(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    sourcePaths: string[],
) {
    const normalizedWorkingCopyPath = validateWorkingCopyPath(workingCopyPath);

    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    if (!Number.isSafeInteger(afterPage) || afterPage < 0 || afterPage > totalPages) {
        throw new Error('Invalid afterPage');
    }
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        throw new Error('Invalid source paths');
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async () => {
        const queuedWorkingCopyPath = validateWorkingCopyPath(normalizedWorkingCopyPath);
        await insertPagesFromSourcePaths(queuedWorkingCopyPath, totalPages, sourcePaths, afterPage);
    });
    return {success: true};
}

interface IIpcMainHandleRegistrar {handle: IpcMain['handle'];}

export function registerPageOpsHandlers(registrar: IIpcMainHandleRegistrar = ipcMain) {
    registrar.handle('page-ops:delete', handlePageOpsDelete);
    registrar.handle('page-ops:extract', handlePageOpsExtract);
    registrar.handle('page-ops:reorder', handlePageOpsReorder);
    registrar.handle('page-ops:insert', handlePageOpsInsert);
    registrar.handle('page-ops:insert-file', handlePageOpsInsertFile);
    registrar.handle('page-ops:rotate', handlePageOpsRotate);
}
