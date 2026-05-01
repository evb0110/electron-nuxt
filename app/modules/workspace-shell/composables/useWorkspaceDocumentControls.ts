import type { Ref } from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
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
> {
    hasDocument: Ref<boolean>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: Ref<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    effectiveZoom: Ref<number>;
    canSave: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    handleSave: () => Promise<void>;
    totalPages: Ref<number>;
    selectedThumbnailPages: Ref<number[]>;
    setSelectedThumbnailPages: (pages: number[]) => void;
    requestThumbnailInvalidation: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        pages: number[];
    }>;
    closePageContextMenu: () => void;
    handleExportImages: (pages: number[]) => Promise<void>;
    ensureHistoryBaselineForExternalMutation: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    preparePdfReloadWaiter: (
        pageToRestore: number,
        opts?: { captureScrollSnapshot?: boolean },
    ) => {
        promise: Promise<void>;
        cancel: () => void;
    };
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
    pickFileToOpenWithDjvuCleanup: () => Promise<TOpenFileResult | null>;
    openFileWithDjvuCleanup: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirectWithDjvuCleanup: (path: TDocumentRef) => Promise<void>;
    openFileDirectBatchWithDjvuCleanup: (paths: TDocumentRef[]) => Promise<void>;
    closeFileWithDjvuCleanup: () => Promise<void>;
}

export function useWorkspaceDocumentControls(options: IWorkspaceDocumentControlsOptions) {
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
}
