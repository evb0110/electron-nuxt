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
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

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
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFileWithDjvuCleanup: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirectWithDjvuCleanup: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatchWithDjvuCleanup: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
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
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        pickFileToOpen,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
        removeRecentFile,
        notifyMissingRecentFile,
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
        hasDocument,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen,
        openFile: openFileWithDjvuCleanup,
        openFileDirect: openFileDirectWithDjvuCleanup,
        openFileDirectBatch: openFileDirectBatchWithDjvuCleanup,
        closeFile: closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
        removeRecentFile,
        notifyMissingRecentFile,
    });

    return {
        ...pageStatusBar,
        ...pageOpsHandlers,
        ...pageFileOperations,
    };
};
