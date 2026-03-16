import type { Ref } from 'vue';
import { useDocumentTransitions } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import { setupWorkspaceUiSyncWatchers } from '@app/modules/workspace-shell/composables/workspace-ui-sync';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';
import type { TTabUpdate } from '@app/types/tabs';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IWorkspaceDocumentLifecycleEffectsOptions {
    pendingDjvu: Ref<string | null>;
    openDjvuFile: (
        djvuPath: string,
        loadPdfFromPath: (path: string) => Promise<void>,
        getCurrentPage?: () => number,
        setPage?: (page: number) => void,
        setOriginalPath?: (path: string | null) => void,
    ) => Promise<void>;
    loadPdfFromPath: (path: string) => Promise<void>;
    currentPage: Ref<number>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        clearShapes: () => void;
        cancelCommentPlacement: () => void;
    } | null>;
    originalPath: Ref<string | null>;
    openBatchProgress: Ref<{
        processed: number;
        total: number;
    } | null>;
    isActive: Ref<boolean>;
    fileName: Ref<string | null>;
    hasPendingTabChanges: Readonly<Ref<boolean>>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<string | null>;
    showSettings: Ref<boolean>;
    emitUpdateTab: (updates: TTabUpdate) => void;
    emitOpenSettings: () => void;
    onOpenDjvuError: (error: unknown) => void;
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<string | null>;
    pdfError: Ref<unknown>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    annotationPlacingPageNote: Ref<boolean>;
    bookmarkItems: Ref<unknown[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkEditMode: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<unknown[]>;
    pageLabelsDirty: Ref<boolean>;
    resetAnnotationTracking: () => void;
    resetSearchCache: () => void;
    closeSearch: () => void;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeAllAnnotationNotes: (opts?: { saveIfDirty?: boolean }) => Promise<boolean>;
    loadRecentFiles: () => void;
}

export function useWorkspaceDocumentLifecycleEffects(options: IWorkspaceDocumentLifecycleEffectsOptions) {
    const {
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
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

    setupWorkspaceUiSyncWatchers({
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
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
