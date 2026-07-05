import { existsSync } from 'fs';
import {
    rm,
    writeFile,
} from 'fs/promises';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    basename,
    extname,
} from 'path';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { allowDocxWritePath } from '@electron/file-access/docxExportPaths';
import { allowDjvuWritePath } from '@electron/djvu/exportPaths';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { normalizeIpcWritePayload } from '@electron/features/documents/main/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { optimizePdfForSaveAs } from '@electron/features/documents/main/pdfSaveAsOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsService';
import {
    markWorkingCopySyncRequired,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import { assertQueuedWorkingCopyMutationPreconditions } from '@electron/file-access/documentMutationGuards';

export type TShowSaveDialogWithExtension = (
    context: IDocumentsDialogContext,
    options: {
        title: string;
        defaultPath: string;
        filterName: string;
        extension: string;
    },
) => Promise<string | null>;

function normalizeExpectedDocumentRevisionToken(options?: IPdfSerializedSaveOptions | null): TDocumentRevisionToken | null {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined || token === null) {
        return null;
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return token.trim();
}

export async function savePdfAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    options: IPdfSaveAsOptions | undefined,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
    revisionOptions?: IDocumentMutationRevisionOptions,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return null;
    }

    const extension = extname(normalizedWorkingPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, context.senderId)?.originalPath;
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(normalizedWorkingPath);

    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
    }

    await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(normalizedWorkingPath, expectedDocumentRevisionToken);
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
            throw new Error('Working copy path is not managed');
        }
        if (!existsSync(normalizedWorkingPath)) {
            throw new Error(`File not found: ${normalizedWorkingPath}`);
        }

        const tempPath = makeSiblingTempPath(targetPath);
        let replaced = false;
        try {
            const validation = await validatePdfFile(normalizedWorkingPath);
            if (!validation.isValid) {
                throw new Error('Working copy is not a valid PDF');
            }

            await copyFileCopyOnWrite(normalizedWorkingPath, tempPath);
            await optimizePdfForSaveAs(tempPath, options);
            await atomicReplace(tempPath, targetPath);
            replaced = true;
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
    });

    setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath, context.senderId);
    allowOpenPath(targetPath, context.sender);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return targetPath;
}

export async function savePdfDataAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    data: unknown,
    options: IPdfSaveAsOptions | undefined,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
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
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(serializedSaveOptions);

    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, context.senderId)?.originalPath;
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(normalizedWorkingPath);

    const targetPath = await showSaveDialogWithExtension(context, {
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
        const optimizedValidation = await optimizePdfForSaveAs(tempPath, options);
        const committedValidation = optimizedValidation ?? validation;
        const resultRef: {current: {
            path: string | null;
            validation: IPdfValidationResult;
        } | null;} = { current: null };

        await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
                throw new Error('Working copy path is not managed');
            }
            await assertQueuedWorkingCopyMutationPreconditions(
                normalizedWorkingPath,
                expectedDocumentRevisionToken,
            );
            if (!existsSync(normalizedWorkingPath)) {
                throw new Error(`File not found: ${normalizedWorkingPath}`);
            }
            await atomicReplace(tempPath, targetPath);
            replaced = true;
            try {
                await copyFileCopyOnWrite(targetPath, normalizedWorkingPath);
            } catch (syncError) {
                markWorkingCopySyncRequired(
                    normalizedWorkingPath,
                    `Target file was saved, but the working copy refresh failed: ${syncError instanceof Error ? syncError.message : String(syncError)}`,
                );
                throw syncError;
            }
            await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', context.senderId);
            setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath, context.senderId);
            allowOpenPath(targetPath, context.sender);
            await addRecentFile(targetPath);
            updateRecentFilesMenu();
            resultRef.current = {
                path: targetPath,
                validation: committedValidation,
            };
        });

        const result = resultRef.current;
        return {
            path: result?.path ?? null,
            validation: result?.validation ?? committedValidation,
        };
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function savePdfDialog(
    context: IDocumentsDialogContext,
    suggestedName: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const normalizedSuggestedName = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim()
        : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdf'),
        defaultPath: normalizedSuggestedName.endsWith('.pdf') ? normalizedSuggestedName : `${normalizedSuggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
    }

    allowDjvuWritePath(targetPath, context.sender);

    return targetPath;
}

export async function saveDocxAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';

    const suggestedBase = normalizedWorkingPath
        ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
        : 'ocrText';

    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filterName: te('dialogs.wordDocuments'),
        extension: 'docx',
    });
    if (!targetPath) {
        return null;
    }

    allowDocxWritePath(targetPath, context.sender);

    return targetPath;
}
