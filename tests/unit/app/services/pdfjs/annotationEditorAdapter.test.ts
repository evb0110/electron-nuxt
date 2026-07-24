// @vitest-environment happy-dom

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
    assertAnnotationEditorRuntimeSmoke,
    clearSelectedEditorState,
    createAnnotationEditorAtPoint,
    createAnnotationEditorWithSyntheticPointer,
    getAnnotationStorageEditor,
    getAnnotationEditorRuntimeSmokeFailures,
    getEditorById,
    getEditorParentDimensions,
    getEditorByUidFromLayer,
    isEditorCommentDeleted,
    markEditorChangedExistingAnnotation,
    patchEditorResizeHandlers,
    patchEditorUpdateParams,
    selectCommentByUid,
    setEditorDefaultParamUpdater,
    setSelectedEditor,
    syncEditorToAnnotationStorage,
    unselectAllEditors,
    updateEditorDefaultParams,
    writeAnnotationStorageEditorComment,
} from '@app/services/pdfjs/annotationEditorAdapter';

function asUiManager<T extends object>(value: T): AnnotationEditorUIManager {
    return value as AnnotationEditorUIManager;
}

describe('annotationEditorAdapter', () => {
    it('smokes the current PDF.js annotation editor runtime hooks', async () => {
        const { AnnotationEditorUIManager } = await import('@app/services/pdfjs/runtimeLib');

        expect(getAnnotationEditorRuntimeSmokeFailures({ AnnotationEditorUIManager })).toEqual([]);
    });

    it('reports clear smoke failures for incompatible runtimes', () => {
        const IncompleteAnnotationEditorUIManager = vi.fn();

        const failures = getAnnotationEditorRuntimeSmokeFailures({AnnotationEditorUIManager: IncompleteAnnotationEditorUIManager});

        expect(failures).toContain('AnnotationEditorUIManager.getEditors is missing');
        expect(() => assertAnnotationEditorRuntimeSmoke({AnnotationEditorUIManager: IncompleteAnnotationEditorUIManager}))
            .toThrow(/PDF\.js annotation editor runtime is incompatible/u);
    });

    it('ignores selected editor requests when the runtime hook is missing', () => {
        const editor = { id: 'editor-1' } as IPdfjsEditor;

        expect(setSelectedEditor(asUiManager({}), editor)).toBe(false);
    });

    it('preserves method binding for selected editor runtime hooks', () => {
        const editor = { id: 'editor-1' } as IPdfjsEditor;

        class PrivateUiManager {
            #selected: unknown = null;

            setSelected(nextEditor: unknown) {
                this.#selected = nextEditor;
            }

            getSelected() {
                return this.#selected;
            }
        }

        const uiManager = new PrivateUiManager();

        expect(setSelectedEditor(asUiManager(uiManager), editor)).toBe(true);
        expect(uiManager.getSelected()).toBe(editor);
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
        const setSelected = vi.fn();
        const cleared = clearSelectedEditorState(asUiManager({
            setActiveEditor,
            unselectAll,
            setSelected,
        }));

        expect(cleared).toBe(true);
        expect(setActiveEditor).toHaveBeenCalledWith(null);
        expect(unselectAll).toHaveBeenCalledOnce();
        expect(setSelected).toHaveBeenCalledWith(null);
        const setActiveCallOrder = setActiveEditor.mock.invocationCallOrder[0] ?? 0;
        const unselectAllCallOrder = unselectAll.mock.invocationCallOrder[0] ?? 0;
        const setSelectedCallOrder = setSelected.mock.invocationCallOrder[0] ?? 0;
        expect(setActiveCallOrder).toBeLessThan(unselectAllCallOrder);
        expect(unselectAllCallOrder).toBeLessThan(setSelectedCallOrder);
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

    it('re-resolves an editor before undo and redo after a document reload', () => {
        const staleRemove = vi.fn();
        const currentRemove = vi.fn();
        const currentRebuild = vi.fn();
        const addCommands = vi.fn();
        const staleEditor = {
            id: 'stable-annotation-id',
            remove: staleRemove,
        } as IPdfjsEditor;
        const currentEditor = {
            id: 'stable-annotation-id',
            remove: currentRemove,
            _uiManager: {rebuild: currentRebuild},
        } as IPdfjsEditor;
        const layer = {
            div: {} as HTMLElement,
            addCommands,
            createAndAddNewEditor: vi.fn(),
        };

        expect(addUndoableEditorToLayer(layer, staleEditor, {resolveEditor: () => currentEditor})).toBe(true);

        const command = addCommands.mock.calls[0]?.[0];
        command.undo();
        command.cmd();

        expect(staleRemove).not.toHaveBeenCalled();
        expect(currentRemove).toHaveBeenCalledOnce();
        expect(currentRebuild).toHaveBeenCalledWith(currentEditor);
    });

    it('creates annotation editors through the layer factory with normalized point data', () => {
        const div = document.createElement('div');
        Object.defineProperty(div, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({
                left: 10,
                top: 20,
                width: 100,
                height: 200,
                right: 110,
                bottom: 220,
                x: 10,
                y: 20,
                toJSON: () => ({}),
            }),
        });
        const editor = { id: 'created-at-point' } as IPdfjsEditor;
        const createAndAddNewEditor = vi.fn(() => editor);
        const uiManager = asUiManager({getLayer: vi.fn(() => ({
            div,
            createAndAddNewEditor,
        }))});

        expect(createAnnotationEditorAtPoint(uiManager, 0, div, 25, 75)).toBe(editor);

        expect(createAndAddNewEditor).toHaveBeenCalledWith(
            expect.objectContaining({
                button: 0,
                clientX: 25,
                clientY: 75,
                offsetX: 15,
                offsetY: 55,
                pointerType: 'mouse',
            }),
            false,
        );
    });

    it('creates selection editors through the synthetic pointer adapter', () => {
        const editor = { id: 'created-selection' } as IPdfjsEditor;
        const createAndAddNewEditor = vi.fn(() => editor);
        const layer = {
            div: document.createElement('div'),
            createAndAddNewEditor,
        };
        const payload = {
            methodOfCreation: 'toolbar',
            text: 'selected text',
        };

        expect(createAnnotationEditorWithSyntheticPointer(layer, payload)).toBe(editor);

        expect(createAndAddNewEditor).toHaveBeenCalledWith(
            expect.objectContaining({
                button: 0,
                pointerType: 'mouse',
            }),
            false,
            payload,
        );
    });

    it('wraps FreeText resize hooks while preserving original method binding', () => {
        const onResizing = vi.fn();
        const onResized = vi.fn();

        class EditorWithPrivateResizeHooks {
            resizingCount = 0;
            resizedCount = 0;

            _onResizing() {
                this.resizingCount += 1;
            }

            _onResized() {
                this.resizedCount += 1;
            }
        }

        const editor = new EditorWithPrivateResizeHooks() as IPdfjsEditor & EditorWithPrivateResizeHooks;

        patchEditorResizeHandlers(editor, {
            onResizing,
            onResized,
        });
        editor._onResizing?.();
        editor._onResized?.();

        expect(editor.resizingCount).toBe(1);
        expect(editor.resizedCount).toBe(1);
        expect(onResizing).toHaveBeenCalledOnce();
        expect(onResized).toHaveBeenCalledOnce();
    });

    it('wraps editor updateParams while preserving the original this binding', () => {
        class EditorWithUpdateParams {
            params: Array<[number, unknown]> = [];

            updateParams(type: number, value: unknown) {
                this.params.push([
                    type,
                    value,
                ]);
            }
        }

        const editor = new EditorWithUpdateParams() as IPdfjsEditor & EditorWithUpdateParams;
        const handler = vi.fn((original, type: number, value: unknown) => original(type, value));

        expect(patchEditorUpdateParams(editor, handler)).toBe(true);
        editor.updateParams?.(11, 14);

        expect(handler).toHaveBeenCalledOnce();
        expect(editor.params).toEqual([[
            11,
            14,
        ]]);
    });

    it('routes editor storage, comment, and changed-annotation access through named helpers', () => {
        const addToAnnotationStorage = vi.fn();
        const storedEditor = { id: 'stored' } as IPdfjsEditor;
        const getEditor = vi.fn(() => storedEditor);
        const addChangedExistingAnnotation = vi.fn();
        const editor = {
            annotationElementId: '42R0',
            addToAnnotationStorage,
            comment: { deleted: true },
            _uiManager: { addChangedExistingAnnotation },
        } as IPdfjsEditor;

        writeAnnotationStorageEditorComment(editor, 'persisted text');

        expect(editor.comment).toBe('persisted text');
        expect(addToAnnotationStorage).toHaveBeenCalledOnce();
        expect(syncEditorToAnnotationStorage(editor)).toBe(true);
        expect(getAnnotationStorageEditor({ annotationStorage: { getEditor } }, '42R0')).toBe(storedEditor);
        expect(getEditor).toHaveBeenCalledWith('42R0');
        editor.comment = { deleted: true };
        expect(isEditorCommentDeleted(editor)).toBe(true);
        expect(markEditorChangedExistingAnnotation(null, editor)).toBe(true);
        expect(addChangedExistingAnnotation).toHaveBeenCalledWith(editor);
    });

    it('reads finite parent dimensions from private FreeText geometry state', () => {
        expect(getEditorParentDimensions({ parentDimensions: [
            400,
            800,
        ] } as IPdfjsEditor)).toEqual({
            parentW: 400,
            parentH: 800,
        });
        expect(getEditorParentDimensions({ parentDimensions: [
            400,
            Number.NaN,
        ] } as IPdfjsEditor)).toBeNull();
    });
});
