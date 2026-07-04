import {
    basename,
    extname,
    resolve,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import { markWorkingCopyContentChanged } from '@electron/file-access/documentRevisionStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { consumeAllowedDocxWritePath } from '@electron/file-access/docxExportPaths';
import {
    copyFileAtomic,
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/features/documents/main/documentFileWriteAtomic';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import { findPendingOcrResultFileForPath } from '@electron/ocr/createPendingResultFileStore';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function assertOcrPdfResultSourcePath(resolvedPath: string, senderWebContentsId: number) {
    const fileName = basename(resolvedPath).toLowerCase();
    if (extname(fileName) !== '.pdf') {
        throw new Error('Invalid source path: OCR result must be a PDF');
    }
    if (!fileName.startsWith('ocr-') && !fileName.startsWith('searchable-')) {
        throw new Error('Invalid source path: only OCR result files can replace a working copy');
    }
    if (!findPendingOcrResultFileForPath(senderWebContentsId, resolvedPath)) {
        throw new Error('Invalid source path: OCR result is not owned by this renderer');
    }
}

async function shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
    workingCopyPath: string,
    senderWebContentsId: number,
) {
    const mapping = getWorkingCopyOriginalPath(workingCopyPath, senderWebContentsId);
    if (!mapping) {
        return false;
    }

    return originalPathSaveBaseMatches(workingCopyPath, mapping.originalPath, senderWebContentsId);
}

export async function handleFileWrite(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    if (!await ensureWorkingCopyDirectory(resolvedPath, senderId)) {
        throw new Error('Invalid file path: writes require a managed working copy');
    }
    return enqueueWorkingCopyMutation(resolvedPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(resolvedPath, expectedDocumentRevisionToken);
        if (!await ensureWorkingCopyDirectory(resolvedPath, senderId)) {
            throw new Error('Invalid file path: writes require a managed working copy');
        }
        try {
            await writeFileAtomic(resolvedPath, payload);
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            if (!await ensureWorkingCopyDirectory(resolvedPath, senderId)) {
                throw new Error('Invalid file path: writes require a managed working copy');
            }
            await writeFileAtomic(resolvedPath, payload);
        }
        await markWorkingCopyContentChanged(resolvedPath, 'write', senderId);
        return true;
    });
}

export async function handleReplaceWorkingCopyFromPath(
    context: IDocumentsSenderIdContext,
    workingCopyPath: unknown,
    sourcePath: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedWorkingCopyPath = normalizeNonEmptyPath(workingCopyPath);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedWorkingCopyPath = await resolveAllowedWritePath(normalizedWorkingCopyPath);
    if (!resolvedWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, senderId)) {
        throw new Error('Invalid file path: writes require a managed working copy');
    }

    const resolvedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!resolvedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    assertOcrPdfResultSourcePath(resolvedSourcePath, senderId);

    return enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(
            resolvedWorkingCopyPath,
            expectedDocumentRevisionToken,
        );
        if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, senderId)) {
            throw new Error('Invalid file path: writes require a managed working copy');
        }
        const shouldRefreshOriginalSaveBase = await shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
            resolvedWorkingCopyPath,
            senderId,
        );
        try {
            await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, senderId)) {
                throw new Error('Invalid file path: writes require a managed working copy');
            }
            await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
        }
        if (shouldRefreshOriginalSaveBase) {
            refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, senderId);
        }
        await markWorkingCopyContentChanged(resolvedWorkingCopyPath, 'ocr-apply', senderId);
        return true;
    });
}

export async function handleFileWriteDocx(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, senderId)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
