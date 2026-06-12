import type { IAnnotationMarkerRect } from '@app/types/annotations';
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

export function sampleCanvasTextMarkupColorInRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
) {
    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    if (
        canvasRect.width <= 0
        || canvasRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return null;
    }
    const viewportLeft = pageRect.left + targetRect.left * pageRect.width;
    const viewportTop = pageRect.top + targetRect.top * pageRect.height;
    const viewportWidth = targetRect.width * pageRect.width;
    const viewportHeight = targetRect.height * pageRect.height;
    const sampleLeft = Math.max(canvasRect.left, viewportLeft);
    const sampleTop = Math.max(canvasRect.top, viewportTop);
    const sampleRight = Math.min(canvasRect.right, viewportLeft + viewportWidth);
    const sampleBottom = Math.min(canvasRect.bottom, viewportTop + viewportHeight);
    if (sampleRight <= sampleLeft || sampleBottom <= sampleTop) {
        return null;
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const left = Math.max(0, Math.floor((sampleLeft - canvasRect.left) * scaleX));
    const top = Math.max(0, Math.floor((sampleTop - canvasRect.top) * scaleY));
    const right = Math.min(canvas.width, Math.ceil((sampleRight - canvasRect.left) * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil((sampleBottom - canvasRect.top) * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        return null;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return null;
    }

    const counts = new Map<string, number>();
    const pixels: Uint8ClampedArray = data.data;
    const stride = Math.max(1, Math.floor(Math.min(width, height) / 180));
    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            const index = (y * width + x) * 4;
            const r = pixels[index]!;
            const g = pixels[index + 1]!;
            const b = pixels[index + 2]!;
            const alpha = pixels[index + 3]!;
            const score = colorDistanceScoreFromPoint(0, 0, r, g, b, alpha);
            if (score === null) {
                continue;
            }
            const color = nearestAnnotationSwatch(r, g, b);
            counts.set(color, (counts.get(color) ?? 0) + 1);
        }
    }

    let bestColor: string | null = null;
    let bestCount = 0;
    for (const [
        color,
        count,
    ] of counts) {
        if (count > bestCount) {
            bestColor = color;
            bestCount = count;
        }
    }
    return bestColor;
}
