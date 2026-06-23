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
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    if (!await ensureWorkingCopyDirectory(resolvedPath, event.sender?.id)) {
        throw new Error('Invalid file path: writes require a managed working copy');
    }
    return enqueueWorkingCopyMutation(resolvedPath, async () => {
        if (!await ensureWorkingCopyDirectory(resolvedPath, event.sender?.id)) {
            throw new Error('Invalid file path: writes require a managed working copy');
        }
        try {
            await writeFileAtomic(resolvedPath, payload);
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            if (!await ensureWorkingCopyDirectory(resolvedPath, event.sender?.id)) {
                throw new Error('Invalid file path: writes require a managed working copy');
            }
            await writeFileAtomic(resolvedPath, payload);
        }
        return true;
    });
}

export async function handleReplaceWorkingCopyFromPath(
    event: Electron.IpcMainInvokeEvent,
    workingCopyPath: unknown,
    sourcePath: unknown,
) {
    const normalizedWorkingCopyPath = normalizeNonEmptyPath(workingCopyPath);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);

    const resolvedWorkingCopyPath = await resolveAllowedWritePath(normalizedWorkingCopyPath);
    if (!resolvedWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, event.sender?.id)) {
        throw new Error('Invalid file path: writes require a managed working copy');
    }

    const resolvedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!resolvedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    assertOcrPdfResultSourcePath(resolvedSourcePath, event.sender.id);

    return enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
        if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, event.sender?.id)) {
            throw new Error('Invalid file path: writes require a managed working copy');
        }
        const shouldRefreshOriginalSaveBase = await shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
            resolvedWorkingCopyPath,
            event.sender.id,
        );
        try {
            await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            if (!await ensureWorkingCopyDirectory(resolvedWorkingCopyPath, event.sender?.id)) {
                throw new Error('Invalid file path: writes require a managed working copy');
            }
            await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
        }
        if (shouldRefreshOriginalSaveBase) {
            refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, event.sender.id);
        }
        return true;
    });
}

export async function handleFileWriteDocx(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, event.sender.id)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
