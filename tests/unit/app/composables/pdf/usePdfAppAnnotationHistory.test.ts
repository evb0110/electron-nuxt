import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import type { IAnnotationEditorState } from '@app/types/annotations';

function createAnnotationState(overrides: Partial<IAnnotationEditorState> = {}): IAnnotationEditorState {
    return {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
        ...overrides,
    };
}

describe('usePdfAppAnnotationHistory', () => {
    it('coalesces fallback PDF.js history commands by type', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });

        history.registerPdfjsCommand({});
        history.registerPdfjsCommand({ overwriteIfSameType: true });

        expect(history.canUndo.value).toBe(true);
        expect(history.undo({ undoPdfjs: vi.fn() })).toBe(true);
        expect(history.canUndo.value).toBe(false);
    });

    it('clears stale PDF.js undo state after a routed undo command', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const emittedStates: IAnnotationEditorState[] = [];
        const markModified = vi.fn();
        const undoPdfjs = vi.fn();
        const redoPdfjs = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: state => emittedStates.push(state),
            markModified,
        });

        history.registerPdfjsCommand({});
        pdfjsAnnotationState.value = createAnnotationState({ hasSomethingToUndo: true });

        expect(history.undo({ undoPdfjs })).toBe(true);

        expect(undoPdfjs).toHaveBeenCalledOnce();
        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(false);
        expect(pdfjsAnnotationState.value.hasSomethingToRedo).toBe(true);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: false,
            hasSomethingToRedo: true,
            hasAppAnnotationUndoHistory: false,
            hasAppAnnotationRedoHistory: true,
        });

        expect(history.redo({ redoPdfjs })).toBe(true);

        expect(redoPdfjs).toHaveBeenCalledOnce();
        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(true);
        expect(pdfjsAnnotationState.value.hasSomethingToRedo).toBe(false);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasSomethingToRedo: false,
            hasAppAnnotationUndoHistory: true,
            hasAppAnnotationRedoHistory: false,
        });
        expect(markModified).toHaveBeenCalledTimes(2);
    });
});
