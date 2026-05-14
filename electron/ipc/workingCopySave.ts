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
import { normalizeIpcWritePayload } from '@electron/features/documents/main/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';

function getValidatedOriginalPath(workingPath: string) {
    const originalPath = getWorkingCopyOriginalPath(workingPath)?.originalPath;

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
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath);

    try {
        await ensureWorkingCopyDirectory(normalizedWorkingPath);
        const validation = await replaceOriginalWithValidatedTemp(
            originalPath,
            tempPath => copyFile(normalizedWorkingPath, tempPath),
        );
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
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    data: unknown,
): Promise<IPdfValidationResult> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath);
    const payload = normalizeIpcWritePayload(data);

    try {
        await ensureWorkingCopyDirectory(normalizedWorkingPath);
        const validation = await replaceOriginalWithValidatedTemp(
            originalPath,
            tempPath => writeFile(tempPath, payload),
        );
        if (!validation.isValid) {
            return validation;
        }

        await copyFile(originalPath, normalizedWorkingPath);
        return validation;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}
