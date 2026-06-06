import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getOptionalFunction,
    getOptionalObject,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

const editorSubtypeByClassName = [
    [
        'highlightEditor',
        'Highlight',
    ],
    [
        'freeTextEditor',
        'Typewriter',
    ],
    [
        'inkEditor',
        'Ink',
    ],
    [
        'stampEditor',
        'Stamp',
    ],
] as const;

const editorSubtypeByPdfjsType = {
    freetext: 'Typewriter',
    highlight: 'Highlight',
    ink: 'Ink',
    stamp: 'Stamp',
} as const;

function detectSubtypeFromClassName(className: string) {
    return editorSubtypeByClassName.find(([token]) => className.includes(token))?.[1] ?? null;
}

function detectSubtypeFromPdfjsType(type: string | null | undefined) {
    return type && type in editorSubtypeByPdfjsType
        ? editorSubtypeByPdfjsType[type as keyof typeof editorSubtypeByPdfjsType]
        : null;
}

function detectSubtypeFromSerializedEditor(editor: IPdfjsEditor) {
    const serialize = getOptionalFunction(editor, 'serialize');
    let serialized: unknown = null;
    try {
        serialized = serialize
            ? serialize.call(editor)
            : null;
    } catch {
        return null;
    }
    return isRecord(serialized)
        ? detectSubtypeFromPdfjsType(getOptionalString(serialized, 'annotationType'))
        : null;
}

export function detectEditorSubtype(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return null;
    }

    return detectSubtypeFromClassName(editor.div?.className ?? '')
        ?? detectSubtypeFromPdfjsType(getOptionalString(getOptionalObject(editor, 'constructor'), '_type'))
        ?? detectSubtypeFromSerializedEditor(editor);
}
