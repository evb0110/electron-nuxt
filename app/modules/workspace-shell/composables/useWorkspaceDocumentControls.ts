import type {
    ComputedRef,
    Ref,
} from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import type { IPageOpsHandlersDeps } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IPageFileOperationsDeps } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IWorkspacePdfViewerDocumentControlsPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

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
    originalPath: TReadableRef<TDocumentRef | null>;
    effectiveZoom: Ref<number>;
    isDocumentVisualPending?: Ref<boolean>;
    canSave: Ref<boolean>;
    handleSave: () => Promise<unknown>;
    requestThumbnailInvalidation: (pages: number[]) => void;
    pdfViewerRef: Ref<IWorkspacePdfViewerDocumentControlsPort | null>;
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
        isDocumentVisualPending,
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
        isDjvuMode,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        ensureWorkingCopyFreshForRead,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress,
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
        ...(isDocumentVisualPending ? { isDocumentVisualPending } : {}),
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
        onExportPages: (pages) => {
            void handleExportImages(pages);
        },
        ...(isDjvuMode !== undefined ? { isDjvuMode } : {}),
        onExtractedDocument: (path) => {
            emitOpenInNewTab(path);
        },
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        ...(ensureWorkingCopyFreshForRead !== undefined ? { ensureWorkingCopyFreshForRead } : {}),
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ...(options.runWithDocumentOperationLease !== undefined
            ? { runWithDocumentOperationLease: options.runWithDocumentOperationLease }
            : {}),
    });

    const pageFileOperations = usePageFileOperations({
        pdfSrc,
        hasDocument,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        ...(isDocumentOperationInProgress !== undefined ? { isDocumentOperationInProgress } : {}),
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
