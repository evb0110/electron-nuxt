import { dialog } from 'electron';
import { existsSync } from 'fs';
import {
    basename,
    extname,
} from 'path';
import type { ICropMargins } from '@contracts/shared';
import {
    normalizeCropMargins,
    normalizeNonEmptyStringPaths,
} from '@contracts/shared';
import type { TOpenBatchProgressOperation } from '@contracts/electronApiDocuments';
import type {
    IPageOpsMutationOptions,
    IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import {
    DOCUMENTS_EVENT_CHANNELS,
    type TOpenBatchProgressPayload,
} from '@electron/features/documents/contract';
import { te } from '@electron/te';
import { PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS } from '@electron/image/pdfCombineShared';
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
    verifyPdfStructureStrict,
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
import { assertOpenInputPathCount } from '@electron/features/documents/public';
import {enqueueWorkingCopyMutation} from '@electron/file-access/workingCopyMutationQueue';
import type { IWorkingCopyMutationOperation } from '@electron/file-access/workingCopyMutationQueue';
import { transitionWorkingCopyContentRevision } from '@electron/file-access/documentRevisionStore';
import {
    awaitPageIdentityStoreInitialization,
    commitPageIdentityDelta,
    createDeleteIdentityDelta,
    createIdentityDelta,
    createInsertIdentityDelta,
    createReorderIdentityDelta,
} from '@electron/file-access/pageIdentityStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import type { IPageOpsOperationContext } from '@electron/features/page-ops/ports';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { ICreatePdfFromInputPathsProgress } from '@electron/image/pdfConversion';
import {applyPageMetadataRemap} from '@electron/features/page-ops/main/pageMetadataRemap';

function createOpenBatchProgressReporter(
    context: IPageOpsOperationContext,
    requestId: string,
    operation: TOpenBatchProgressOperation,
) {
    const pump = createIpcProgressPump<TOpenBatchProgressPayload>({
        channel: DOCUMENTS_EVENT_CHANNELS.openDocumentDirectBatchProgress,
        getTarget: () => context.sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.processed >= payload.total,
    });
    return (progress: ICreatePdfFromInputPathsProgress) => {
        pump.enqueue({
            operation,
            requestId,
            ...progress,
        });
    };
}

function createNativeOperationOptions(operation: IWorkingCopyMutationOperation) {
    return {
        signal: operation.signal,
        cancelGroup: operation.cancelGroup,
    };
}

async function transitionPageMutation<T>(input: {
    workingCopyPath: string;
    senderId?: number;
    options?: IPageOpsMutationOptions | undefined;
    operation: IWorkingCopyMutationOperation;
    mutate: () => Promise<{
        value: T;
        delta: IPageIdentityDelta
    }>;
}) {
    await awaitPageIdentityStoreInitialization(input.workingCopyPath);
    const values: T[] = [];
    let committedDelta: IPageIdentityDelta | null = null;
    const documentRevision = await transitionWorkingCopyContentRevision(
        input.workingCopyPath,
        'page-ops',
        async nextRevision => {
            const mutation = await input.mutate();
            await applyPageMetadataRemap({
                workingCopyPath: input.workingCopyPath,
                delta: mutation.delta,
                ...(input.options?.metadataSnapshot
                    ? {metadataSnapshot: input.options.metadataSnapshot}
                    : {}),
                signal: input.operation.signal,
                cancelGroup: input.operation.cancelGroup,
            });
            const actualPageCount = await getPdfPageCount(
                input.workingCopyPath,
                createNativeOperationOptions(input.operation),
            );
            if (mutation.delta.pages.length !== actualPageCount) {
                throw new Error(`Page operation reopen verification failed: predicted ${mutation.delta.pages.length}, received ${actualPageCount}`);
            }
            await verifyPdfStructureStrict(
                input.workingCopyPath,
                createNativeOperationOptions(input.operation),
            );
            await commitPageIdentityDelta(input.workingCopyPath, mutation.delta, nextRevision);
            committedDelta = mutation.delta;
            values.push(mutation.value);
        },
        input.senderId,
    );
    if (values.length !== 1) throw new Error('Page operation did not publish a result');
    if (!committedDelta) throw new Error('Page operation did not publish an identity delta');
    const value = values[0]!;
    return {
        value,
        documentRevision,
        pageIdentityDelta: committedDelta,
    };
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

function validateExpectedTotalPages(totalPages: unknown) {
    if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    return totalPages;
}

export async function handlePageOpsDelete(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const mainTotalPages = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageNumbers(pages, 'deletePages', {
            totalPages: mainTotalPages,
            requireUnique: true,
        });
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await deletePages(queuedWorkingCopyPath, pages, expectedTotalPages, context.senderId, nativeOptions),
                delta: createDeleteIdentityDelta(expectedTotalPages, pages),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

export async function handlePageOpsExtract(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: number[],
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageNumbers(pages, 'extractPages', {requireUnique: true});

    const baseName = basename(normalizedWorkingCopyPath, extname(normalizedWorkingCopyPath));
    const rangeLabel = formatPageRange(pages);
    const suggestedName = `${baseName} (${rangeLabel}).pdf`;
    const dialogOptions = {
        title: te('dialogs.extractPages'),
        defaultPath: suggestedName,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = context.parentWindow
        ? await dialog.showSaveDialog(context.parentWindow, dialogOptions)
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

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await extractPages(queuedWorkingCopyPath, destPath, pages, createNativeOperationOptions(operation));
    });
    allowOpenPath(destPath, context.sender);
    return {
        success: true,
        destPath,
    };
}

export async function handlePageOpsReorder(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    newOrder: number[],
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageNumbers(newOrder, 'reorderPages', {requireUnique: true});
    validateReorderPermutation(newOrder);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const actualPageCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        validatePageNumbers(newOrder, 'reorderPages', {
            requireUnique: true,
            totalPages: actualPageCount,
        });
        validateReorderPermutation(newOrder, actualPageCount);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await reorderPages(queuedWorkingCopyPath, newOrder, context.senderId, nativeOptions),
                delta: createReorderIdentityDelta(actualPageCount, newOrder),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

export async function handlePageOpsInsert(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    options?: IPageOpsMutationOptions,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, context.senderId);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const dialogOptions = {
        title: te('dialogs.insertPagesFromPdf'),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ] as Array<'openFile' | 'multiSelections'>,
    };
    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return {
            success: false,
            canceled: true,
        };
    }
    assertOpenInputPathCount(result.filePaths);
    allowOpenPaths(result.filePaths, context.sender);
    const trustedSourcePaths = normalizeNonEmptyStringPaths(result.filePaths)
        .map(path => requireOpenPath(path, context.sender));

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const beforeCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await insertPagesFromSourcePaths(queuedWorkingCopyPath, insertArgs.totalPages, trustedSourcePaths, insertArgs.afterPage, context.senderId, undefined, nativeOptions);
                const afterCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
                return {
                    value: undefined,
                    delta: createInsertIdentityDelta(beforeCount, insertArgs.afterPage, afterCount - beforeCount),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

export async function handlePageOpsRotate(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
    angle: TRotationAngle,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    validatePageNumbers(pages, 'rotatePages', {requireUnique: true});

    if (![
        90,
        180,
        270,
    ].includes(angle)) {
        throw new Error(`Invalid rotation angle: ${angle}`);
    }

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const mainTotalPages = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageNumbers(pages, 'rotatePages', {
            totalPages: mainTotalPages,
            requireUnique: true,
        });
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await rotatePages(queuedWorkingCopyPath, pages, angle, context.senderId, nativeOptions);
                return {
                    value: undefined,
                    delta: createIdentityDelta(mainTotalPages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

export async function handlePageOpsInsertFile(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    sourcePaths: string[],
    requestId?: string,
    options?: IPageOpsMutationOptions,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, context.senderId);
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        throw new Error('Invalid source paths');
    }
    assertOpenInputPathCount(sourcePaths);
    const trustedSourcePaths = normalizeNonEmptyStringPaths(sourcePaths)
        .map(path => requireOpenPath(path, context.sender));
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId) ?? '';
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const beforeCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await insertPagesFromSourcePaths(queuedWorkingCopyPath, insertArgs.totalPages, trustedSourcePaths, insertArgs.afterPage, context.senderId, normalizedRequestId
                    ? createOpenBatchProgressReporter(context, normalizedRequestId, 'page-insert')
                    : undefined, nativeOptions);
                const afterCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
                return {
                    value: undefined,
                    delta: createInsertIdentityDelta(beforeCount, insertArgs.afterPage, afterCount - beforeCount),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

export async function handlePageOpsCrop(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
    margins: ICropMargins,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    validatePageNumbers(pages, 'cropPages', {requireUnique: true});
    const normalizedMargins = normalizeCropMargins(margins);

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const mainTotalPages = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageNumbers(pages, 'cropPages', {
            totalPages: mainTotalPages,
            requireUnique: true,
        });
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await cropPages(queuedWorkingCopyPath, pages, normalizedMargins, context.senderId, operation.signal);
                return {
                    value: undefined,
                    delta: createIdentityDelta(mainTotalPages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

export async function handlePageOpsRemoveCrop(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    validatePageNumbers(pages, 'removeCrop', {requireUnique: true});

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const mainTotalPages = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageNumbers(pages, 'removeCrop', {
            totalPages: mainTotalPages,
            requireUnique: true,
        });
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await removeCropFromPages(queuedWorkingCopyPath, pages, context.senderId, operation.signal);
                return {
                    value: undefined,
                    delta: createIdentityDelta(mainTotalPages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

export async function handlePageOpsGetPageGeometry(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pageNumber: number,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error('Invalid page number');
    }

    return getPageGeometry(normalizedWorkingCopyPath, pageNumber, context.senderId);
}
