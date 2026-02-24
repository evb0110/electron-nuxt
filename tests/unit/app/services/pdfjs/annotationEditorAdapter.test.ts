import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getEditorById,
    getEditorByUidFromLayer,
    selectCommentByUid,
    setSelectedEditor,
    unselectAllEditors,
} from '@app/services/pdfjs/annotationEditorAdapter';

function asUiManager(value: Record<string, unknown>): AnnotationEditorUIManager {
    return Object.assign({} as AnnotationEditorUIManager, value);
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
});
