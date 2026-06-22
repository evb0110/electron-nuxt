import {
    basename,
    extname,
} from 'path';
import {
    saveDocxAs,
    savePdfAs,
    savePdfDataAs,
    savePdfDialog,
} from '@electron/features/documents/main/documentSave.service';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';
import { beginSerializedPdfSaveAs } from '@electron/features/documents/main/serializedPdfPersistence';
import type { IBeginSerializedPdfSaveAsResult } from '@electron/features/documents/serializedPdfPersistenceContract';
import { getWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { te } from '@electron/te';
import { normalizePdfSaveAsOptions } from '@electron/features/documents/main/pdfSaveAsOptimization';

export async function handleSavePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    options?: unknown,
) {
    return savePdfAs(event, workingPath, normalizePdfSaveAsOptions(options), showSaveDialogWithExtension);
}

export async function handleSavePdfDataAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    data: unknown,
    options?: unknown,
): Promise<{
    path: string | null;
    validation: IPdfValidationResult | null;
}> {
    return savePdfDataAs(event, workingPath, data, normalizePdfSaveAsOptions(options), showSaveDialogWithExtension);
}

export async function handleBeginSavePdfDataAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    totalBytes: number,
    options?: unknown,
): Promise<IBeginSerializedPdfSaveAsResult> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return {
            sessionId: null,
            path: null,
        };
    }
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
        throw new Error('Working copy path is not managed');
    }
    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, event.sender.id)?.originalPath;
    const suggestedName = originalPath
        ? basename(originalPath)
        : normalizedWorkingPath
            ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
            : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(event, {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });

    return beginSerializedPdfSaveAs(event, workingPath, totalBytes, targetPath, normalizePdfSaveAsOptions(options));
}

export async function handleSavePdfDialog(
    event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
) {
    return savePdfDialog(event, suggestedName, showSaveDialogWithExtension);
}

export async function handleSaveDocxAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
) {
    return saveDocxAs(event, workingPath, showSaveDialogWithExtension);
}
