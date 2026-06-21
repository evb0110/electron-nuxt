import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    IScrollSnapshot,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    getEmbeddedMutationBaseData as resolveEmbeddedMutationBaseData,
    usePdfSerialization,
    capturePdfReloadSnapshot,
    createPdfReloadWaiter,
} from '@app/modules/pdf-viewer/public';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/public';
import { useFileOperations } from '@app/modules/workspace-shell/composables/useFileOperations';
import type { IFileOperationsDeps } from '@app/modules/workspace-shell/composables/useFileOperations';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSearchCapability } from '@app/utils/getSearchCapability';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';
import type { IOcrSearchablePdfResult } from '@app/utils/ocr/ocrTypes';

interface IPdfViewerForSave {
    scrollToPage: (pageNumber: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    preserveNextSourceReloadVisibleContent?: (request?: {
        scrollSnapshot?: IScrollSnapshot | null;
        pageToRestore?: number | null;
    }) => void;
    preparePersistedManagedShapesForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedManagedShapesAfterFailedSave?: (snapshot: unknown) => Promise<void>;
    saveDocument: () => Promise<Uint8Array | null>;
    adoptPersistedManagedShapesOnNextImport?: () => void;
    clearPendingManagedShapeImportAdoption?: () => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getAllShapes: () => IShapeAnnotation[];
    markSavedShapeState?: () => void;
    getDeletedEmbeddedShapeAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    hasShapes?: boolean | Ref<boolean>;
}

interface IOcrCompletePayload extends IOcrSearchablePdfResult {
    sourceWorkingCopyPath: TDocumentRef;
    sourcePageToRestore?: number;
}

interface IOcrApplyReloadResult {
    restorePromise: Promise<void>;
    getRestoreError: () => unknown;
}

type TSharedSaveOperationDeps = Pick<
    IFileOperationsDeps,
    | 'validatePdfPath'
    | 'saveFile'
    | 'saveWorkingCopy'
    | 'trySavePdfNativeMutations'
    | 'trySaveEmbeddedNoteTextUpdates'
    | 'saveWorkingCopyAs'
>;

interface IPageSaveOrchestrationDeps extends TSharedSaveOperationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfViewerForSave | null>;
    requestDocxExport: (selectedLanguages?: string[]) => Promise<boolean>;
    openOcrPopup: () => void;
    isExportingDocx: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    annotationDirty: Ref<boolean>;
    annotationNoteWindowsCount: Ref<number>;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges?: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges?: () => boolean;
    hasPreservedAnnotationSourceChanges?: () => boolean;
    markNativeFreeTextNotesSaved?: IFileOperationsDeps['markNativeFreeTextNotesSaved'];
    markNativeFreeTextNotesDeleted?: IFileOperationsDeps['markNativeFreeTextNotesDeleted'];
    markAnnotationSaved: (opts?: { preserveLivePdfjsSession?: boolean }) => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    isDirty: Ref<boolean>;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates?: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes?: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
    clearAnnotationHistory?: () => void;
    loadRecentFiles: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
    resetSearchCache: () => void;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const usePageSaveOrchestration = (deps: IPageSaveOrchestrationDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();

    const {
        pdfData,
        pdfDocument,
        pdfViewerRef,
        requestDocxExport,
        openOcrPopup,
        isExportingDocx,
        workingCopyPath,
        originalPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedAnnotationSourceChanges,
        markNativeFreeTextNotesSaved,
        markNativeFreeTextNotesDeleted,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        restorePendingEmbeddedAnnotationDeletes,
        clearAnnotationHistory,
        loadRecentFiles,
        clearOcrCache,
        reloadWorkingCopyIntoHistory,
        currentPage,
        waitForPdfReload,
        resetSearchCache,
        runWithDocumentOperationLease,
    } = deps;

    const {
        getSourcePdfData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        embedPlacedImageToPage,
        updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
        deleteEmbeddedAnnotationByRef: deleteEmbeddedByRef,
        rewritePageLabels,
    } = usePdfSerialization({
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel: t('bookmarks.untitled'),
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
        getAnnotationCommentsSnapshot: () => pdfViewerRef.value?.getAnnotationCommentsSnapshot?.(),
        getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => pdfViewerRef.value?.getDeletedEmbeddedShapeAnnotationIds() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => pdfViewerRef.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
    });

    const {
        handleSave: handleSaveWithReload,
        handleRepairSave: handleRepairSaveWithReload,
        handleSaveAs: handleSaveAsWithReload,
    } = useFileOperations({
        isSaving,
        isSavingAs,
        workingCopyPath,
        originalPath,
        annotationDirty,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel: t('bookmarks.untitled'),
        pdfDocument,
        saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
        getSourcePdfData,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        ...(trySavePdfNativeMutations !== undefined ? { trySavePdfNativeMutations } : {}),
        ...(trySaveEmbeddedNoteTextUpdates !== undefined ? { trySaveEmbeddedNoteTextUpdates } : {}),
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        ...(hasLivePdfJsAnnotationChanges ? { hasLivePdfJsAnnotationChanges } : {}),
        ...(hasSavedPdfJsAnnotationBaselineChanges ? { hasSavedPdfJsAnnotationBaselineChanges } : {}),
        ...(hasPreservedAnnotationSourceChanges ? { hasPreservedAnnotationSourceChanges } : {}),
        ...(markNativeFreeTextNotesSaved ? { markNativeFreeTextNotesSaved } : {}),
        ...(markNativeFreeTextNotesDeleted ? { markNativeFreeTextNotesDeleted } : {}),
        hasShapeChanges: () => hasViewerShapeChanges(pdfViewerRef.value),
        hasManagedShapes: () => (pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
        getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => pdfViewerRef.value?.getDeletedEmbeddedShapeAnnotationIds() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => pdfViewerRef.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
        getAnnotationCommentsSnapshot: () => pdfViewerRef.value?.getAnnotationCommentsSnapshot?.(),
        serializePdfForSave,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        ...(restorePendingEmbeddedTextUpdates !== undefined ? { restorePendingEmbeddedTextUpdates } : {}),
        consumePendingEmbeddedAnnotationDeletes,
        ...(restorePendingEmbeddedAnnotationDeletes !== undefined ? { restorePendingEmbeddedAnnotationDeletes } : {}),
        ...(clearAnnotationHistory !== undefined ? { clearAnnotationHistory } : {}),
        annotationNoteWindowsCount,
        loadRecentFiles,
        preparePostSaveReload: () => {
            const capturedReloadState = capturePdfReloadSnapshot(pdfViewerRef.value, currentPage.value);
            pdfViewerRef.value?.preserveNextSourceReloadVisibleContent?.({
                scrollSnapshot: capturedReloadState.scrollSnapshot,
                pageToRestore: capturedReloadState.pageToRestore,
            });

            return createPdfReloadWaiter({
                pdfDocument,
                pdfViewerRef,
                resetSearchCache,
                pageToRestore: capturedReloadState.pageToRestore,
                scrollSnapshot: capturedReloadState.scrollSnapshot,
                restoreScroll: capturedReloadState.scrollSnapshot !== null,
            });
        },
        markShapeStateSaved: () => pdfViewerRef.value?.markSavedShapeState?.(),
        preparePersistedShapeStateForSave: (data) => (
            pdfViewerRef.value?.preparePersistedManagedShapesForSave?.(data) ?? Promise.resolve(null)
        ),
        restorePreparedPersistedShapeState: (snapshot: unknown) => (
            pdfViewerRef.value?.restorePreparedManagedShapesAfterFailedSave?.(snapshot) ?? Promise.resolve()
        ),
        adoptPersistedShapeStateForNextReload: () => pdfViewerRef.value?.adoptPersistedManagedShapesOnNextImport?.(),
        clearPendingPersistedShapeStateForNextReload: () => pdfViewerRef.value?.clearPendingManagedShapeImportAdoption?.(),
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
    const isExportingDocxState = computed(() => isExportingDocx.value);
    const canSave = computed(() => (
        hasPendingUnsavedChanges
            ? hasPendingUnsavedChanges.value
            : (
                isDirty.value
                || annotationDirty.value
                || hasAnnotationChanges()
                || (hasLivePdfJsAnnotationChanges?.() ?? false)
                || (hasSavedPdfJsAnnotationBaselineChanges?.() ?? false)
                || (hasPreservedAnnotationSourceChanges?.() ?? false)
                || pageLabelsDirty.value
                || bookmarksDirty.value
            )
    ));

    async function handleExportDocx(selectedLanguages?: string[]) {
        const result = await requestDocxExport(selectedLanguages);
        if (result === false) {
            openOcrPopup();
        }
    }

    async function handleSave() {
        return handleSaveWithReload();
    }

    async function handleRepairSave() {
        return handleRepairSaveWithReload();
    }

    async function handleSaveAs() {
        return handleSaveAsWithReload();
    }

    function saveForExternalRead() {
        return handleSaveWithReload();
    }

    async function acknowledgeOcrResultFile(payload: IOcrCompletePayload) {
        let didCleanupViaAck = false;
        if (payload.requiresCleanupAck) {
            try {
                const ackResult = await getOcrCapability().acknowledgeResultFile(payload.requestId, payload.pdfPath);
                didCleanupViaAck = ackResult.cleaned;
                if (!ackResult.cleaned && ackResult.error) {
                    BrowserLogger.warn('ocr', 'OCR cleanup acknowledgement was rejected', {
                        requestId: payload.requestId,
                        path: payload.pdfPath,
                        error: ackResult.error,
                    });
                }
            } catch (ackErr) {
                BrowserLogger.warn('ocr', 'Failed to acknowledge OCR temp result file', {
                    requestId: payload.requestId,
                    path: payload.pdfPath,
                    error: ackErr,
                });
            }
        }

        if (didCleanupViaAck) {
            return;
        }

        try {
            await getDocumentsCapability().cleanupOcrTemp(payload.pdfPath);
        } catch (cleanupErr) {
            BrowserLogger.warn('ocr', 'Failed to cleanup temp OCR result file', {
                requestId: payload.requestId,
                path: payload.pdfPath,
                error: cleanupErr,
            });
        }
    }

    async function replaceOcrWorkingCopyForActiveDocument(
        payload: IOcrCompletePayload,
        pageToRestore: number,
    ): Promise<IOcrApplyReloadResult | null> {
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Ignoring stale OCR result for inactive document', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            await acknowledgeOcrResultFile(payload);
            return null;
        }

        let restoreError: unknown = null;
        let restorePromise: Promise<void> | null = null;

        clearOcrCache(payload.sourceWorkingCopyPath);
        resetSearchCache();

        try {
            await getDocumentsCapability().replaceWorkingCopyFromPath(
                payload.sourceWorkingCopyPath,
                payload.pdfPath,
            );
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR reload wait after document switch', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                return null;
            }

            restorePromise = waitForPdfReload(pageToRestore).catch((error) => {
                restoreError = error;
            });
            const didReload = await reloadWorkingCopyIntoHistory({ markDirty: true });
            if (!didReload) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR reload after working copy replacement', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                void restorePromise;
                return null;
            }
        } catch (error) {
            void restorePromise;
            throw error;
        } finally {
            await acknowledgeOcrResultFile(payload);
        }

        if (restorePromise === null) {
            return null;
        }

        return {
            restorePromise,
            getRestoreError: () => restoreError,
        };
    }

    async function applyOcrCompleteResult(payload: IOcrCompletePayload) {
        const pageToRestore = payload.sourcePageToRestore ?? currentPage.value;
        const warmupWorkingPath = payload.sourceWorkingCopyPath;
        const warmupPageCountHint = totalPages.value > 0 ? totalPages.value : undefined;
        const applyReloadResult = runWithDocumentOperationLease
            ? await runWithDocumentOperationLease(
                'ocr-apply',
                () => replaceOcrWorkingCopyForActiveDocument(payload, pageToRestore),
            )
            : await replaceOcrWorkingCopyForActiveDocument(payload, pageToRestore);

        if (!applyReloadResult) {
            return;
        }

        const {
            restorePromise,
            getRestoreError,
        } = applyReloadResult;

        await restorePromise;
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Skipped stale OCR completion after document switch', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            return;
        }
        const restoreError = getRestoreError();
        if (restoreError) {
            BrowserLogger.warn('ocr', 'OCR result was applied but page restore failed', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                pageToRestore,
                error: restoreError,
            });
        }

        if (warmupWorkingPath) {
            // Prewarm search index and worker caches after OCR persistence and reload cache reset.
            void getSearchCapability().warmIndex(warmupWorkingPath, {...(warmupPageCountHint !== undefined ? { pageCount: warmupPageCountHint } : {})}).catch((error) => {
                const warmIndexError: unknown = error;
                BrowserLogger.debug('pdf-search', 'Failed to prewarm search index after OCR', {
                    path: warmupWorkingPath,
                    pageCount: warmupPageCountHint,
                    error: warmIndexError,
                });
            });
        }

        toast.add({
            color: 'success',
            title: t('ocr.complete'),
        });
    }

    async function handleOcrComplete(payload: IOcrCompletePayload) {
        return applyOcrCompleteResult(payload);
    }

    async function getEmbeddedMutationBaseData() {
        return resolveEmbeddedMutationBaseData({
            hasAnnotationChanges,
            saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
            getSourcePdfData,
        });
    }

    return {
        getSourcePdfData,
        getEmbeddedMutationBaseData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        embedPlacedImageToPage,
        updateEmbeddedByRef,
        deleteEmbeddedByRef,
        rewritePageLabels,
        handleSave,
        handleRepairSave,
        handleSaveAs,
        saveForExternalRead,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx: isExportingDocxState,
        canSave,
    };
};
