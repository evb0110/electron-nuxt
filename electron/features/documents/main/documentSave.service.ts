import { existsSync } from 'fs';
import {
    copyFile,
    rm,
} from 'fs/promises';
import {
    basename,
    extname,
} from 'path';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { allowDocxWritePath } from '@electron/ipc/docxExportPaths';
import { allowDjvuWritePath } from '@electron/djvu/exportPaths';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/ipc/workingCopyStore';
import { allowOpenPath } from '@electron/ipc/openPathCapabilities';
import { te } from '@electron/i18n';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';

export type TShowSaveDialogWithExtension = (
    event: Electron.IpcMainInvokeEvent,
    options: {
        title: string;
        defaultPath: string;
        filterName: string;
        extension: string;
    },
) => Promise<string | null>;

export async function savePdfAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return null;
    }

    const extension = extname(normalizedWorkingPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    await ensureWorkingCopyDirectory(normalizedWorkingPath);
    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }

    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath)?.originalPath;
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(normalizedWorkingPath);

    const targetPath = await showSaveDialogWithExtension(event, {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
    }

    const tempPath = makeSiblingTempPath(targetPath);
    let replaced = false;
    try {
        await copyFile(normalizedWorkingPath, tempPath);
        await atomicReplace(tempPath, targetPath);
        replaced = true;
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }

    setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath);
    allowOpenPath(targetPath, event.sender);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return targetPath;
}

export async function savePdfDialog(
    event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
): Promise<string | null> {
    const normalizedSuggestedName = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim()
        : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(event, {
        title: te('dialogs.savePdf'),
        defaultPath: normalizedSuggestedName.endsWith('.pdf') ? normalizedSuggestedName : `${normalizedSuggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
    }

    allowDjvuWritePath(targetPath, event.sender.id);

    return targetPath;
}

export async function saveDocxAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';

    const suggestedBase = normalizedWorkingPath
        ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
        : 'ocrText';

    const targetPath = await showSaveDialogWithExtension(event, {
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filterName: te('dialogs.wordDocuments'),
        extension: 'docx',
    });
    if (!targetPath) {
        return null;
    }

    allowDocxWritePath(targetPath);

    return targetPath;
}
