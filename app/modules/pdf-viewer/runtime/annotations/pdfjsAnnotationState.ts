import type { IAnnotationEditorState } from '@app/types/annotations';

export interface IPdfjsAnnotationEditorState {
    isEditing: boolean;
    isEmpty: boolean;
    hasSomethingToUndo: boolean;
    hasSomethingToRedo: boolean;
    hasSelectedEditor: boolean;
}

export interface IAppAnnotationHistoryState {
    canUndo: boolean;
    canRedo: boolean;
}

const PDFJS_ANNOTATION_STATE_KEYS = [
    'isEditing',
    'isEmpty',
    'hasSomethingToUndo',
    'hasSomethingToRedo',
    'hasSelectedEditor',
] as const satisfies ReadonlyArray<keyof IPdfjsAnnotationEditorState>;

export function createEmptyPdfjsAnnotationEditorState(): IPdfjsAnnotationEditorState {
    return {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    };
}

export function decodePdfjsAnnotationStatePatch(
    value: unknown,
): Partial<IPdfjsAnnotationEditorState> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const patch: Partial<IPdfjsAnnotationEditorState> = {};
    for (const key of PDFJS_ANNOTATION_STATE_KEYS) {
        const fieldValue = record[key];
        if (typeof fieldValue === 'boolean') {
            patch[key] = fieldValue;
        }
    }
    return Object.keys(patch).length > 0 ? patch : null;
}

export function toCompatibleAnnotationEditorState(
    pdfjsState: IPdfjsAnnotationEditorState,
    appHistory: IAppAnnotationHistoryState,
): IAnnotationEditorState {
    return {
        ...pdfjsState,
        hasSomethingToUndo: pdfjsState.hasSomethingToUndo || appHistory.canUndo,
        hasSomethingToRedo: pdfjsState.hasSomethingToRedo || appHistory.canRedo,
        hasAppAnnotationUndoHistory: appHistory.canUndo,
        hasAppAnnotationRedoHistory: appHistory.canRedo,
    };
}
