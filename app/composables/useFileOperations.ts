import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platform-api';
import { isTimeoutError } from '@contracts/timeout-error';
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
    hasShapeChanges?: () => boolean;
    serializePdfForSave: (
        data: Uint8Array,
        options?: {
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            pendingTexts?: Map<string, string> | null;
            pendingDeletes?: IAnnotationCommentSummary[] | null;
        },
    ) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    annotationNoteWindowsCount: Ref<number>;
    loadRecentFiles: () => void;
    preparePostSaveReload?: () => {
        promise: Promise<void>;
        cancel: () => void;
    };
    markShapeStateSaved?: () => void;
    preparePersistedShapeStateForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedPersistedShapeState?: (snapshot: unknown) => Promise<void> | void;
    adoptPersistedShapeStateForNextReload?: () => void;
    clearPendingPersistedShapeStateForNextReload?: () => void;
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
        hasShapeChanges,
        serializePdfForSave,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        annotationNoteWindowsCount,
        loadRecentFiles,
        preparePostSaveReload,
        markShapeStateSaved,
        preparePersistedShapeStateForSave,
        restorePreparedPersistedShapeState,
        adoptPersistedShapeStateForNextReload,
        clearPendingPersistedShapeStateForNextReload,
    } = deps;

    function getValidationFileName() {
        return workingCopyPath.value?.split(/[\\/]/u).pop() ?? undefined;
    }

    function hasLivePdfJsAnnotationChanges() {
        const document = pdfDocument.value;
        if (!document) {
            return false;
        }

        try {
            const storage = document.annotationStorage;
            const modifiedIds = storage?.modifiedIds?.ids;
            if (typeof modifiedIds?.size === 'number' && modifiedIds.size > 0) {
                return true;
            }

            const serializableMap = storage?.serializable?.map;
            return serializableMap instanceof Map && serializableMap.size > 0;
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

    async function validatePdfSaveData(
        data: Uint8Array,
        saveMode: TPdfSaveMode,
    ): Promise<IPdfSaveResult | null> {
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
        };
    }

    async function buildSerializedSaveResult(
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        opts?: {
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            saveMode?: TPdfSaveMode;
        },
    ): Promise<IPdfSaveResult | null> {
        const data = await serializePdfForSave(rawData, {
            includeShapes: opts?.includeShapes,
            rewriteShapeState: opts?.rewriteShapeState,
            pendingTexts,
            pendingDeletes,
        });

        return validatePdfSaveData(data, opts?.saveMode ?? 'rewrite');
    }

    async function validateWorkingCopySnapshot(saveMode: TPdfSaveMode) {
        const data = await readWorkingCopyBytes();
        if (!data) {
            return null;
        }

        return validatePdfSaveData(data, saveMode);
    }

    function finalizeSuccessfulSave(result: IPdfPersistResult, opts?: {
        resetAnnotationStorage?: boolean;
        markShapeStateSaved?: boolean;
    }) {
        if (!result.success) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Finalizing successful save', () => ({
            didSaveAs: result.didSaveAs,
            outPath: result.outPath,
            saveMode: result.saveMode,
            resetAnnotationStorage: opts?.resetAnnotationStorage !== false,
            annotationDirty: annotationDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
            hasAnnotationChanges: hasAnnotationChanges(),
            hasShapeChanges: hasShapeChanges?.() ?? false,
        }));

        if (opts?.resetAnnotationStorage !== false) {
            pdfDocument.value?.annotationStorage?.resetModified();
        }
        markAnnotationSaved();
        markPageLabelsSaved();
        markBookmarksSaved();
        if (opts?.markShapeStateSaved !== false) {
            markShapeStateSaved?.();
        }

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

    async function finalizeSaveReload(
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        saveSucceeded: boolean,
        opts?: { markShapeStateSavedOnSuccess?: boolean },
    ) {
        if (!saveSucceeded) {
            clearPendingPersistedShapeStateForNextReload?.();
            reloadWaiter?.cancel();
            return;
        }
        if (!reloadWaiter) {
            if (opts?.markShapeStateSavedOnSuccess) {
                markShapeStateSaved?.();
            }
            return;
        }
        await reloadWaiter.promise.then(() => true).catch((error) => {
            BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
            return false;
        });
        if (opts?.markShapeStateSavedOnSuccess) {
            markShapeStateSaved?.();
        }
    }

    function armPersistedShapeStateAdoption(shapeStateDirty: boolean) {
        if (!shapeStateDirty) {
            return false;
        }

        adoptPersistedShapeStateForNextReload?.();
        return true;
    }

    async function primePersistedShapeStateForSave(
        data: Uint8Array,
        shapeStateDirty: boolean,
    ) {
        if (!shapeStateDirty) {
            return null;
        }

        return preparePersistedShapeStateForSave?.(data) ?? null;
    }

    async function restorePreparedShapeState(snapshot: unknown) {
        if (!snapshot) {
            return;
        }

        await restorePreparedPersistedShapeState?.(snapshot);
    }

    function trackSaveCompleted(
        mode: 'save' | 'save_as',
        persisted: IPdfPersistResult,
        serializedChanges: boolean,
    ) {
        analytics.track('save_completed', {
            didSaveAs: persisted.didSaveAs,
            mode,
            saveMode: persisted.saveMode,
            serializedChanges,
        });
    }

    async function persistSerializedSaveResult(
        saveResult: IPdfSaveResult,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        persist: (
            data: Uint8Array,
            opts: { saveMode: TPdfSaveMode },
        ) => Promise<IPdfPersistResult>,
    ) {
        let preparedShapeStateSnapshot: unknown = null;
        try {
            preparedShapeStateSnapshot = await primePersistedShapeStateForSave(
                saveResult.finalBytes,
                shapeStateDirty,
            );
            armPersistedShapeStateAdoption(shapeStateDirty);
            const persisted = await persist(saveResult.finalBytes, { saveMode: saveResult.saveMode });
            if (finalizeSuccessfulSave(persisted, { markShapeStateSaved: !reloadWaiter })) {
                preparedShapeStateSnapshot = null;
                trackSaveCompleted(mode, persisted, true);
                return true;
            }
            return false;
        } finally {
            await restorePreparedShapeState(preparedShapeStateSnapshot);
        }
    }

    async function persistOpenAnnotationNotes(abortMessage: string) {
        if (annotationNoteWindowsCount.value <= 0) {
            return true;
        }

        const savedNotes = await persistAllAnnotationNotes(true);
        if (!savedNotes) {
            BrowserLogger.warn('workspace', abortMessage);
            return false;
        }

        return true;
    }

    function consumePendingEmbeddedAnnotationChanges() {
        const pendingTexts = consumePendingEmbeddedTextUpdates();
        const pendingDeletes = consumePendingEmbeddedAnnotationDeletes();
        return {
            pendingTexts,
            pendingDeletes,
            hasPendingTexts: Boolean(pendingTexts && pendingTexts.size > 0),
            hasPendingDeletes: Boolean(pendingDeletes && pendingDeletes.length > 0),
        };
    }

    function hasSaveOperationInProgress() {
        if (isSaving.value || isSavingAs.value) {
            return true;
        }
        return false;
    }

    async function saveSerializedChanges(
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: { saveMode: TPdfSaveMode },
        ) => Promise<IPdfPersistResult>,
    ) {
        if (!rawData) {
            return false;
        }

        const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
            includeShapes: shapeStateDirty,
            rewriteShapeState: shapeStateDirty,
            saveMode,
        });
        if (!saveResult) {
            return false;
        }

        return persistSerializedSaveResult(
            saveResult,
            shapeStateDirty,
            reloadWaiter,
            mode,
            persist,
        );
    }

    async function saveUnserializedWorkingCopy(
        saveMode: TPdfSaveMode,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        persist: (opts: { saveMode: TPdfSaveMode }) => Promise<IPdfPersistResult>,
    ) {
        const saveResult = await validateWorkingCopySnapshot(saveMode);
        if (!saveResult) {
            return false;
        }

        armPersistedShapeStateAdoption(shapeStateDirty);
        const persisted = await persist({ saveMode: saveResult.saveMode });
        if (!finalizeSuccessfulSave(persisted, {
            resetAnnotationStorage: false,
            markShapeStateSaved: !reloadWaiter,
        })) {
            return false;
        }

        trackSaveCompleted(mode, persisted, false);
        return true;
    }

    async function handleSave() {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        if (!await persistOpenAnnotationNotes('Save aborted because annotation note persistence failed')) {
            return false;
        }
        const {
            pendingTexts,
            pendingDeletes,
            hasPendingTexts,
            hasPendingDeletes,
        } = consumePendingEmbeddedAnnotationChanges();
        const reloadWaiter = preparePostSaveReload?.() ?? null;
        let finalizedReloadWaiter = false;
        let saveSucceeded = false;
        BrowserLogger.debug('workspace', 'Starting handleSave', () => ({
            hasWorkingCopyPath: Boolean(workingCopyPath.value),
            annotationDirty: annotationDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
            hasAnnotationChanges: hasAnnotationChanges(),
            hasShapeChanges: hasShapeChanges?.() ?? false,
            hasPendingTexts,
            hasPendingDeletes,
            annotationNoteWindowsCount: annotationNoteWindowsCount.value,
        }));
        isSaving.value = true;
        try {
            if (workingCopyPath.value) {
                const shapeStateDirty = hasShapeChanges?.() ?? false;
                const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || shapeStateDirty || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts || hasPendingDeletes;
                if (shouldSerialize) {
                    const rawData = await getSerializationBasePdfBytes();
                    saveSucceeded = await saveSerializedChanges(
                        rawData,
                        pendingTexts,
                        pendingDeletes,
                        shapeStateDirty,
                        reloadWaiter,
                        'save',
                        'rewrite',
                        saveFile,
                    );
                    await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
                    finalizedReloadWaiter = true;
                    return saveSucceeded;
                }
                saveSucceeded = await saveUnserializedWorkingCopy(
                    'rewrite',
                    shapeStateDirty,
                    reloadWaiter,
                    'save',
                    saveWorkingCopy,
                );
                await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
                finalizedReloadWaiter = true;
                return saveSucceeded;
            }

            const shapeStateDirty = hasShapeChanges?.() ?? false;
            const rawData = await saveDocumentWithRetry();
            saveSucceeded = await saveSerializedChanges(
                rawData,
                pendingTexts,
                pendingDeletes,
                shapeStateDirty,
                reloadWaiter,
                'save',
                'rewrite',
                saveFile,
            );
            await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
            finalizedReloadWaiter = true;
            return saveSucceeded;
        } finally {
            if (reloadWaiter && !finalizedReloadWaiter) {
                reloadWaiter.cancel();
            }
            isSaving.value = false;
        }
    }

    async function handleSaveAs() {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        if (!await persistOpenAnnotationNotes('Save As aborted because annotation note persistence failed')) {
            return false;
        }
        const {
            pendingTexts,
            pendingDeletes,
            hasPendingTexts,
            hasPendingDeletes,
        } = consumePendingEmbeddedAnnotationChanges();
        const reloadWaiter = preparePostSaveReload?.() ?? null;
        let finalizedReloadWaiter = false;
        let saveSucceeded = false;
        isSavingAs.value = true;
        try {
            const shapeStateDirty = hasShapeChanges?.() ?? false;
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || shapeStateDirty || pageLabelsDirty.value || bookmarksDirty.value || hasPendingTexts || hasPendingDeletes;
            if (shouldSerialize) {
                const rawData = await getSerializationBasePdfBytes();
                saveSucceeded = await saveSerializedChanges(
                    rawData,
                    pendingTexts,
                    pendingDeletes,
                    shapeStateDirty,
                    reloadWaiter,
                    'save_as',
                    'save_as_rewrite',
                    saveWorkingCopyAs,
                );
            } else {
                saveSucceeded = await saveUnserializedWorkingCopy(
                    'save_as_rewrite',
                    shapeStateDirty,
                    reloadWaiter,
                    'save_as',
                    opts => saveWorkingCopyAs(undefined, opts),
                );
            }
            await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
            finalizedReloadWaiter = true;
            return saveSucceeded;
        } finally {
            if (reloadWaiter && !finalizedReloadWaiter) {
                reloadWaiter.cancel();
            }
            isSavingAs.value = false;
        }
    }

    return {
        handleSave,
        handleSaveAs,
    };
};
