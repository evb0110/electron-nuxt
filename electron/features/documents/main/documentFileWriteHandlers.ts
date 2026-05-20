import { resolve } from 'path';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import { consumeAllowedDocxWritePath } from '@electron/ipc/docxExportPaths';
import {
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/features/documents/main/documentFileWriteAtomic';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';

export async function handleFileWrite(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    if (!await ensureWorkingCopyDirectory(resolvedPath, event.sender?.id)) {
        throw new Error('Invalid file path: writes require a managed working copy');
    }
    try {
        await writeFileAtomic(resolvedPath, payload);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
        }
        if (!await ensureWorkingCopyDirectory(resolvedPath, event.sender?.id)) {
            throw new Error('Invalid file path: writes require a managed working copy');
        }
        await writeFileAtomic(resolvedPath, payload);
    }
    return true;
}

export async function handleFileWriteDocx(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, event.sender.id)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
