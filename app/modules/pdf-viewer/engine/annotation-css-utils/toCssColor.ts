import { clamp } from 'es-toolkit/math';

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
        const red = channels[0];
        const green = channels[1];
        const blue = channels[2];
        if (red === undefined || green === undefined || blue === undefined) {
            return value;
        }
        return toRgbaString(red, green, blue, normalizedOpacity);
    }

    return value;
}

function readNumericRgbChannels(value: unknown): [number, number, number] | null {
    if (value === null || typeof value !== 'object' || !('length' in value)) {
        return null;
    }
    const r: unknown = Reflect.get(value, 0);
    const g: unknown = Reflect.get(value, 1);
    const b: unknown = Reflect.get(value, 2);
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') {
        return null;
    }
    return [
        r,
        g,
        b,
    ];
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

    const channels = readNumericRgbChannels(color);
    if (channels) {
        return toRgbaString(...channels, opacity);
    }

    if (isRgbObject(color)) {
        return toRgbaString(color.r, color.g, color.b, opacity);
    }

    return null;
}
