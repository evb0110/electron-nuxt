import type { Ref } from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import {
    type IPageOpsHandlersDeps,
    usePageOpsHandlers,
} from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import {
    type IPageFileOperationsDeps,
    usePageFileOperations,
} from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';

interface IWorkspaceDocumentControlsOptions extends Omit<IPageFileOperationsDeps,
    'closeFile'
    | 'openFile'
    | 'openFileDirect'
    | 'openFileDirectBatch'
    | 'pickFileToOpen'
>, Omit<IPageOpsHandlersDeps,
    'invalidateThumbnailPages'
    | 'onExportPages'
    | 'onExtractedDocument'
    | 'pdfViewerRef'
    > {
    hasDocument: Ref<boolean>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: Ref<TDocumentRef | null>;
    effectiveZoom: Ref<number>;
    canSave: Ref<boolean>;
    handleSave: () => Promise<void>;
    requestThumbnailInvalidation: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    handleExportImages: (pages: number[]) => Promise<void>;
    pickFileToOpenWithDjvuCleanup: () => Promise<TOpenFileResult | null>;
    openFileWithDjvuCleanup: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirectWithDjvuCleanup: (path: TDocumentRef) => Promise<void>;
    openFileDirectBatchWithDjvuCleanup: (paths: TDocumentRef[]) => Promise<void>;
    closeFileWithDjvuCleanup: () => Promise<void>;
}

export const useWorkspaceDocumentControls = (options: IWorkspaceDocumentControlsOptions) => {
    const {
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        currentPage,
        effectiveZoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        handleExportImages,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
    } = options;

    const pageStatusBar = usePageStatusBar({
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        effectiveZoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    });

    const pageOpsHandlers = usePageOpsHandlers({
        workingCopyPath,
        currentPage,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        invalidateThumbnailPages: requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        onExportPages: (pages: number[]) => {
            void handleExportImages(pages);
        },
        onExtractedDocument: (path: TDocumentRef) => {
            emitOpenInNewTab(path);
        },
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
    });

    const pageFileOperations = usePageFileOperations({
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen: pickFileToOpenWithDjvuCleanup,
        openFile: openFileWithDjvuCleanup,
        openFileDirect: openFileDirectWithDjvuCleanup,
        openFileDirectBatch: openFileDirectBatchWithDjvuCleanup,
        closeFile: closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
    });

    return {
        ...pageStatusBar,
        ...pageOpsHandlers,
        ...pageFileOperations,
    };
};
