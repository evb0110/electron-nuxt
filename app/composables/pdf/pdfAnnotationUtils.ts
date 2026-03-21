import { PDFDateString } from '@app/services/pdfjs/runtime-lib';
import type {
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';

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

export function isTextMarkupSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    return (
        normalized === 'highlight'
        || normalized === 'underline'
        || normalized === 'squiggly'
        || normalized === 'strikeout'
    );
}
