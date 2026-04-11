import { PDFDateString } from '@app/services/pdfjs/runtime-lib';
import type { TTranslationKey } from '@i18n-app';

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

export interface IAnnotationKindLabelDescriptor {
    key: TAnnotationLabelKey;
    fallback: string;
}

function createAnnotationKindLabelDescriptor(
    key: TAnnotationLabelKey,
    fallback: string,
): IAnnotationKindLabelDescriptor {
    return {
        key,
        fallback,
    };
}

export function annotationKindLabelFromSubtype(
    subtype: string | null | undefined,
): IAnnotationKindLabelDescriptor {
    const normalized = (subtype ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'highlight':
            return createAnnotationKindLabelDescriptor('annotations.highlightLabel', 'Highlight');
        case 'underline':
            return createAnnotationKindLabelDescriptor('annotations.underlineLabel', 'Underline');
        case 'squiggly':
            return createAnnotationKindLabelDescriptor('annotations.squiggleLabel', 'Squiggle');
        case 'strikeout':
            return createAnnotationKindLabelDescriptor('annotations.strikeOutLabel', 'Strike Out');
        case 'text':
        case 'note-linked':
            return createAnnotationKindLabelDescriptor('annotations.popUpNoteLabel', 'Pop-up Note');
        case 'freetext':
        case 'typewriter':
        case 'note-inline':
            return createAnnotationKindLabelDescriptor('annotations.inlineNoteLabel', 'Inline Note');
        case 'ink':
            return createAnnotationKindLabelDescriptor('annotations.freehandLineLabel', 'Freehand Line');
        case 'line':
        case 'straight-line':
            return createAnnotationKindLabelDescriptor('annotations.lineLabel', 'Line');
        case 'square':
        case 'geomsquare':
        case 'rectangle':
            return createAnnotationKindLabelDescriptor('annotations.rectangleLabel', 'Rectangle');
        case 'circle':
        case 'geomcircle':
        case 'ellipse':
            return createAnnotationKindLabelDescriptor('annotations.circleLabel', 'Circle');
        case 'polygon':
            return createAnnotationKindLabelDescriptor('annotations.polygonLabel', 'Polygon');
        case 'stamp':
            return createAnnotationKindLabelDescriptor('annotations.imageLabel', 'Image');
        default:
            return createAnnotationKindLabelDescriptor('annotations.annotationLabel', 'Annotation');
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
