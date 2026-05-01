import type { Ref } from 'vue';
import {
    type IDocumentTransitionDeps,
    useDocumentTransitions,
} from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import { useWorkspaceUiSyncWatchers } from '@app/modules/workspace-shell/composables/workspace-ui-sync';
import type { TTabUpdate } from '@app/types/tabs';
import type { TDocumentRef } from '@contracts/platform-api';

interface IWorkspaceDocumentLifecycleEffectsOptions extends IDocumentTransitionDeps {
    pendingDjvu: Ref<TDocumentRef | null>;
    openDjvuFile: (
        djvuPath: TDocumentRef,
        loadPdfFromPath: (path: TDocumentRef) => Promise<void>,
        getCurrentPage?: () => number,
        setPage?: (page: number) => void,
        setOriginalPath?: (path: TDocumentRef | null) => void,
        closeFile?: () => void | Promise<void>,
    ) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef) => Promise<void>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        clearShapes: () => void;
        cancelCommentPlacement: () => void;
    } | null>;
    originalPath: Ref<TDocumentRef | null>;
    closeFile: () => void | Promise<void>;
    openBatchProgress: Ref<{
        processed: number;
        total: number;
    } | null>;
    isActive: Ref<boolean>;
    fileName: Ref<string | null>;
    hasPendingTabChanges: Readonly<Ref<boolean>>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    showSettings: Ref<boolean>;
    emitUpdateTab: (updates: TTabUpdate) => void;
    emitOpenSettings: () => void;
    onOpenDjvuError: (error: unknown) => void;
}

export function useWorkspaceDocumentLifecycleEffects(options: IWorkspaceDocumentLifecycleEffectsOptions) {
    const {
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
        closeFile,
        openBatchProgress,
        isActive,
        fileName,
        hasPendingTabChanges,
        isDjvuMode,
        djvuSourcePath,
        showSettings,
        emitUpdateTab,
        emitOpenSettings,
        onOpenDjvuError,
        pdfSrc,
        totalPages,
        pdfDocument,
        workingCopyPath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    } = options;

    useWorkspaceUiSyncWatchers({
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
        closeFile,
        openBatchProgress,
        isActive,
        fileName,
        isDirty: hasPendingTabChanges,
        isDjvuMode,
        djvuSourcePath,
        showSettings,
        emitUpdateTab,
        emitOpenSettings,
        onOpenDjvuError,
    });

    useDocumentTransitions({
        pdfSrc,
        currentPage,
        totalPages,
        pdfDocument,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    });
}
