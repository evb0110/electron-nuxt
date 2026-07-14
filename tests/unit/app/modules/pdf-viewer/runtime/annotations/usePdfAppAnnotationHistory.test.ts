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
    it('keeps app history availability out of the internal PDF.js state', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const emittedStates: IAnnotationEditorState[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: state => emittedStates.push(state),
            markModified: vi.fn(),
        });

        history.registerCommand({
            cmd: vi.fn(),
            undo: vi.fn(),
        });

        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(false);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasAppAnnotationUndoHistory: true,
        });
    });

    it('reports app-owned executor command availability without rewriting native state', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const emittedStates: IAnnotationEditorState[] = [];
        const markModified = vi.fn();
        const undo = vi.fn();
        const cmd = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: state => emittedStates.push(state),
            markModified,
        });

        history.registerExecutorCommand({
            cmd,
            undo,
        });
        pdfjsAnnotationState.value = createAnnotationState({ hasSomethingToUndo: true });

        expect(history.undo()).toBe(true);

        expect(undo).toHaveBeenCalledOnce();
        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(true);
        expect(pdfjsAnnotationState.value.hasSomethingToRedo).toBe(false);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasSomethingToRedo: true,
            hasAppAnnotationUndoHistory: false,
            hasAppAnnotationRedoHistory: true,
        });

        expect(history.redo()).toBe(true);

        expect(cmd).toHaveBeenCalledOnce();
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasSomethingToRedo: false,
            hasAppAnnotationUndoHistory: true,
            hasAppAnnotationRedoHistory: false,
        });
        expect(markModified).toHaveBeenCalledTimes(2);
    });

    it('uses only captured executor operations owned by the app history', () => {
        const undo = vi.fn();
        const cmd = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.registerExecutorCommand({
            undo,
            cmd,
        });

        expect(history.undo()).toBe(true);
        expect(undo).toHaveBeenCalledOnce();
        expect(history.redo()).toBe(true);
        expect(cmd).toHaveBeenCalledOnce();
    });

    it('groups canonical and executor commands into one user-visible history step', () => {
        const calls: string[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });

        history.runTransaction(() => {
            history.registerExecutorCommand({
                cmd: () => calls.push('executor-redo'),
                undo: () => calls.push('executor-undo'),
            });
            history.registerCommand({
                cmd: () => calls.push('canonical-redo'),
                undo: () => calls.push('canonical-undo'),
            });
        });

        expect(history.undo()).toBe(true);
        expect(history.canUndo.value).toBe(false);
        expect(calls).toEqual([
            'canonical-undo',
            'executor-undo',
        ]);
        expect(history.redo()).toBe(true);
        expect(calls).toEqual([
            'canonical-undo',
            'executor-undo',
            'executor-redo',
            'canonical-redo',
        ]);
    });

    it('bounds retained annotation commands to its 16 MiB share of the global undo budget', () => {
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        const undone: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            history.registerCommand({
                cmd: vi.fn(),
                undo: () => undone.push(index),
                estimatedBytes: 8 * 1024 * 1024,
            });
        }

        expect(history.undo()).toBe(true);
        expect(history.undo()).toBe(true);
        expect(history.undo()).toBe(false);
        expect(undone).toEqual([
            2,
            1,
        ]);
    });

    it('registers annotation commands directly with the workspace ledger sink', async () => {
        const registrations: Array<{
            source: string;
            undo: () => Promise<boolean> | boolean;
            cmd: () => Promise<boolean> | boolean;
            estimatedBytes?: number;
        }> = [];
        const reset = vi.fn();
        const undo = vi.fn();
        const cmd = vi.fn();
        const markModified = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified,
        });
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command),
            reset,
        });

        history.registerCommand({
            undo,
            cmd,
            estimatedBytes: 2048,
        });

        expect(history.canUndo.value).toBe(false);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            source: 'annotation',
            estimatedBytes: 2048,
        });
        await expect(Promise.resolve(registrations[0]?.undo())).resolves.toBe(true);
        await expect(Promise.resolve(registrations[0]?.cmd())).resolves.toBe(true);
        expect(undo).toHaveBeenCalledOnce();
        expect(cmd).toHaveBeenCalledOnce();
        expect(markModified).toHaveBeenCalledTimes(2);

        history.clear();
        expect(reset).toHaveBeenCalledWith('annotation');
    });

    it('runs the projection replay effect after workspace undo and redo', async () => {
        const registrations: Array<{
            undo: () => Promise<boolean> | boolean;
            cmd: () => Promise<boolean> | boolean;
        }> = [];
        const calls: string[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: () => calls.push('modified'),
        });
        history.setReplayEffect(() => calls.push('projection-sync'));
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command),
            reset: vi.fn(),
        });
        history.registerCommand({
            undo: () => calls.push('undo'),
            cmd: () => calls.push('redo'),
        });

        await registrations[0]?.undo();
        await registrations[0]?.cmd();

        expect(calls).toEqual([
            'undo',
            'modified',
            'projection-sync',
            'redo',
            'modified',
            'projection-sync',
        ]);
    });
});
