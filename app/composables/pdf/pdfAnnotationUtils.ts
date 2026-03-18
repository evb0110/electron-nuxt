import { PDFDateString } from '@app/services/pdfjs/runtime-lib';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type {
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import {
    getOptionalFunction,
    getOptionalObject,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

export {
    clamp01, normalizeMarkerRect, toMarkerRectFromPdfRect, toPdfRectFromMarkerRect, markerRectIoU, rectIntersectionArea, rectIoU, rectCenterDistance, rectsIntersect, mergeMarkerRects,
} from '@app/composables/pdf/annotationGeometry';
export {
    toCssColor, colorWithOpacity, escapeCssAttr, errorToLogText, commentPreviewText, commentPreviewFromRawText, 
} from '@app/composables/pdf/annotationCssUtils';

export type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IAnnotationContextMenuPayload {
    comment: IAnnotationCommentSummary | null;
    clientX: number;
    clientY: number;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

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

export function parsePdfDateTimestamp(value: string | null | undefined) {
    if (!value) {
        return null;
    }

    try {
        const date = PDFDateString.toDateObject(value);
        if (!date) {
            return null;
        }
        return date.getTime();
    } catch {
        return null;
    }
}

export function toMarkerRectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    const editorDiv = editor.div ?? null;
    const pageContainer = editorDiv?.closest<HTMLElement>('.page_container') ?? null;
    const editorLayer = (
        editorDiv?.closest<HTMLElement>('.annotationEditorLayer')
        ?? editorDiv?.closest<HTMLElement>('.annotation-editor-layer')
        ?? editor.parent?.div
        ?? null
    );

    const normalizedDirect = normalizeMarkerRect({
        left: editor.x ?? Number.NaN,
        top: editor.y ?? Number.NaN,
        width: editor.width ?? Number.NaN,
        height: editor.height ?? Number.NaN,
    });

    const pageRect = pageContainer?.getBoundingClientRect() ?? null;
    const layerRect = editorLayer?.getBoundingClientRect() ?? null;
    const hasValidRects = Boolean(
        pageRect
        && layerRect
        && pageRect.width > 0
        && pageRect.height > 0
        && layerRect.width > 0
        && layerRect.height > 0,
    );
    const shouldConvertFromLayerSpace = Boolean(
        hasValidRects
        && (
            Math.abs((layerRect?.left ?? 0) - (pageRect?.left ?? 0)) > 0.5
            || Math.abs((layerRect?.top ?? 0) - (pageRect?.top ?? 0)) > 0.5
            || Math.abs((layerRect?.width ?? 0) - (pageRect?.width ?? 0)) > 0.5
            || Math.abs((layerRect?.height ?? 0) - (pageRect?.height ?? 0)) > 0.5
        ),
    );
    if (shouldConvertFromLayerSpace) {
        const normalizedFromLayerDims = normalizeMarkerRect({
            left: ((layerRect!.left - pageRect!.left) / pageRect!.width) + ((editor.x ?? Number.NaN) * (layerRect!.width / pageRect!.width)),
            top: ((layerRect!.top - pageRect!.top) / pageRect!.height) + ((editor.y ?? Number.NaN) * (layerRect!.height / pageRect!.height)),
            width: (editor.width ?? Number.NaN) * (layerRect!.width / pageRect!.width),
            height: (editor.height ?? Number.NaN) * (layerRect!.height / pageRect!.height),
        });
        if (normalizedFromLayerDims) {
            return normalizedFromLayerDims;
        }
    }

    if (normalizedDirect) {
        return normalizedDirect;
    }

    if (!editorDiv || !pageContainer) {
        return null;
    }
    const editorRect = editorDiv.getBoundingClientRect();
    if (
        !pageRect
        || pageRect.width <= 0
        || pageRect.height <= 0
        || editorRect.width <= 0
        || editorRect.height <= 0
    ) {
        return null;
    }
    const markerRectFromDom = normalizeMarkerRect({
        left: (editorRect.left - pageRect.left) / pageRect.width,
        top: (editorRect.top - pageRect.top) / pageRect.height,
        width: editorRect.width / pageRect.width,
        height: editorRect.height / pageRect.height,
    });
    return markerRectFromDom;
}

export function getAnnotationCommentText(annotation: {
    contents?: string;
    contentsObj?: { str?: string | null };
    richText?: { str?: string | null };
}) {
    const rich = annotation.richText?.str;
    if (typeof rich === 'string' && rich.trim().length > 0) {
        return rich;
    }
    const structured = annotation.contentsObj?.str;
    if (typeof structured === 'string' && structured.trim().length > 0) {
        return structured;
    }
    if (typeof rich === 'string' && rich.length > 0) {
        return rich;
    }
    if (typeof structured === 'string' && structured.length > 0) {
        return structured;
    }
    return annotation.contents ?? '';
}

export function getAnnotationAuthor(annotation: {
    titleObj?: { str?: string | null };
    title?: string;
}) {
    const withObj = annotation.titleObj?.str?.trim();
    if (withObj) {
        return withObj;
    }
    const direct = annotation.title?.trim();
    return direct || null;
}

type TTranslateLabel = TTranslateFn;
type TAnnotationLabelKey = Extract<TTranslationKey,
    | 'annotations.annotationLabel'
    | 'annotations.highlightLabel'
    | 'annotations.underlineLabel'
    | 'annotations.squiggleLabel'
    | 'annotations.strikeOutLabel'
    | 'annotations.popUpNoteLabel'
    | 'annotations.inlineNoteLabel'
    | 'annotations.freehandLineLabel'
    | 'annotations.lineLabel'
    | 'annotations.rectangleLabel'
    | 'annotations.circleLabel'
    | 'annotations.polygonLabel'
    | 'annotations.stamp'
    | 'annotations.imageLabel'
>;

export function annotationKindLabelFromSubtype(
    subtype: string | null | undefined,
    translate?: TTranslateLabel,
) {
    const label = (key: TAnnotationLabelKey, fallback: string) => (
        typeof translate === 'function'
            ? translate(key, undefined)
            : fallback
    );

    const normalized = (subtype ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'highlight':
            return label('annotations.highlightLabel', 'Highlight');
        case 'underline':
            return label('annotations.underlineLabel', 'Underline');
        case 'squiggly':
            return label('annotations.squiggleLabel', 'Squiggle');
        case 'strikeout':
            return label('annotations.strikeOutLabel', 'Strike Out');
        case 'text':
        case 'note-linked':
            return label('annotations.popUpNoteLabel', 'Pop-up Note');
        case 'freetext':
        case 'typewriter':
        case 'note-inline':
            return label('annotations.inlineNoteLabel', 'Inline Note');
        case 'ink':
            return label('annotations.freehandLineLabel', 'Freehand Line');
        case 'line':
        case 'straight-line':
            return label('annotations.lineLabel', 'Line');
        case 'square':
        case 'geomsquare':
        case 'rectangle':
            return label('annotations.rectangleLabel', 'Rectangle');
        case 'circle':
        case 'geomcircle':
        case 'ellipse':
            return label('annotations.circleLabel', 'Circle');
        case 'polygon':
            return label('annotations.polygonLabel', 'Polygon');
        case 'stamp':
            return label('annotations.imageLabel', 'Image');
        default:
            return label('annotations.annotationLabel', 'Annotation');
    }
}

export function isPopupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase() === 'popup';
}

export function isLinkSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase() === 'link';
}

export function detectEditorSubtype(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return null;
    }
    const className = editor.div?.className ?? '';
    if (className.includes('highlightEditor')) {
        return 'Highlight';
    }
    if (className.includes('freeTextEditor')) {
        return 'Typewriter';
    }
    if (className.includes('inkEditor')) {
        return 'Ink';
    }
    if (className.includes('stampEditor')) {
        return 'Stamp';
    }

    const constructorType = getOptionalString(
        getOptionalObject(editor, 'constructor'),
        '_type',
    );
    if (constructorType === 'freetext') {
        return 'Typewriter';
    }
    if (constructorType === 'highlight') {
        return 'Highlight';
    }
    if (constructorType === 'ink') {
        return 'Ink';
    }
    if (constructorType === 'stamp') {
        return 'Stamp';
    }

    const serialize = getOptionalFunction(editor, 'serialize');
    let serialized: unknown = null;
    try {
        serialized = serialize
            ? serialize.call(editor)
            : null;
    } catch {
        return null;
    }
    if (isRecord(serialized)) {
        const annotationType = getOptionalString(serialized, 'annotationType');
        if (annotationType === 'freetext') {
            return 'Typewriter';
        }
        if (annotationType === 'highlight') {
            return 'Highlight';
        }
        if (annotationType === 'ink') {
            return 'Ink';
        }
        if (annotationType === 'stamp') {
            return 'Stamp';
        }
    }
    return null;
}

export function isTextMarkupSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    return (
        normalized === 'highlight'
        || normalized === 'underline'
        || normalized === 'squiggly'
        || normalized === 'strikeout'
    );
}
