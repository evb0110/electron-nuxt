import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/workspaceViewState';

function createState(options?: { dragMode?: boolean; }) {
    return useWorkspaceViewState({
        fitMode: ref('width'),
        zoomMode: ref('fit-width'),
        zoom: ref(1),
        dragMode: ref(
            options?.dragMode ?? false,
        ),
        showSidebar: ref(false),
        sidebarTab: ref('thumbnails'),
        annotationTool: ref('none'),
        annotationPlacingPageNote: ref(false),
        annotationEditorState: ref({
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        }),
        hasLivePdfJsAnnotationChanges: ref(false),
        appAnnotationUndoDepth: ref(0),
        hasOpenAnnotationNotes: ref(false),
        canUndoHistory: ref(false),
        canRedoHistory: ref(false),
        currentPage: ref(1),
        totalPages: ref(1),
        pdfViewerRef: ref({
            scrollToPage: () => {},
            cancelCommentPlacement: () => {},
        }),
    });
}

describe('useWorkspaceViewState', () => {
    it('marks fit width active at zoom 1', () => {
        const state = createState();
        expect(state.isFitWidthActive.value).toBe(true);
        expect(state.isFitHeightActive.value).toBe(false);
    });

    it('resets zoom when fit mode changes via helper', () => {
        const state = createState();
        state.handleFitMode('height');

        expect(state.isFitHeightActive.value).toBe(true);
        expect(state.isFitWidthActive.value).toBe(false);
    });

    it('disables annotation cursor when drag mode is enabled', () => {
        const state = createState({ dragMode: true });
        expect(state.annotationCursorMode.value).toBe(false);
    });

    it('keeps annotation cursor enabled outside hand-tool mode', () => {
        const state = createState();
        expect(state.annotationCursorMode.value).toBe(true);
    });

    it('enables annotation undo for app-managed annotation commands', () => {
        const appAnnotationUndoDepth = ref(1);
        const state = useWorkspaceViewState({
            fitMode: ref('width'),
            zoomMode: ref('fit-width'),
            zoom: ref(1),
            dragMode: ref(false),
            showSidebar: ref(false),
            sidebarTab: ref('thumbnails'),
            annotationTool: ref('none'),
            annotationPlacingPageNote: ref(false),
            annotationEditorState: ref({
                isEditing: false,
                isEmpty: true,
                hasSomethingToUndo: false,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
            }),
            hasLivePdfJsAnnotationChanges: ref(false),
            appAnnotationUndoDepth,
            hasOpenAnnotationNotes: ref(false),
            canUndoHistory: ref(false),
            canRedoHistory: ref(false),
            currentPage: ref(1),
            totalPages: ref(1),
            pdfViewerRef: ref({
                scrollToPage: () => {},
                cancelCommentPlacement: () => {},
            }),
        });

        expect(state.isAnnotationUndoContext.value).toBe(true);
        expect(state.canUndo.value).toBe(true);

        appAnnotationUndoDepth.value = 0;
        expect(state.canUndo.value).toBe(false);
    });

    it('ignores stale PDF.js annotation undo state when file history can undo', () => {
        const state = useWorkspaceViewState({
            fitMode: ref('width'),
            zoomMode: ref('fit-width'),
            zoom: ref(1),
            dragMode: ref(false),
            showSidebar: ref(false),
            sidebarTab: ref('annotations'),
            annotationTool: ref('none'),
            annotationPlacingPageNote: ref(false),
            annotationEditorState: ref({
                isEditing: false,
                isEmpty: false,
                hasSomethingToUndo: true,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
            }),
            hasLivePdfJsAnnotationChanges: ref(false),
            appAnnotationUndoDepth: ref(0),
            hasOpenAnnotationNotes: ref(false),
            canUndoHistory: ref(true),
            canRedoHistory: ref(false),
            currentPage: ref(1),
            totalPages: ref(1),
            pdfViewerRef: ref({
                scrollToPage: () => {},
                cancelCommentPlacement: () => {},
            }),
        });

        expect(state.isAnnotationUndoContext.value).toBe(false);
        expect(state.canUndo.value).toBe(true);
    });

    it('enables app-routed PDF.js annotation undo before live dirty detection catches up', () => {
        const state = useWorkspaceViewState({
            fitMode: ref('width'),
            zoomMode: ref('fit-width'),
            zoom: ref(1),
            dragMode: ref(false),
            showSidebar: ref(false),
            sidebarTab: ref('annotations'),
            annotationTool: ref('none'),
            annotationPlacingPageNote: ref(false),
            annotationEditorState: ref({
                isEditing: false,
                isEmpty: false,
                hasSomethingToUndo: true,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
                hasAppAnnotationUndoHistory: true,
            }),
            hasLivePdfJsAnnotationChanges: ref(false),
            appAnnotationUndoDepth: ref(0),
            hasOpenAnnotationNotes: ref(false),
            canUndoHistory: ref(false),
            canRedoHistory: ref(false),
            currentPage: ref(1),
            totalPages: ref(1),
            pdfViewerRef: ref({
                scrollToPage: () => {},
                cancelCommentPlacement: () => {},
            }),
        });

        expect(state.isAnnotationUndoContext.value).toBe(true);
        expect(state.canUndo.value).toBe(true);
    });
});
