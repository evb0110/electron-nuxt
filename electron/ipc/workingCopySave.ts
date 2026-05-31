import {
    copyFile,
    rm,
    writeFile,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import { getWorkingCopyOriginalPath } from '@electron/ipc/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/ipc/workingCopyValidation';
import { WorkingCopyMissingError } from '@electron/ipc/workingCopyMissingError';
import {
    normalizeIpcWritePayload,
    validatePdfFile,
} from '@electron/features/documents/public';
import { enqueueWorkingCopyMutation } from '@electron/ipc/workingCopyMutationQueue';

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function replaceOriginalWithValidatedTemp(
    originalPath: string,
    writeTemp: (tempPath: string) => Promise<void>,
) {
    const tempPath = makeSiblingTempPath(originalPath);
    let replaced = false;
    try {
        await writeTemp(tempPath);
        const validation = await validatePdfFile(tempPath);
        if (!validation.isValid) {
            return validation;
        }

        await atomicReplace(tempPath, originalPath);
        replaced = true;
        return validation;
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function handleFileSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, event.sender.id);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
                throw new Error('Working copy path is not managed');
            }

            return replaceOriginalWithValidatedTemp(
                originalPath,
                tempPath => copyFile(normalizedWorkingPath, tempPath),
            );
        });
        if (!validation.isValid) {
            throw new Error(`PDF validation failed: ${validation.errors.join('; ')}`);
        }
        return true;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}

export async function handleSerializedPdfSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    data: unknown,
): Promise<IPdfValidationResult> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, event.sender.id);
    const payload = normalizeIpcWritePayload(data);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
                throw new Error('Working copy path is not managed');
            }

            const queuedValidation = await replaceOriginalWithValidatedTemp(
                originalPath,
                tempPath => writeFile(tempPath, payload),
            );
            if (queuedValidation.isValid) {
                await copyFile(originalPath, normalizedWorkingPath);
            }

            return queuedValidation;
        });
        if (!validation.isValid) {
            return validation;
        }

        return validation;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}
