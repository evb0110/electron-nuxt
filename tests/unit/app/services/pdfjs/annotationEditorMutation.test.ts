import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {AnnotationEditorUIManager} from 'pdfjs-dist';
import {deleteEditorWithUiManager} from '@app/services/pdfjs/annotationEditorMutation';

describe('deleteEditorWithUiManager', () => {
    it('commits active work before selecting the undoable deletion target', () => {
        const calls: string[] = [];
        const editor = {id: 'pdfjs_internal_editor_0'};
        const uiManager: AnnotationEditorUIManager = Object.assign(Object.create(null), {
            commitOrRemove: vi.fn(() => calls.push('commit')),
            setSelected: vi.fn((selected: unknown) => {
                expect(selected).toBe(editor);
                calls.push('select');
            }),
            delete: vi.fn(() => calls.push('delete')),
        });

        expect(deleteEditorWithUiManager(uiManager, editor, {logDebug: vi.fn()})).toBe(true);
        expect(calls).toEqual([
            'commit',
            'select',
            'delete',
        ]);
    });
});
