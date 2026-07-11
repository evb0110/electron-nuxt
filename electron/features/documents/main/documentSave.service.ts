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
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
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
import {makeSiblingTempPath} from '@electron/utils/atomicReplace';
import { commitPdfTempFile } from '@electron/features/documents/main/commitPdfTempFile';
import { getErrorMessage } from '@electron/utils/error';
import {normalizeIpcWritePayload} from '@electron/file-access/documentFileWriteAtomic';
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
    const parsedToken = parseDocumentRevisionToken(token);
    if (parsedToken === null) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return parsedToken;
}

function withWorkingCopySyncWarning(validation: IPdfValidationResult, error: unknown): IPdfValidationResult {
    const message = `Saved target file, but failed to refresh the working copy: ${getErrorMessage(error)}`;
    return {
        ...validation,
        isValid: false,
        errors: [
            ...validation.errors,
            message,
        ],
        warnings: [
            ...validation.warnings,
            message,
        ],
    };
}

function markSaveAsWorkingCopySyncRequired(workingPath: string, error: unknown) {
    markWorkingCopySyncRequired(
        workingPath,
        `Target file was saved, but the working copy refresh failed: ${getErrorMessage(error)}`,
    );
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
            const optimizedValidation = await optimizePdfForSaveAs(tempPath, options);
            await commitPdfTempFile(tempPath, targetPath, {ownerId: `pdf-save-as:${context.senderId}`});
            replaced = true;
            try {
                await setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath, context.senderId);
                if (optimizedValidation) {
                    await copyFileCopyOnWrite(targetPath, normalizedWorkingPath);
                    await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', context.senderId);
                }
            } catch (syncError) {
                markSaveAsWorkingCopySyncRequired(normalizedWorkingPath, syncError);
                throw new Error(`Target file was saved, but the working copy refresh failed: ${getErrorMessage(syncError)}`);
            }
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
    });

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
            await commitPdfTempFile(tempPath, targetPath, {ownerId: `pdf-data-save-as:${context.senderId}`});
            replaced = true;
            let resultValidation = committedValidation;
            try {
                await setWorkingCopyOriginalPath(normalizedWorkingPath, targetPath, context.senderId);
                await copyFileCopyOnWrite(targetPath, normalizedWorkingPath);
                await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', context.senderId);
            } catch (syncError) {
                markSaveAsWorkingCopySyncRequired(normalizedWorkingPath, syncError);
                resultValidation = withWorkingCopySyncWarning(committedValidation, syncError);
            }
            allowOpenPath(targetPath, context.sender);
            await addRecentFile(targetPath);
            updateRecentFilesMenu();
            resultRef.current = {
                path: targetPath,
                validation: resultValidation,
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
