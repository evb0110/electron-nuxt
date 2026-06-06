import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    addUndoableEditorToLayer,
    clearSelectedEditorState,
    getEditorById,
    getEditorByUidFromLayer,
    selectCommentByUid,
    setEditorDefaultParamUpdater,
    setSelectedEditor,
    unselectAllEditors,
    updateEditorDefaultParams,
} from '@app/services/pdfjs/annotationEditorAdapter';

function asUiManager<T extends object>(value: T): AnnotationEditorUIManager {
    return value as AnnotationEditorUIManager;
}

describe('annotationEditorAdapter', () => {
    it('forwards selected editor to pdf.js ui manager', () => {
        const setSelected = vi.fn();
        const uiManager = asUiManager({ setSelected });
        const editor = { id: 'editor-1' } as IPdfjsEditor;

        setSelectedEditor(uiManager, editor);

        expect(setSelected).toHaveBeenCalledWith(editor);
    });

    it('reads editor by uid from layer only when runtime hooks are available', () => {
        const editor = { id: 'layer-editor' } as IPdfjsEditor;

        const missingLayer = getEditorByUidFromLayer(asUiManager({}), 0, 'uid-1');
        expect(missingLayer).toBeNull();

        const withLayer = getEditorByUidFromLayer(asUiManager({getLayer: vi.fn(() => ({getEditorByUID: vi.fn(() => editor)}))}), 2, 'uid-2');

        expect(withLayer).toEqual(editor);
    });

    it('preserves method binding for private-field-backed layer accessors', () => {
        const editor = { id: 'private-layer-editor' } as IPdfjsEditor;

        class PrivateLayer {
            #editors = new Map<string, IPdfjsEditor>();

            constructor() {
                this.#editors.set('uid-3', editor);
            }

            getEditorByUID(uid: string) {
                return this.#editors.get(uid) ?? null;
            }
        }

        class PrivateUiManager {
            #layers = new Map<number, PrivateLayer>();

            constructor() {
                this.#layers.set(2, new PrivateLayer());
            }

            getLayer(pageIndex: number) {
                return this.#layers.get(pageIndex) ?? null;
            }
        }

        const resolved = getEditorByUidFromLayer(
            asUiManager(new PrivateUiManager()),
            2,
            'uid-3',
        );

        expect(resolved).toEqual(editor);
    });

    it('selects comments only when selectComment runtime hook exists', () => {
        const withoutHook = selectCommentByUid(asUiManager({}), 1, 'abc');
        expect(withoutHook).toBe(false);

        const selectComment = vi.fn();
        const withHook = selectCommentByUid(asUiManager({ selectComment }), 3, 'xyz');

        expect(withHook).toBe(true);
        expect(selectComment).toHaveBeenCalledWith(3, 'xyz');
    });

    it('returns object editors by id and ignores non-object runtime values', () => {
        const missingHook = getEditorById(asUiManager({}), 'id-1');
        expect(missingHook).toBeNull();

        const invalidEditor = getEditorById(asUiManager({getEditor: vi.fn(() => 'not-an-editor')}), 'id-2');
        expect(invalidEditor).toBeNull();

        const editor = { id: 'id-3' } as IPdfjsEditor;
        const resolvedEditor = getEditorById(asUiManager({getEditor: vi.fn(() => editor)}), 'id-3');

        expect(resolvedEditor).toEqual(editor);
    });

    it('unselects editors only when manager supports unselectAll', () => {
        expect(unselectAllEditors(null)).toBe(false);
        expect(unselectAllEditors(asUiManager({}))).toBe(false);

        const unselectAll = vi.fn();
        const unselected = unselectAllEditors(asUiManager({ unselectAll }));

        expect(unselected).toBe(true);
        expect(unselectAll).toHaveBeenCalledOnce();
    });

    it('clears the active editor before unselecting selection state', () => {
        const setActiveEditor = vi.fn();
        const unselectAll = vi.fn();
        const cleared = clearSelectedEditorState(asUiManager({
            setActiveEditor,
            unselectAll,
        }));

        expect(cleared).toBe(true);
        expect(setActiveEditor).toHaveBeenCalledWith(null);
        expect(unselectAll).toHaveBeenCalledOnce();
        const setActiveCallOrder = setActiveEditor.mock.invocationCallOrder[0] ?? 0;
        const unselectAllCallOrder = unselectAll.mock.invocationCallOrder[0] ?? 0;
        expect(setActiveCallOrder).toBeLessThan(unselectAllCallOrder);
    });

    it('uses the runtime default-param updater when installed', () => {
        const uiManager = asUiManager({});
        const updater = vi.fn(() => true);

        setEditorDefaultParamUpdater(uiManager, updater);

        expect(updateEditorDefaultParams(uiManager, 31, '#2563eb')).toBe(true);
        expect(updater).toHaveBeenCalledWith(31, '#2563eb');
    });

    it('registers created editors through layer commands when available', () => {
        const remove = vi.fn();
        const rebuild = vi.fn();
        const addCommands = vi.fn();
        const editor = {
            id: 'created-highlight',
            remove,
            _uiManager: { rebuild },
        } as IPdfjsEditor;
        const layer = {
            div: {} as HTMLElement,
            addCommands,
            createAndAddNewEditor: vi.fn(),
        };

        expect(addUndoableEditorToLayer(layer, editor)).toBe(true);

        const command = addCommands.mock.calls[0]?.[0];
        expect(command).toMatchObject({ mustExec: false });
        command.undo();
        command.cmd();
        expect(remove).toHaveBeenCalledOnce();
        expect(rebuild).toHaveBeenCalledWith(editor);
    });

    it('marks undo commands whose app history is recorded externally', () => {
        const addCommands = vi.fn();
        const editor = {
            id: 'created-highlight',
            remove: vi.fn(),
        } as IPdfjsEditor;
        const layer = {
            div: {} as HTMLElement,
            addCommands,
            createAndAddNewEditor: vi.fn(),
        };

        expect(addUndoableEditorToLayer(layer, editor, { skipAppHistory: true })).toBe(true);

        expect(addCommands.mock.calls[0]?.[0]).toMatchObject({
            __evbSkipAppHistory: true,
            mustExec: false,
        });
    });

    it('runs editor history hooks around undo and redo commands', () => {
        const beforeUndo = vi.fn();
        const afterRedo = vi.fn();
        const remove = vi.fn();
        const rebuild = vi.fn();
        const addCommands = vi.fn();
        const editor = {
            id: 'created-highlight',
            remove,
            _uiManager: { rebuild },
        } as IPdfjsEditor;
        const layer = {
            div: {} as HTMLElement,
            addCommands,
            createAndAddNewEditor: vi.fn(),
        };

        expect(addUndoableEditorToLayer(layer, editor, {
            beforeUndo,
            afterRedo,
        })).toBe(true);

        const command = addCommands.mock.calls[0]?.[0];
        command.undo();
        command.cmd();

        expect(beforeUndo).toHaveBeenCalledWith(editor);
        expect(remove).toHaveBeenCalledOnce();
        expect(rebuild).toHaveBeenCalledWith(editor);
        expect(afterRedo).toHaveBeenCalledWith(editor);
    });
});
