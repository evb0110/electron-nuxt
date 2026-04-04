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
    IPdfPersistResult,
    IPdfPageLabelRange,
    IPdfSaveResult,
    IScrollSnapshot,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platform-api';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';
import { useFileOperations } from '@app/composables/useFileOperations';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import {
    capturePdfReloadSnapshot,
    createPdfReloadWaiter,
} from '@app/composables/pdf/pdfReloadWaiter';

interface IPdfViewerForSave {
    scrollToPage: (pageNumber: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    saveDocument: () => Promise<Uint8Array | null>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    hasShapes?: boolean;
}

interface IPageSaveOrchestrationDeps {
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
    markAnnotationSaved: () => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    isDirty: Ref<boolean>;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    readWorkingCopyBytes: () => Promise<Uint8Array | null>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfSaveResult['validation']>;
    saveFile: (data: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopy: (opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopyAs: (data?: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
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
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        hasPendingUnsavedChanges,
        readWorkingCopyBytes,
        validatePdfData,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
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
        readWorkingCopyBytes,
        validatePdfData,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        hasShapeChanges: () => Boolean(pdfViewerRef.value?.hasShapes),
        serializePdfForSave,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        annotationNoteWindowsCount,
        loadRecentFiles,
        preparePostSaveReload: () => {
            const capturedReloadState = capturePdfReloadSnapshot(pdfViewerRef.value, currentPage.value);
            currentPage.value = capturedReloadState.pageToRestore;

            return createPdfReloadWaiter({
                pdfDocument,
                pdfViewerRef,
                resetSearchCache,
                pageToRestore: capturedReloadState.pageToRestore,
                scrollSnapshot: capturedReloadState.scrollSnapshot,
            });
        },
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

    async function handleOcrComplete(ocrPdfData: Uint8Array) {
        const pageToRestore = currentPage.value;
        let restoreError: unknown = null;
        const warmupWorkingPath = workingCopyPath.value;
        const warmupPageCountHint = totalPages.value > 0 ? totalPages.value : undefined;

        if (workingCopyPath.value) {
            clearOcrCache(workingCopyPath.value);
        }

        const restorePromise = waitForPdfReload(pageToRestore).catch((error) => {
            restoreError = error;
        });

        try {
            await loadPdfFromData(ocrPdfData, {
                pushHistory: true,
                persistWorkingCopy: !!workingCopyPath.value,
            });

            if (warmupWorkingPath) {
                const api = getElectronAPI();
                // Prewarm search index and worker caches after OCR persistence so
                // first user search does not pay the indexing setup cost.
                void api.search.warmIndex(warmupWorkingPath, {pageCount: warmupPageCountHint}).catch((error) => {
                    const warmIndexError: unknown = error;
                    BrowserLogger.debug('pdf-search', 'Failed to prewarm search index after OCR', {
                        path: warmupWorkingPath,
                        pageCount: warmupPageCountHint,
                        error: warmIndexError,
                    });
                });
            }
        } catch (error) {
            void restorePromise;
            throw error;
        }

        await restorePromise;
        if (restoreError) {
            throw restoreError instanceof Error
                ? restoreError
                : new Error(String(restoreError));
        }
    }

    return {
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        embedPlacedImageToPage,
        updateEmbeddedByRef,
        deleteEmbeddedByRef,
        rewritePageLabels,
        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx: isExportingDocxState,
        canSave,
    };
};
