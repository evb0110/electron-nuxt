import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
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

export function recolorCanvasTextMarkupPixelsInRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
    color: string,
    subtype: string,
    sourceColor: string | null = null,
) {
    const targetColor = parseCssRgbColor(color);
    if (!targetColor) {
        return false;
    }
    const sourceRgb = sourceColor ? parseCssRgbColor(sourceColor) : null;
    const sourceSwatch = sourceRgb ? nearestAnnotationSwatch(sourceRgb.r, sourceRgb.g, sourceRgb.b) : null;

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    if (
        canvasRect.width <= 0
        || canvasRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return false;
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
        return false;
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return false;
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
        return false;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return false;
    }

    const pixels = data.data;
    const isAnnotationPixel = (pixelIndex: number) => {
        const r = pixels[pixelIndex]!;
        const g = pixels[pixelIndex + 1]!;
        const b = pixels[pixelIndex + 2]!;
        const alpha = pixels[pixelIndex + 3]!;
        return colorDistanceScoreFromPoint(0, 0, r, g, b, alpha) !== null;
    };
    const lineBand = (() => {
        if (subtype === 'strikeout' || subtype === 'strikethrough') {
            return {
                end: Math.max(1, Math.ceil(height * 0.7)),
                start: Math.max(0, Math.floor(height * 0.3)),
            };
        }
        if (subtype === 'underline') {
            return {
                end: height,
                start: Math.max(0, Math.floor(height * 0.55)),
            };
        }
        return {
            end: height,
            start: 0,
        };
    })();
    const inferredSourceSwatch = (() => {
        if (subtype === 'highlight' || sourceSwatch) {
            return sourceSwatch;
        }
        const counts = new Map<string, number>();
        for (let y = lineBand.start; y < lineBand.end; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = (y * width + x) * 4;
                if (!isAnnotationPixel(index)) {
                    continue;
                }
                const swatch = nearestAnnotationSwatch(
                    pixels[index]!,
                    pixels[index + 1]!,
                    pixels[index + 2]!,
                );
                counts.set(swatch, (counts.get(swatch) ?? 0) + 1);
            }
        }
        let bestSwatch: string | null = null;
        let bestCount = 0;
        counts.forEach((count, swatch) => {
            if (count > bestCount) {
                bestSwatch = swatch;
                bestCount = count;
            }
        });
        return bestSwatch;
    })();
    const isLikelyLinePixel = (pixelOffset: number) => {
        if (subtype === 'highlight') {
            return true;
        }
        const currentSwatch = nearestAnnotationSwatch(
            pixels[pixelOffset]!,
            pixels[pixelOffset + 1]!,
            pixels[pixelOffset + 2]!,
        );
        if (inferredSourceSwatch && currentSwatch !== inferredSourceSwatch) {
            return false;
        }
        const x = (pixelOffset / 4) % width;
        const y = Math.floor((pixelOffset / 4) / width);
        if (y < lineBand.start || y >= lineBand.end) {
            return false;
        }
        let sameSwatchRun = 1;
        for (let above = y - 1; above >= 0; above -= 1) {
            const aboveIndex = (above * width + x) * 4;
            if (!isAnnotationPixel(aboveIndex)) {
                break;
            }
            if (nearestAnnotationSwatch(pixels[aboveIndex]!, pixels[aboveIndex + 1]!, pixels[aboveIndex + 2]!) === currentSwatch) {
                sameSwatchRun += 1;
            }
        }
        for (let below = y + 1; below < height; below += 1) {
            const belowIndex = (below * width + x) * 4;
            if (!isAnnotationPixel(belowIndex)) {
                break;
            }
            if (nearestAnnotationSwatch(pixels[belowIndex]!, pixels[belowIndex + 1]!, pixels[belowIndex + 2]!) === currentSwatch) {
                sameSwatchRun += 1;
            }
        }
        if (!inferredSourceSwatch && sameSwatchRun >= 2) {
            return false;
        }
        return true;
    };

    let recoloredPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (!isAnnotationPixel(index) || !isLikelyLinePixel(index)) {
            continue;
        }
        pixels[index] = targetColor.r;
        pixels[index + 1] = targetColor.g;
        pixels[index + 2] = targetColor.b;
        recoloredPixels += 1;
    }
    if (recoloredPixels === 0) {
        return false;
    }
    context.putImageData(data, left, top);
    return true;
}
