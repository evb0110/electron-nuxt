import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createEmptyPdfjsAnnotationEditorState,
    decodePdfjsAnnotationStatePatch,
    toCompatibleAnnotationEditorState,
} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';

describe('pdfjsAnnotationState', () => {
    it('decodes only supported boolean state fields', () => {
        expect(decodePdfjsAnnotationStatePatch({
            isEditing: true,
            isEmpty: 'false',
            hasSomethingToUndo: true,
            hasSomethingToRedo: 1,
            hasSelectedEditor: false,
            unexpected: true,
        })).toEqual({
            isEditing: true,
            hasSomethingToUndo: true,
            hasSelectedEditor: false,
        });
    });

    it.each([
        null,
        undefined,
        [],
        'state',
        {},
        { isEditing: 1 },
    ])(
        'rejects payloads without a supported boolean field',
        (value) => {
            expect(decodePdfjsAnnotationStatePatch(value)).toBeNull();
        },
    );

    it('combines internal pdf.js and app history without mutating either source', () => {
        const pdfjsState = createEmptyPdfjsAnnotationEditorState();
        const appHistory = {
            canUndo: true,
            canRedo: false,
        };

        expect(toCompatibleAnnotationEditorState(pdfjsState, appHistory)).toEqual({
            ...pdfjsState,
            hasSomethingToUndo: true,
            hasSomethingToRedo: false,
            hasAppAnnotationUndoHistory: true,
            hasAppAnnotationRedoHistory: false,
        });
        expect(pdfjsState.hasSomethingToUndo).toBe(false);
    });
});
