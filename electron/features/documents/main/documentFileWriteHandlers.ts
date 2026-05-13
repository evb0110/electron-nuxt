import { writeFile } from 'fs/promises';
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
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await ensureWorkingCopyDirectory(resolvedPath);
    try {
        await writeFileAtomic(resolvedPath, payload);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
        }
        await ensureWorkingCopyDirectory(resolvedPath);
        await writeFileAtomic(resolvedPath, payload);
    }
    return true;
}

export async function handleFileWriteDocx(
    _event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
    data: unknown,
): Promise<boolean> {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFile(resolve(normalizedPath), payload);
    return true;
}
