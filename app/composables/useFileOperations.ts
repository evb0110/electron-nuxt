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
import { retry } from 'es-toolkit/function';
import { BrowserLogger } from '@app/utils/browser-logger';
import { useAnalytics } from '@app/composables/useAnalytics';

export interface IFileOperationsDeps {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    annotationDirty: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    saveDocument: () => Promise<Uint8Array | null>;
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
        },
    ) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
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
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument,
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
        annotationNoteWindowsCount,
        loadRecentFiles,
    } = deps;

    function getValidationFileName() {
        return workingCopyPath.value?.split(/[\\/]/u).pop() ?? undefined;
    }

    async function buildSerializedSaveResult(
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        opts?: {
            includeShapes?: boolean;
            saveMode?: TPdfSaveMode;
        },
    ): Promise<IPdfSaveResult | null> {
        const data = await serializePdfForSave(rawData, {
            includeShapes: opts?.includeShapes,
            pendingTexts,
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

        if (result.didSaveAs && result.outPath) {
            loadRecentFiles();
        }

        return true;
    }

    async function saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50) {
        try {
            return await retry(async () => {
                const data = await saveDocument();
                if (!data) {
                    throw new Error('saveDocument returned no data');
                }
                return data;
            }, {
                retries: maxAttempts,
                delay: retryDelayMs,
            });
        } catch {
            return null;
        }
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
        const hasPendingTexts = Boolean(pendingTexts && pendingTexts.size > 0);
        isSaving.value = true;
        try {
            if (workingCopyPath.value) {
                const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts;
                if (shouldSerialize) {
                    const rawData = await saveDocumentWithRetry();
                    if (rawData) {
                        const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, {
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
                const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, {
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
        const hasPendingTexts = Boolean(pendingTexts && pendingTexts.size > 0);
        isSavingAs.value = true;
        try {
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts;
            if (shouldSerialize) {
                const rawData = await saveDocumentWithRetry();
                if (rawData) {
                    const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, {
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
