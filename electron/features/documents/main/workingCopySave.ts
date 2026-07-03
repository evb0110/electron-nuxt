import {
    rm,
    writeFile,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type {
    TDocumentSaveFailureReason,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { WorkingCopyMissingError } from '@electron/file-access/workingCopyMissingError';
import { normalizeIpcWritePayload } from '@electron/features/documents/main/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { markWorkingCopyContentChanged } from '@electron/file-access/documentRevisionStore';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    optimizeLargePdfForSave,
    optimizePdfForSave,
} from '@electron/features/documents/main/pdfSaveAsOptimization';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const QPDF_REPAIR_SAVE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_QPDF_REPAIR_SAVE_TIMEOUT_MS',
    10 * 60 * 1000,
    1_000,
);

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function createOriginalChangedValidationResult(): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: ['Original file changed on disk; save skipped to avoid overwriting external edits'],
        warnings: [],
    };
}

function getValidationSaveFailureReason(validation: IPdfValidationResult) {
    return validation.errors.some(error => error.includes('Original file changed on disk'))
        ? 'stale'
        : 'validation-failed';
}

function createSaveFailureResult(
    reason: TDocumentSaveFailureReason,
    error?: unknown,
    options: {
        externalWriteCommitted?: boolean;
        validation?: IPdfValidationResult | null;
    } = {},
): TDocumentSaveResult {
    const message = error === undefined ? undefined : getErrorMessage(error);
    return {
        ok: false,
        reason,
        ...(message === undefined ? {} : {message}),
        ...(options.externalWriteCommitted === undefined ? {} : {externalWriteCommitted: options.externalWriteCommitted}),
        ...(options.validation === undefined ? {} : {validation: options.validation}),
    };
}

function withWorkingCopySyncWarning(validation: IPdfValidationResult, error: unknown): IPdfValidationResult {
    return {
        ...validation,
        warnings: [
            ...validation.warnings,
            `Saved original file, but failed to refresh the working copy: ${getErrorMessage(error)}`,
        ],
    };
}

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
    workingPath: string,
    senderWebContentsId: number,
    writeTemp: (tempPath: string) => Promise<void>,
    options: { optimize?: 'large' | 'force' } = {},
) {
    const tempPath = makeSiblingTempPath(originalPath);
    let replaced = false;
    try {
        await writeTemp(tempPath);
        const optimizedValidation = options.optimize === 'force'
            ? await optimizePdfForSave(tempPath, {
                force: true,
                label: 'qpdf(optimize-current-pdf)',
            })
            : options.optimize === 'large'
                ? await optimizeLargePdfForSave(tempPath)
                : null;
        const validation = optimizedValidation ?? await validatePdfFile(tempPath);
        if (!validation.isValid) {
            return validation;
        }

        if (!await originalPathSaveBaseMatches(workingPath, originalPath, senderWebContentsId)) {
            return createOriginalChangedValidationResult();
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

async function repairPdfWithQpdf(
    inputPath: string,
    outputPath: string,
) {
    await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        inputPath,
        outputPath,
    ], {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(repair-save)',
        timeoutMs: QPDF_REPAIR_SAVE_TIMEOUT_MS,
    });
}

export async function handleFileSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
) {
    const result = await handleFileSaveStructured(context, workingPath);
    if (result.ok) {
        return true;
    }

    if (result.reason === 'working-copy-missing') {
        throw new WorkingCopyMissingError(result.message);
    }
    if (result.reason === 'validation-failed' || result.reason === 'stale') {
        throw new Error(`PDF validation failed: ${result.validation?.errors.join('; ') ?? result.message ?? 'unknown error'}`);
    }

    throw new Error(`Failed to save: ${result.message ?? result.reason}`);
}

export async function handleFileSaveStructured(
    context: IDocumentsSenderIdContext,
    workingPath: string,
): Promise<TDocumentSaveResult> {
    try {
        const senderId = requireSenderId(context);
        if (!workingPath || workingPath.trim() === '') {
            return createSaveFailureResult('write-failed', new Error('Invalid file path'));
        }

        const normalizedWorkingPath = workingPath.trim();
        const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
        const saveResult = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
                throw new WorkingCopyMissingError('Working copy path is not managed');
            }

            const queuedValidation = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => copyFileCopyOnWrite(normalizedWorkingPath, tempPath),
                { optimize: 'large' },
            );
            if (queuedValidation.isValid) {
                try {
                    refreshWorkingCopyOriginalFileExpectation(normalizedWorkingPath, senderId);
                    return {
                        validation: queuedValidation,
                        workingCopyRefreshed: true,
                    };
                } catch (refreshError) {
                    return {
                        validation: queuedValidation,
                        workingCopyRefreshed: false,
                        refreshError,
                    };
                }
            }

            return {
                validation: queuedValidation,
                workingCopyRefreshed: false,
            };
        });

        if (!saveResult.validation.isValid) {
            return createSaveFailureResult(
                getValidationSaveFailureReason(saveResult.validation),
                undefined,
                {
                    externalWriteCommitted: false,
                    validation: saveResult.validation,
                },
            );
        }

        return {
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: saveResult.workingCopyRefreshed,
            validation: saveResult.validation,
            ...(saveResult.refreshError === undefined ? {} : {warning: {
                reason: 'refresh-failed',
                message: getErrorMessage(saveResult.refreshError),
            }}),
        };
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            return createSaveFailureResult('working-copy-missing', err, {
                externalWriteCommitted: false,
                validation: null,
            });
        }
        return createSaveFailureResult('write-failed', err, {
            externalWriteCommitted: false,
            validation: null,
        });
    }
}

export async function handleSerializedPdfSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    data: unknown,
): Promise<IPdfValidationResult> {
    const senderId = requireSenderId(context);
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
    const payload = normalizeIpcWritePayload(data);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
                throw new Error('Working copy path is not managed');
            }

            const queuedValidation = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => writeFile(tempPath, payload),
                { optimize: 'large' },
            );
            if (queuedValidation.isValid) {
                try {
                    await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
                    refreshWorkingCopyOriginalFileExpectation(normalizedWorkingPath, senderId);
                    await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', senderId);
                } catch (syncError) {
                    return withWorkingCopySyncWarning(queuedValidation, syncError);
                }
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

export async function handleRepairPdfSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
): Promise<IPdfValidationResult> {
    const senderId = requireSenderId(context);
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
                throw new Error('Working copy path is not managed');
            }

            const queuedValidation = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => repairPdfWithQpdf(normalizedWorkingPath, tempPath),
                { optimize: 'large' },
            );
            if (queuedValidation.isValid) {
                try {
                    await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
                    refreshWorkingCopyOriginalFileExpectation(normalizedWorkingPath, senderId);
                    await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', senderId);
                } catch (syncError) {
                    return withWorkingCopySyncWarning(queuedValidation, syncError);
                }
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
        throw new Error(`Failed to repair and save: ${getErrorMessage(err)}`);
    }
}

export async function handleOptimizePdfForInteraction(
    context: IDocumentsSenderIdContext,
    workingPath: string,
): Promise<IPdfValidationResult> {
    const senderId = requireSenderId(context);
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
                throw new Error('Working copy path is not managed');
            }

            const queuedValidation = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => copyFileCopyOnWrite(normalizedWorkingPath, tempPath),
                { optimize: 'force' },
            );
            if (queuedValidation.isValid) {
                try {
                    await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
                    refreshWorkingCopyOriginalFileExpectation(normalizedWorkingPath, senderId);
                    await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', senderId);
                } catch (syncError) {
                    return withWorkingCopySyncWarning(queuedValidation, syncError);
                }
            }

            return queuedValidation;
        });
        return validation;
    } catch (err) {
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to optimize PDF: ${getErrorMessage(err)}`);
    }
}
