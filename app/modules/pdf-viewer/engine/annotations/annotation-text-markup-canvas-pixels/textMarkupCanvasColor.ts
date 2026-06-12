import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import type {
    IAnnotationSwatchRgb,
    IRgbColor,
} from '@app/modules/pdf-viewer/engine/text-markup-color/rgbColor';

function colorDistanceScoreFromPoint(
    dx: number,
    dy: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
) {
    if (alpha < 32) {
        return null;
    }
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 245 && min > 245) {
        return null;
    }
    if (max < 50) {
        return null;
    }
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.18) {
        return null;
    }
    return (saturation * max) - Math.hypot(dx, dy) * 18;
}

function parseHexColor(value: string): IRgbColor | null {
    const match = /^#(?<r>[0-9a-f]{2})(?<g>[0-9a-f]{2})(?<b>[0-9a-f]{2})$/iu.exec(value);
    const groups = match?.groups;
    if (!groups?.r || !groups.g || !groups.b) {
        return null;
    }
    return {
        r: Number.parseInt(groups.r, 16),
        g: Number.parseInt(groups.g, 16),
        b: Number.parseInt(groups.b, 16),
    };
}

const ANNOTATION_SWATCH_RGB: IAnnotationSwatchRgb[] = ANNOTATION_COLOR_SWATCHES.flatMap((color) => {
    const rgb = parseHexColor(color);
    return rgb
        ? [{
            color,
            rgb,
        }]
        : [];
});

function nearestAnnotationSwatch(r: number, g: number, b: number) {
    let bestColor: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of ANNOTATION_SWATCH_RGB) {
        const distance = Math.hypot(
            r - entry.rgb.r,
            g - entry.rgb.g,
            b - entry.rgb.b,
        );
        if (distance < bestDistance) {
            bestColor = entry.color;
            bestDistance = distance;
        }
    }
    if (bestColor) {
        return bestColor;
    }
    return rgbToHex({
        r,
        g,
        b,
    });
}

export const textMarkupCanvasColor = {
    colorDistanceScoreFromPoint,
    nearestAnnotationSwatch,
};
