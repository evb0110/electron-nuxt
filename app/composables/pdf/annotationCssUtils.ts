import type { IAnnotationCommentSummary } from '@app/types/annotations';

function isRgbObject(value: unknown): value is {
    r: number;
    g: number;
    b: number;
} {
    return typeof value === 'object'
        && value !== null
        && 'r' in value
        && 'g' in value
        && 'b' in value
        && typeof value.r === 'number'
        && typeof value.g === 'number'
        && typeof value.b === 'number';
}

export function toCssColor(
    color: string | number[] | {
        r: number;
        g: number;
        b: number;
    } | null | undefined,
    opacity = 1,
) {
    if (!color) {
        return null;
    }

    if (typeof color === 'string') {
        return color;
    }

    if (Array.isArray(color) && color.length >= 3) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`;
    }

    if (isRgbObject(color)) {
        return `rgba(${color.r}, ${color.g}, ${color.b}, ${opacity})`;
    }

    return null;
}

export function escapeCssAttr(value: string) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/"/g, '\\"');
}

export function errorToLogText(error: unknown) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();
    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `${message}\n${stack}`
        : message;
}

export function commentPreviewText(comment: IAnnotationCommentSummary, emptyNoteLabel: string) {
    const raw = comment.text.trim();
    if (!raw) {
        return emptyNoteLabel;
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}

export function commentPreviewFromRawText(text: string, emptyNoteLabel: string) {
    const raw = text.trim();
    if (!raw) {
        return emptyNoteLabel;
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}
