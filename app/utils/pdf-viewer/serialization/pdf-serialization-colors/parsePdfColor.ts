import { clamp } from 'es-toolkit/math';
import { parseHexColor } from '@app/utils/color';

export function parsePdfColor(color: string | undefined): [number, number, number] | null {
    if (!color || color === 'transparent' || color === 'none') {
        return null;
    }

    const trimmed = color.trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(trimmed)) {
        return parseHexColor(trimmed);
    }

    const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/iu);
    if (!rgbMatch) {
        return null;
    }

    const values = rgbMatch.slice(1, 4).map(value => clamp(Number(value), 0, 255) / 255);
    if (values.some(value => !Number.isFinite(value))) {
        return null;
    }
    return [
        values[0]!,
        values[1]!,
        values[2]!,
    ];
}
