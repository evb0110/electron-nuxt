import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import {
    getOptionalFunction,
    getOptionalObject,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

function getEditorComment(editor: IPdfjsEditor) {
    try {
        return editor.comment;
    } catch {
        return null;
    }
}

export function getCommentText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }
    const comment = getEditorComment(editor);
    if (typeof comment === 'string') {
        return comment;
    }
    if (comment && typeof comment.text === 'string') {
        return comment.text;
    }
    return '';
}

export function getEditorSelectionPreviewText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }

    const explicitText = editor.__evbSelectionText?.trim();
    if (explicitText) {
        return explicitText;
    }

    return editor.div?.getAttribute('aria-label')?.trim() ?? '';
}

export function hasEditorCommentPayload(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return false;
    }
    const comment = getEditorComment(editor);
    if (typeof comment === 'string') {
        return comment.trim().length > 0;
    }
    if (comment && typeof comment === 'object') {
        const text = typeof comment.text === 'string'
            ? comment.text.trim()
            : '';
        const deleted = comment.deleted === true;
        return !deleted && text.length > 0;
    }
    return false;
}

interface IEditorContainers {
    editorDiv: HTMLElement | null;
    pageContainer: HTMLElement | null;
    editorLayer: HTMLElement | null;
}

function findEditorContainers(editor: IPdfjsEditor): IEditorContainers {
    const editorDiv = editor.div ?? null;
    const pageContainer = editorDiv?.closest<HTMLElement>('.page_container') ?? null;
    const editorLayer = (
        editorDiv?.closest<HTMLElement>('.annotationEditorLayer')
        ?? editorDiv?.closest<HTMLElement>('.annotation-editor-layer')
        ?? editor.parent?.div
        ?? null
    );
    return {
        editorDiv,
        pageContainer,
        editorLayer,
    };
}

function computeDirectMarkerRect(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    return normalizeMarkerRect({
        left: editor.x ?? Number.NaN,
        top: editor.y ?? Number.NaN,
        width: editor.width ?? Number.NaN,
        height: editor.height ?? Number.NaN,
    });
}

function hasPositiveSize(rect: DOMRect | null): rect is DOMRect {
    return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function hasMeaningfulLayerOffset(pageRect: DOMRect, layerRect: DOMRect): boolean {
    return Math.abs(layerRect.left - pageRect.left) > 0.5
        || Math.abs(layerRect.top - pageRect.top) > 0.5
        || Math.abs(layerRect.width - pageRect.width) > 0.5
        || Math.abs(layerRect.height - pageRect.height) > 0.5;
}

function convertEditorRectFromLayerSpace(
    editor: IPdfjsEditor,
    pageRect: DOMRect,
    layerRect: DOMRect,
): IAnnotationMarkerRect | null {
    const editorX = editor.x ?? Number.NaN;
    const editorY = editor.y ?? Number.NaN;
    const editorWidth = editor.width ?? Number.NaN;
    const editorHeight = editor.height ?? Number.NaN;
    const widthRatio = layerRect.width / pageRect.width;
    const heightRatio = layerRect.height / pageRect.height;
    return normalizeMarkerRect({
        left: ((layerRect.left - pageRect.left) / pageRect.width) + (editorX * widthRatio),
        top: ((layerRect.top - pageRect.top) / pageRect.height) + (editorY * heightRatio),
        width: editorWidth * widthRatio,
        height: editorHeight * heightRatio,
    });
}

function computeMarkerRectFromBoundingRects(
    editorDiv: HTMLElement,
    pageRect: DOMRect,
): IAnnotationMarkerRect | null {
    const editorRect = editorDiv.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0 || editorRect.width <= 0 || editorRect.height <= 0) {
        return null;
    }
    return normalizeMarkerRect({
        left: (editorRect.left - pageRect.left) / pageRect.width,
        top: (editorRect.top - pageRect.top) / pageRect.height,
        width: editorRect.width / pageRect.width,
        height: editorRect.height / pageRect.height,
    });
}

export function toMarkerRectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    const {
        editorDiv,
        pageContainer,
        editorLayer,
    } = findEditorContainers(editor);

    const normalizedDirect = computeDirectMarkerRect(editor);

    const pageRect = pageContainer?.getBoundingClientRect() ?? null;
    const layerRect = editorLayer?.getBoundingClientRect() ?? null;
    if (
        hasPositiveSize(pageRect)
        && hasPositiveSize(layerRect)
        && hasMeaningfulLayerOffset(pageRect, layerRect)
    ) {
        const normalizedFromLayerDims = convertEditorRectFromLayerSpace(editor, pageRect, layerRect);
        if (normalizedFromLayerDims) {
            return normalizedFromLayerDims;
        }
    }

    if (normalizedDirect) {
        return normalizedDirect;
    }

    if (!editorDiv || !pageContainer || !pageRect) {
        return null;
    }
    return computeMarkerRectFromBoundingRects(editorDiv, pageRect);
}

export function detectEditorSubtype(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return null;
    }

    return detectSubtypeFromClassName(editor.div?.className ?? '')
        ?? detectSubtypeFromPdfjsType(getOptionalString(getOptionalObject(editor, 'constructor'), '_type'))
        ?? detectSubtypeFromSerializedEditor(editor);
}

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
