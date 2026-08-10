import { clamp } from 'es-toolkit/math';

export function parsePdfColor(color: string | undefined): [number, number, number] | null {
    if (!color || color === 'transparent' || color === 'none') {
        return null;
    }

    const trimmed = color.trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(trimmed)) {
        const clean = trimmed.slice(1);
        if (clean.length === 3) {
            return [
                Number.parseInt(clean[0]! + clean[0]!, 16) / 255,
                Number.parseInt(clean[1]! + clean[1]!, 16) / 255,
                Number.parseInt(clean[2]! + clean[2]!, 16) / 255,
            ];
        }
        return [
            Number.parseInt(clean.slice(0, 2), 16) / 255,
            Number.parseInt(clean.slice(2, 4), 16) / 255,
            Number.parseInt(clean.slice(4, 6), 16) / 255,
        ];
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
