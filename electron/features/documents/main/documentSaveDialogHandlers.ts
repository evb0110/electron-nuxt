import {
    saveDocxAs,
    savePdfAs,
    savePdfDialog,
} from '@electron/features/documents/main/documentSave.service';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';

export async function handleSavePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    return savePdfAs(event, workingPath, showSaveDialogWithExtension);
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
