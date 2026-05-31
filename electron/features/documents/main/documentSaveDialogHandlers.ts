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
import { getWorkingCopyOriginalPath } from '@electron/ipc/workingCopyStore';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import { te } from '@electron/i18n';

export async function handleSavePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    return savePdfAs(event, workingPath, showSaveDialogWithExtension);
}

export async function handleSavePdfDataAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    data: unknown,
): Promise<{
    path: string | null;
    validation: IPdfValidationResult | null;
}> {
    return savePdfDataAs(event, workingPath, data, showSaveDialogWithExtension);
}

export async function handleBeginSavePdfDataAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    totalBytes: number,
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

    return beginSerializedPdfSaveAs(event, workingPath, totalBytes, targetPath);
}

export async function handleSavePdfDialog(
    event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
): Promise<string | null> {
    return savePdfDialog(event, suggestedName, showSaveDialogWithExtension);
}

export async function handleSaveDocxAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    return saveDocxAs(event, workingPath, showSaveDialogWithExtension);
}
