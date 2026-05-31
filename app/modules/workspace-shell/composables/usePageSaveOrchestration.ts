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
import type { TDocumentRef } from '@contracts/platformApi';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    useFileOperations,
    type IFileOperationsDeps,
} from '@app/composables/useFileOperations';
import { getEmbeddedMutationBaseData as resolveEmbeddedMutationBaseData } from '@app/services/pdf-save/pdfSaveBaseData';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSearchCapability } from '@app/utils/platformSearch';
import {
    capturePdfReloadSnapshot,
    createPdfReloadWaiter,
} from '@app/composables/pdf/pdfReloadWaiter';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/composables/workspaceAnnotationUtils';

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

interface IOcrCompletePayload {
    pdfData: Uint8Array;
    sourceWorkingCopyPath: TDocumentRef;
}

type TSharedSaveOperationDeps = Pick<
    IFileOperationsDeps,
    | 'validatePdfPath'
    | 'saveFile'
    | 'saveWorkingCopy'
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
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
    resetSearchCache: () => void;
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
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        restorePendingEmbeddedAnnotationDeletes,
        clearAnnotationHistory,
        loadRecentFiles,
        clearOcrCache,
        loadPdfFromData,
        currentPage,
        waitForPdfReload,
        resetSearchCache,
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
        handleSaveAs: handleSaveAsWithReload,
    } = useFileOperations({
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        annotationComments,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
        getSourcePdfData,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        ...(hasLivePdfJsAnnotationChanges ? { hasLivePdfJsAnnotationChanges } : {}),
        ...(hasSavedPdfJsAnnotationBaselineChanges ? { hasSavedPdfJsAnnotationBaselineChanges } : {}),
        ...(hasPreservedAnnotationSourceChanges ? { hasPreservedAnnotationSourceChanges } : {}),
        hasShapeChanges: () => hasViewerShapeChanges(pdfViewerRef.value),
        hasManagedShapes: () => (pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
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
        preparePersistedShapeStateForSave: (data: Uint8Array) => (
            pdfViewerRef.value?.preparePersistedManagedShapesForSave?.(data) ?? Promise.resolve(null)
        ),
        restorePreparedPersistedShapeState: (snapshot: unknown) => (
            pdfViewerRef.value?.restorePreparedManagedShapesAfterFailedSave?.(snapshot) ?? Promise.resolve()
        ),
        adoptPersistedShapeStateForNextReload: () => pdfViewerRef.value?.adoptPersistedManagedShapesOnNextImport?.(),
        clearPendingPersistedShapeStateForNextReload: () => pdfViewerRef.value?.clearPendingManagedShapeImportAdoption?.(),
    });

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
    const isExportingDocxState = computed(() => isExportingDocx.value);
    const canSave = computed(() => (
        hasPendingUnsavedChanges
            ? hasPendingUnsavedChanges.value
            : (
                isDirty.value
                || annotationDirty.value
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
        await handleSaveWithReload();
    }

    async function handleSaveAs() {
        await handleSaveAsWithReload();
    }

    function saveForExternalRead() {
        return handleSaveWithReload();
    }

    async function handleOcrComplete(payload: IOcrCompletePayload) {
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Ignoring stale OCR result for inactive document', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            return;
        }

        const pageToRestore = currentPage.value;
        let restoreError: unknown = null;
        const warmupWorkingPath = payload.sourceWorkingCopyPath;
        const warmupPageCountHint = totalPages.value > 0 ? totalPages.value : undefined;

        clearOcrCache(payload.sourceWorkingCopyPath);
        resetSearchCache();

        const restorePromise = waitForPdfReload(pageToRestore).catch((error) => {
            restoreError = error;
        });

        try {
            await loadPdfFromData(payload.pdfData, {
                pushHistory: true,
                persistWorkingCopy: true,
            });
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR reload wait after document switch', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                void restorePromise;
                return;
            }

        } catch (error) {
            void restorePromise;
            throw error;
        }

        await restorePromise;
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Skipped stale OCR completion after document switch', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            return;
        }
        if (restoreError) {
            throw restoreError instanceof Error
                ? restoreError
                : new Error(String(restoreError));
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
        handleSaveAs,
        saveForExternalRead,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx: isExportingDocxState,
        canSave,
    };
};
