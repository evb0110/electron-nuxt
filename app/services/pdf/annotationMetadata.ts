import { PDFDateString } from '@app/services/pdfjs/runtimeLib';

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
    return direct && direct.length > 0 ? direct : null;
}
