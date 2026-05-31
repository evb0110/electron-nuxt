import { clamp } from 'es-toolkit/math';

export interface IRgbColor {
    b: number;
    g: number;
    r: number;
}

export function clampRgbChannel(value: number) {
    return clamp(Math.round(value), 0, 255);
}

export function parseCssRgbColor(value: string | null | undefined): IRgbColor | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    const hexMatch = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    const hex = hexMatch?.groups?.hex;
    if (hex) {
        const expanded = hex.length === 3
            ? hex.split('').map(channel => channel + channel).join('')
            : hex;
        return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
        };
    }

    const rgbMatch = /^rgba?\((?<channels>.+)\)$/i.exec(trimmed);
    const rawChannels = rgbMatch?.groups?.channels;
    if (!rawChannels) {
        return null;
    }

    const channels = rawChannels
        .match(/-?\d*\.?\d+%?/g)
        ?.slice(0, 3)
        .map((channel) => {
            const isPercent = channel.endsWith('%');
            const parsed = Number.parseFloat(isPercent ? channel.slice(0, -1) : channel);
            return Number.isFinite(parsed)
                ? clampRgbChannel(isPercent ? (parsed / 100) * 255 : parsed)
                : Number.NaN;
        });
    if (!channels || channels.length < 3 || channels.some(channel => !Number.isFinite(channel))) {
        return null;
    }

    return {
        r: channels[0]!,
        g: channels[1]!,
        b: channels[2]!,
    };
}

export function blendRgbAgainstWhite(color: IRgbColor, opacity: number): IRgbColor {
    const normalizedOpacity = clamp(opacity, 0, 1);
    const white = 255 * (1 - normalizedOpacity);
    return {
        r: clampRgbChannel(color.r * normalizedOpacity + white),
        g: clampRgbChannel(color.g * normalizedOpacity + white),
        b: clampRgbChannel(color.b * normalizedOpacity + white),
    };
}

export function rgbToHex(color: IRgbColor) {
    return `#${
        [
            color.r,
            color.g,
            color.b,
        ].map(channel => clampRgbChannel(channel).toString(16).padStart(2, '0')).join('')
    }`;
}

export function toOpaqueHighlightDisplayRgbColor(
    color: string | null | undefined,
    opacity: number,
) {
    const parsed = parseCssRgbColor(color);
    if (!parsed) {
        return null;
    }
    return blendRgbAgainstWhite(parsed, opacity);
}

export function toOpaqueHighlightDisplayColor(
    color: string,
    opacity: number,
) {
    const displayColor = toOpaqueHighlightDisplayRgbColor(color, opacity);
    return displayColor ? rgbToHex(displayColor) : color;
}
