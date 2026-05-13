import {
    copyFile,
    rm,
} from 'fs/promises';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import { getWorkingCopyOriginalPath } from '@electron/ipc/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/ipc/workingCopyValidation';
import { WorkingCopyMissingError } from '@electron/ipc/workingCopyMissingError';

export async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath)?.originalPath;

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    try {
        await ensureWorkingCopyDirectory(normalizedWorkingPath);
        const tempPath = makeSiblingTempPath(originalPath);
        let replaced = false;
        try {
            await copyFile(normalizedWorkingPath, tempPath);
            await atomicReplace(tempPath, originalPath);
            replaced = true;
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
        return true;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}
