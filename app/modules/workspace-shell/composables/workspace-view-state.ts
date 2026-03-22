import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import type {
    TFitMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IWorkspaceViewStateDeps {
    fitMode: Ref<TFitMode>;
    zoomMode: Ref<TZoomMode>;
    zoom: Ref<number>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    hasOpenAnnotationNotes: Ref<boolean>;
    canUndoHistory: Ref<boolean>;
    canRedoHistory: Ref<boolean>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        cancelCommentPlacement: () => void;
    } | null>;
}

export function useWorkspaceViewState(deps: IWorkspaceViewStateDeps) {
    const isFitWidthActive = computed(
        () => deps.zoomMode.value === 'fit-width',
    );
    const isFitHeightActive = computed(
        () => deps.zoomMode.value === 'fit-height',
    );
    const isAnnotationUndoContext = computed(
        () => deps.annotationTool.value !== 'none'
            || deps.annotationEditorState.value.hasSomethingToUndo
            || deps.annotationEditorState.value.hasSomethingToRedo,
    );
    const annotationCursorMode = computed(() => {
        if (deps.dragMode.value) {
            return false;
        }

        // Keep editor layer active while note windows are open, otherwise
        // PDF.js destroys their backing editors (see docs/freetext-note-persistence.md)
        return deps.annotationTool.value !== 'none'
            || deps.annotationEditorState.value.hasSelectedEditor
            || deps.hasOpenAnnotationNotes.value;
    });
    const canUndo = computed(() => (
        isAnnotationUndoContext.value
            ? deps.annotationEditorState.value.hasSomethingToUndo
            : deps.canUndoHistory.value
    ));
    const canRedo = computed(() => (
        isAnnotationUndoContext.value
            ? deps.annotationEditorState.value.hasSomethingToRedo
            : deps.canRedoHistory.value
    ));

    function handleFitMode(mode: TFitMode) {
        deps.zoom.value = 1;
        deps.fitMode.value = mode;
        deps.zoomMode.value = mode === 'height' ? 'fit-height' : 'fit-width';
    }

    function enableDragMode() {
        deps.dragMode.value = true;
        deps.pdfViewerRef.value?.cancelCommentPlacement();
        deps.annotationPlacingPageNote.value = false;
        if (deps.annotationTool.value !== 'none') {
            deps.annotationTool.value = 'none';
        }
    }

    function handleGoToPage(page: number) {
        BrowserLogger.warn('pdf-nav', `[workspace-go-to-page] requested=${page}`, {
            requestedPage: page,
            hasViewer: Boolean(deps.pdfViewerRef.value),
            sidebarOpen: deps.showSidebar.value,
            sidebarTab: deps.sidebarTab.value,
            dragMode: deps.dragMode.value,
            annotationTool: deps.annotationTool.value,
            isPlacingNote: deps.annotationPlacingPageNote.value,
        });
        deps.pdfViewerRef.value?.scrollToPage(page);
    }

    return {
        isFitWidthActive,
        isFitHeightActive,
        isAnnotationUndoContext,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleFitMode,
        enableDragMode,
        handleGoToPage,
    };
}
