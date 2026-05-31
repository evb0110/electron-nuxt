import { clamp } from 'es-toolkit/math';
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

function clampOpacity(value: number) {
    return Number.isFinite(value)
        ? clamp(value, 0, 1)
        : 1;
}

function toRgbaString(
    r: number,
    g: number,
    b: number,
    opacity: number,
) {
    return `rgba(${r}, ${g}, ${b}, ${clampOpacity(opacity)})`;
}

function parseHexColor(value: string) {
    const match = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    const hex = match?.groups?.hex;
    if (!hex) {
        return null;
    }
    const expanded = hex.length === 3
        ? hex.split('').map(channel => channel + channel).join('')
        : hex;
    return {
        r: Number.parseInt(expanded.slice(0, 2), 16),
        g: Number.parseInt(expanded.slice(2, 4), 16),
        b: Number.parseInt(expanded.slice(4, 6), 16),
    };
}

function applyOpacityToCssString(value: string, opacity: number) {
    const normalizedOpacity = clampOpacity(opacity);
    if (normalizedOpacity >= 1) {
        return value;
    }

    const hex = parseHexColor(value);
    if (hex) {
        return toRgbaString(hex.r, hex.g, hex.b, normalizedOpacity);
    }

    const trimmed = value.trim();
    if (/^rgba\(/i.test(trimmed)) {
        return value;
    }
    const rgbMatch = /^rgb\((?<channels>.+)\)$/i.exec(trimmed);
    const channels = rgbMatch?.groups?.channels
        ?.split(',')
        .map(channel => Number.parseFloat(channel.trim()));
    if (channels?.length === 3 && channels.every(channel => Number.isFinite(channel))) {
        return toRgbaString(channels[0]!, channels[1]!, channels[2]!, normalizedOpacity);
    }

    return value;
}

function isNumericRgbChannels(value: unknown): value is ArrayLike<number> {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const candidate = value as ArrayLike<unknown>;
    if (typeof candidate.length !== 'number' || candidate.length < 3) {
        return false;
    }
    for (let index = 0; index < 3; index += 1) {
        if (typeof candidate[index] !== 'number') {
            return false;
        }
    }
    return true;
}

export function toCssColor(
    color: string | ArrayLike<number> | {
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
        return applyOpacityToCssString(color, opacity);
    }

    if (isNumericRgbChannels(color)) {
        return toRgbaString(color[0]!, color[1]!, color[2]!, opacity);
    }

    if (isRgbObject(color)) {
        return toRgbaString(color.r, color.g, color.b, opacity);
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
