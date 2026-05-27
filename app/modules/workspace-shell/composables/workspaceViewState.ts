import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    TFitMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import { isAuthoringAnnotationTool } from '@app/composables/pdf/annotations/annotationRules';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

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
    hasLivePdfJsAnnotationChanges: Ref<boolean>;
    appAnnotationUndoDepth: Ref<number>;
    hasOpenAnnotationNotes: Ref<boolean>;
    canUndoHistory: Ref<boolean>;
    canRedoHistory: Ref<boolean>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    beginProgrammaticPageNavigation?: ((page: number) => void) | undefined;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        cancelCommentPlacement: () => void;
        applyFitWidthToCurrentPage?: () => Promise<boolean>;
    } | null>;
}

export const useWorkspaceViewState = (deps: IWorkspaceViewStateDeps) => {
    const isFitWidthActive = computed(
        () => deps.zoomMode.value === 'fit-width',
    );
    const isFitHeightActive = computed(
        () => deps.zoomMode.value === 'fit-height',
    );
    // App-routed PDF.js commands are undoable before live storage fingerprinting
    // necessarily reports a dirty annotation state.
    const hasAppAnnotationHistoryUndoState = computed(() => (
        deps.annotationEditorState.value.hasAppAnnotationUndoHistory === true
        || deps.annotationEditorState.value.hasAppAnnotationRedoHistory === true
    ));
    const hasLivePdfJsAnnotationUndoState = computed(() => (
        deps.hasLivePdfJsAnnotationChanges.value
        && (
            deps.annotationEditorState.value.hasSomethingToUndo
            || deps.annotationEditorState.value.hasSomethingToRedo
        )
    ));
    const isAnnotationUndoContext = computed(
        () => isAuthoringAnnotationTool(deps.annotationTool.value)
            || hasAppAnnotationHistoryUndoState.value
            || hasLivePdfJsAnnotationUndoState.value
            || deps.annotationEditorState.value.hasSomethingToRedo
            || deps.appAnnotationUndoDepth.value > 0,
    );
    const annotationCursorMode = computed(() => {
        if (deps.dragMode.value) {
            return false;
        }

        // In text-select mode we still want existing PDF annotations and
        // overlay-managed drawings to remain interactable/selectable. Hand tool
        // is the only state that should fully disable annotation interaction.
        return true;
    });
    const canUndo = computed(() => (
        isAnnotationUndoContext.value
            ? (
                (
                    deps.annotationEditorState.value.hasSomethingToUndo
                    && deps.hasLivePdfJsAnnotationChanges.value
                )
                || deps.annotationEditorState.value.hasAppAnnotationUndoHistory === true
                || deps.appAnnotationUndoDepth.value > 0
            )
            : deps.canUndoHistory.value
    ));
    const canRedo = computed(() => (
        isAnnotationUndoContext.value
            ? (
                (
                    deps.annotationEditorState.value.hasSomethingToRedo
                    && deps.hasLivePdfJsAnnotationChanges.value
                )
                || deps.annotationEditorState.value.hasSomethingToRedo
                || deps.annotationEditorState.value.hasAppAnnotationRedoHistory === true
            )
            : deps.canRedoHistory.value
    ));

    function handleFitMode(mode: TFitMode) {
        deps.zoom.value = 1;
        deps.fitMode.value = mode;
        deps.zoomMode.value = mode === 'height' ? 'fit-height' : 'fit-width';

        if (mode === 'width') {
            void nextTick(() => deps.pdfViewerRef.value?.applyFitWidthToCurrentPage?.());
        }
    }

    function enableDragMode() {
        deps.dragMode.value = true;
        deps.pdfViewerRef.value?.cancelCommentPlacement();
        deps.annotationPlacingPageNote.value = false;
        if (deps.annotationTool.value !== 'none') {
            deps.annotationTool.value = 'none';
        }
    }

    function normalizeNavigationPage(page: number) {
        const maxPage = Math.max(1, Math.trunc(deps.totalPages.value || page || 1));
        const requestedPage = Number.isFinite(page) ? Math.trunc(page) : deps.currentPage.value;
        return Math.min(Math.max(requestedPage, 1), maxPage);
    }

    function handleGoToPage(page: number) {
        const targetPage = normalizeNavigationPage(page);
        const wasAlreadyCurrentPage = deps.currentPage.value === targetPage;
        BrowserLogger.warn('pdf-nav', `[workspace-go-to-page] requested=${page}`, {
            requestedPage: page,
            targetPage,
            wasAlreadyCurrentPage,
            hasViewer: Boolean(deps.pdfViewerRef.value),
            sidebarOpen: deps.showSidebar.value,
            sidebarTab: deps.sidebarTab.value,
            dragMode: deps.dragMode.value,
            annotationTool: deps.annotationTool.value,
            isPlacingNote: deps.annotationPlacingPageNote.value,
        });
        logPdfRenderTrace('workspace-go-to-page', {
            requestedPage: page,
            targetPage,
            currentPageBefore: deps.currentPage.value,
            wasAlreadyCurrentPage,
            hasViewer: Boolean(deps.pdfViewerRef.value),
        });
        deps.beginProgrammaticPageNavigation?.(targetPage);
        deps.currentPage.value = targetPage;
        if (wasAlreadyCurrentPage) {
            logPdfRenderTrace('workspace-go-to-page-skip-scroll-duplicate', { targetPage });
            return;
        }
        deps.pdfViewerRef.value?.scrollToPage(targetPage);
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
};
