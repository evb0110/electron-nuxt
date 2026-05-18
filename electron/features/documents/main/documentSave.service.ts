import { existsSync } from 'fs';
import {
    copyFile,
    rm,
    writeFile,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
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
import { normalizeIpcWritePayload } from '@electron/features/documents/main/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';

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

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath)) {
        throw new Error('Working copy path is not managed');
    }
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
        const validation = await validatePdfFile(normalizedWorkingPath);
        if (!validation.isValid) {
            throw new Error('Working copy is not a valid PDF');
        }

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

export async function savePdfDataAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: string,
    data: unknown,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
): Promise<{
    path: string | null;
    validation: IPdfValidationResult | null;
}> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return {
            path: null,
            validation: null,
        };
    }

    const payload = normalizeIpcWritePayload(data);
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
        return {
            path: null,
            validation: null,
        };
    }

    const tempPath = makeSiblingTempPath(targetPath);
    let replaced = false;
    try {
        await writeFile(tempPath, payload);
        const validation = await validatePdfFile(tempPath);
        if (!validation.isValid) {
            return {
                path: null,
                validation,
            };
        }

        await atomicReplace(tempPath, targetPath);
        replaced = true;
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath)) {
            throw new Error('Working copy path is not managed');
        }
        await copyFile(targetPath, normalizedWorkingPath);
        setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath);
        allowOpenPath(targetPath, event.sender);
        await addRecentFile(targetPath);
        updateRecentFilesMenu();

        return {
            path: targetPath,
            validation,
        };
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
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
