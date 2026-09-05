import { clamp } from 'es-toolkit/math';

export function parsePdfColor(color: string | undefined): [number, number, number] | null {
    if (!color || color === 'transparent' || color === 'none') {
        return null;
    }

    const trimmed = color.trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(trimmed)) {
        const clean = trimmed.slice(1);
        if (clean.length === 3) {
            const red = clean[0];
            const green = clean[1];
            const blue = clean[2];
            if (red === undefined || green === undefined || blue === undefined) {
                return null;
            }
            return [
                Number.parseInt(red + red, 16) / 255,
                Number.parseInt(green + green, 16) / 255,
                Number.parseInt(blue + blue, 16) / 255,
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
    const [
        red,
        green,
        blue,
    ] = values;
    if (red === undefined || green === undefined || blue === undefined) {
        return null;
    }
    return [
        red,
        green,
        blue,
    ];
}
