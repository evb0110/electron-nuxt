import type {
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
} from '@app/types/pdf';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';
import { rewriteBookmarks } from '@app/composables/pdf/usePdfBookmarkSerialization';
import { useFileOperations } from '@app/composables/useFileOperations';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

interface IPdfViewerForSave {
    saveDocument: () => Promise<Uint8Array | null>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

interface IPageSaveOrchestrationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfViewerForSave | null>;
    requestDocxExport: (selectedLanguages?: string[]) => Promise<boolean>;
    openOcrPopup: () => void;
    isExportingDocx: Ref<boolean>;
    workingCopyPath: Ref<string | null>;
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
    saveFile: (data: Uint8Array) => Promise<boolean>;
    saveWorkingCopy: () => Promise<boolean>;
    saveWorkingCopyAs: (data?: Uint8Array) => Promise<string | null>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    loadRecentFiles: () => void;
    clearOcrCache: (path: string) => void;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
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
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        loadRecentFiles,
        clearOcrCache,
        loadPdfFromData,
        currentPage,
        waitForPdfReload,
    } = deps;

    const {
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        rewriteEmbeddedNoteTexts,
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
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
    });

    const {
        handleSave,
        handleSaveAs,
    } = useFileOperations({
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        rewritePageLabels,
        rewriteBookmarks: (data) => rewriteBookmarks(data, {
            bookmarksDirty,
            bookmarkItems,
            totalPages,
            untitledLabel: t('bookmarks.untitled'),
        }),
        rewriteEmbeddedNoteTexts,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        annotationNoteWindowsCount,
        loadRecentFiles,
    });

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
    const isExportingDocxState = computed(() => isExportingDocx.value);
    const canSave = computed(() => isDirty.value || annotationDirty.value || pageLabelsDirty.value || bookmarksDirty.value);

    async function handleExportDocx(selectedLanguages?: string[]) {
        const result = await requestDocxExport(selectedLanguages);
        if (result === false) {
            openOcrPopup();
        }
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

            if (warmupWorkingPath && hasElectronAPI()) {
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
