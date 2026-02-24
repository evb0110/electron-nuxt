import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { IAnnotationEditorState } from '@app/types/annotations';
import { usePageAnnotationTools } from '@app/composables/usePageAnnotationTools';

function createEditorState(overrides: Partial<IAnnotationEditorState> = {}): IAnnotationEditorState {
    return {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
        ...overrides,
    };
}

function createHarness() {
    const viewer = {
        cancelCommentPlacement: vi.fn(),
        selectedShapeId: { value: null as string | null },
        updateShape: vi.fn(),
    };

    const deps = {
        pdfViewerRef: ref(viewer),
        dragMode: ref(true),
        markDirty: vi.fn(),
        clearAnnotationChanges: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
    };

    return {
        viewer,
        deps,
        tools: usePageAnnotationTools(deps),
    };
}

describe('usePageAnnotationTools', () => {
    it('switches tools and clears placement/context state', () => {
        const {
            deps,
            viewer,
            tools,
        } = createHarness();

        tools.annotationPlacingPageNote.value = true;
        tools.handleAnnotationToolChange('highlight');

        expect(tools.annotationTool.value).toBe('highlight');
        expect(deps.dragMode.value).toBe(false);
        expect(viewer.cancelCommentPlacement).toHaveBeenCalledOnce();
        expect(tools.annotationPlacingPageNote.value).toBe(false);
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('propagates shape setting updates to selected shape', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        viewer.selectedShapeId.value = 'shape-1';

        tools.handleAnnotationSettingChange({
            key: 'shapeStrokeWidth',
            value: 5,
        });
        tools.handleAnnotationSettingChange({
            key: 'shapeFillColor',
            value: 'transparent',
        });

        expect(tools.annotationSettings.value.shapeStrokeWidth).toBe(5);
        expect(tools.annotationSettings.value.shapeFillColor).toBe('transparent');
        expect(viewer.updateShape).toHaveBeenNthCalledWith(1, 'shape-1', { strokeWidth: 5 });
        expect(viewer.updateShape).toHaveBeenNthCalledWith(2, 'shape-1', { fillColor: undefined });
    });

    it('tracks dirty state across editor undo transitions and save/reset', () => {
        const {
            deps,
            tools,
        } = createHarness();

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));

        expect(deps.markDirty).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(true);

        tools.markAnnotationSaved();
        expect(tools.annotationDirty.value).toBe(false);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));
        expect(tools.annotationDirty.value).toBe(false);

        tools.markAnnotationDirty();
        expect(tools.annotationDirty.value).toBe(true);

        tools.resetAnnotationTracking();
        expect(tools.annotationRevision.value).toBe(0);
        expect(tools.annotationSavedRevision.value).toBe(0);
        expect(tools.annotationDirty.value).toBe(false);
    });

    it('clears annotation storage markers when undo stack becomes empty', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(false);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));
        expect(tools.annotationDirty.value).toBe(true);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));

        expect(deps.clearAnnotationChanges).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(false);
    });

    it('keeps annotation dirty when changes still exist after undo stack is empty', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(true);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));
        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));

        expect(deps.clearAnnotationChanges).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(true);
    });
});
