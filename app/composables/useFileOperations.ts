import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platform-api';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { withTimeout } from 'es-toolkit/promise';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
import { useAnalytics } from '@app/composables/useAnalytics';
import { parsePdfJsAnnotationRef } from '@app/composables/pdf/pdfSerializationRefs';

export interface IFileOperationsDeps {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    annotationDirty: Ref<boolean>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    saveDocument: () => Promise<Uint8Array | null>;
    getSourcePdfData: () => Promise<Uint8Array | null>;
    readWorkingCopyBytes: () => Promise<Uint8Array | null>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfSaveResult['validation']>;
    saveFile: (data: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopy: (opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopyAs: (data?: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    markAnnotationSaved: () => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    hasAnnotationChanges: () => boolean;
    serializePdfForSave: (
        data: Uint8Array,
        options?: {
            includeShapes?: boolean;
            pendingTexts?: Map<string, string> | null;
            pendingDeletes?: IAnnotationCommentSummary[] | null;
        },
    ) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    annotationNoteWindowsCount: Ref<number>;
    loadRecentFiles: () => void;
}

export const useFileOperations = (deps: IFileOperationsDeps) => {
    const analytics = useAnalytics();
    const {
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        annotationComments,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument,
        getSourcePdfData,
        readWorkingCopyBytes,
        validatePdfData,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        serializePdfForSave,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        annotationNoteWindowsCount,
        loadRecentFiles,
    } = deps;

    function getValidationFileName() {
        return workingCopyPath.value?.split(/[\\/]/u).pop() ?? undefined;
    }

    function isTimeoutError(error: unknown) {
        return error instanceof Error && error.name === 'TimeoutError';
    }

    function hasLivePdfJsAnnotationChanges() {
        const document = pdfDocument.value;
        if (!document) {
            return false;
        }

        try {
            const modifiedIds = document.annotationStorage?.modifiedIds?.ids;
            return typeof modifiedIds?.size === 'number' && modifiedIds.size > 0;
        } catch (error) {
            BrowserLogger.debug('workspace', 'Failed to inspect live PDF.js annotation dirty state', error);
            return false;
        }
    }

    function hasEditorOnlyAnnotationsPendingMaterialization() {
        return annotationComments.value.some(comment =>
            comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId),
        );
    }

    async function buildSerializedSaveResult(
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        opts?: {
            includeShapes?: boolean;
            saveMode?: TPdfSaveMode;
        },
    ): Promise<IPdfSaveResult | null> {
        const data = await serializePdfForSave(rawData, {
            includeShapes: opts?.includeShapes,
            pendingTexts,
            pendingDeletes,
        });

        const validation = await validatePdfData(data, getValidationFileName());
        if (!validation.isValid) {
            BrowserLogger.warn('workspace', 'Save aborted because PDF validation failed', {
                errors: validation.errors,
                warnings: validation.warnings,
            });
            return null;
        }

        return {
            finalBytes: data,
            saveMode: opts?.saveMode ?? 'rewrite',
            warnings: validation.warnings,
            validation,
        };
    }

    async function validateWorkingCopySnapshot(saveMode: TPdfSaveMode) {
        const data = await readWorkingCopyBytes();
        if (!data) {
            return null;
        }

        const validation = await validatePdfData(data, getValidationFileName());
        if (!validation.isValid) {
            BrowserLogger.warn('workspace', 'Save aborted because PDF validation failed', {
                errors: validation.errors,
                warnings: validation.warnings,
            });
            return null;
        }

        return {
            finalBytes: data,
            saveMode,
            warnings: validation.warnings,
            validation,
        } satisfies IPdfSaveResult;
    }

    function finalizeSuccessfulSave(result: IPdfPersistResult, opts?: { resetAnnotationStorage?: boolean }) {
        if (!result.success) {
            return false;
        }

        if (opts?.resetAnnotationStorage !== false) {
            pdfDocument.value?.annotationStorage?.resetModified();
        }
        markAnnotationSaved();
        markPageLabelsSaved();
        markBookmarksSaved();

        if (result.outPath) {
            loadRecentFiles();
        }

        return true;
    }

    async function saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                return await withTimeout(async () => {
                    const data = await saveDocument();
                    if (!data) {
                        throw new Error('saveDocument returned no data');
                    }
                    return data;
                }, PDF_SAVE_TIMEOUT_MS);
            } catch (error) {
                const timedOut = isTimeoutError(error);
                BrowserLogger.warn(
                    'workspace',
                    timedOut
                        ? 'Save aborted because PDF.js saveDocument timed out'
                        : 'saveDocument attempt failed',
                    {
                        attempt,
                        maxAttempts,
                        timedOut,
                        error,
                    },
                );

                if (timedOut || attempt === maxAttempts) {
                    return null;
                }

                if (retryDelayMs > 0) {
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, retryDelayMs);
                    });
                }
            }
        }

        return null;
    }

    async function getSerializationBasePdfBytes() {
        if (
            hasLivePdfJsAnnotationChanges()
            || hasEditorOnlyAnnotationsPendingMaterialization()
        ) {
            return saveDocumentWithRetry();
        }

        return getSourcePdfData();
    }

    async function handleSave() {
        if (isSaving.value || isSavingAs.value) {
            return;
        }
        if (annotationNoteWindowsCount.value > 0) {
            const savedNotes = await persistAllAnnotationNotes(true);
            if (!savedNotes) {
                BrowserLogger.warn('workspace', 'Save aborted because annotation note persistence failed');
                return;
            }
        }
        const pendingTexts = consumePendingEmbeddedTextUpdates();
        const pendingDeletes = consumePendingEmbeddedAnnotationDeletes();
        const hasPendingTexts = Boolean(pendingTexts && pendingTexts.size > 0);
        const hasPendingDeletes = Boolean(pendingDeletes && pendingDeletes.length > 0);
        isSaving.value = true;
        try {
            if (workingCopyPath.value) {
                const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts || hasPendingDeletes;
                if (shouldSerialize) {
                    const rawData = await getSerializationBasePdfBytes();
                    if (rawData) {
                        const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
                            includeShapes: true,
                            saveMode: 'rewrite',
                        });
                        if (saveResult) {
                            const persisted = await saveFile(saveResult.finalBytes, { saveMode: saveResult.saveMode });
                            if (finalizeSuccessfulSave(persisted)) {
                                analytics.track('save_completed', {
                                    didSaveAs: persisted.didSaveAs,
                                    mode: 'save',
                                    saveMode: persisted.saveMode,
                                    serializedChanges: true,
                                });
                            }
                        }
                    }
                    return;
                }
                const saveResult = await validateWorkingCopySnapshot('rewrite');
                if (saveResult) {
                    const persisted = await saveWorkingCopy({ saveMode: saveResult.saveMode });
                    if (finalizeSuccessfulSave(persisted, { resetAnnotationStorage: false })) {
                        analytics.track('save_completed', {
                            didSaveAs: persisted.didSaveAs,
                            mode: 'save',
                            saveMode: persisted.saveMode,
                            serializedChanges: false,
                        });
                    }
                }
                return;
            }

            const rawData = await saveDocumentWithRetry();
            if (rawData) {
                const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
                    includeShapes: false,
                    saveMode: 'rewrite',
                });
                if (saveResult) {
                    const persisted = await saveFile(saveResult.finalBytes, { saveMode: saveResult.saveMode });
                    if (finalizeSuccessfulSave(persisted)) {
                        analytics.track('save_completed', {
                            didSaveAs: persisted.didSaveAs,
                            mode: 'save',
                            saveMode: persisted.saveMode,
                            serializedChanges: true,
                        });
                    }
                }
            }
        } finally {
            isSaving.value = false;
        }
    }

    async function handleSaveAs() {
        if (isSaving.value || isSavingAs.value) {
            return;
        }
        if (annotationNoteWindowsCount.value > 0) {
            const savedNotes = await persistAllAnnotationNotes(true);
            if (!savedNotes) {
                BrowserLogger.warn('workspace', 'Save As aborted because annotation note persistence failed');
                return;
            }
        }
        const pendingTexts = consumePendingEmbeddedTextUpdates();
        const pendingDeletes = consumePendingEmbeddedAnnotationDeletes();
        const hasPendingTexts = Boolean(pendingTexts && pendingTexts.size > 0);
        const hasPendingDeletes = Boolean(pendingDeletes && pendingDeletes.length > 0);
        isSavingAs.value = true;
        try {
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts || hasPendingDeletes;
            if (shouldSerialize) {
                const rawData = await getSerializationBasePdfBytes();
                if (rawData) {
                    const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
                        includeShapes: true,
                        saveMode: 'save_as_rewrite',
                    });
                    if (saveResult) {
                        const persisted = await saveWorkingCopyAs(saveResult.finalBytes, { saveMode: saveResult.saveMode });
                        if (finalizeSuccessfulSave(persisted)) {
                            analytics.track('save_completed', {
                                didSaveAs: persisted.didSaveAs,
                                mode: 'save_as',
                                saveMode: persisted.saveMode,
                                serializedChanges: true,
                            });
                        }
                    }
                }
            } else {
                const saveResult = await validateWorkingCopySnapshot('save_as_rewrite');
                if (saveResult) {
                    const persisted = await saveWorkingCopyAs(undefined, { saveMode: saveResult.saveMode });
                    if (finalizeSuccessfulSave(persisted, { resetAnnotationStorage: false })) {
                        analytics.track('save_completed', {
                            didSaveAs: persisted.didSaveAs,
                            mode: 'save_as',
                            saveMode: persisted.saveMode,
                            serializedChanges: false,
                        });
                    }
                }
            }
        } finally {
            isSavingAs.value = false;
        }
    }

    return {
        handleSave,
        handleSaveAs,
    };
};
