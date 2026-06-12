import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { textMarkupCanvasColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/textMarkupCanvasColor';
import { traverseTextMarkupCanvasRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/traverseTextMarkupCanvasRect';

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
    const sourceSwatch = sourceRgb
        ? textMarkupCanvasColor.nearestAnnotationSwatch(sourceRgb.r, sourceRgb.g, sourceRgb.b)
        : null;
    const image = traverseTextMarkupCanvasRect(
        canvas,
        pageContainer,
        targetRect,
    );
    if (!image) {
        return false;
    }

    const pixels = image.data.data;
    const isAnnotationPixel = (pixelIndex: number) => {
        const r = pixels[pixelIndex]!;
        const g = pixels[pixelIndex + 1]!;
        const b = pixels[pixelIndex + 2]!;
        const alpha = pixels[pixelIndex + 3]!;
        return textMarkupCanvasColor.colorDistanceScoreFromPoint(0, 0, r, g, b, alpha) !== null;
    };
    const lineBand = (() => {
        if (subtype === 'strikeout' || subtype === 'strikethrough') {
            return {
                end: Math.max(1, Math.ceil(image.height * 0.7)),
                start: Math.max(0, Math.floor(image.height * 0.3)),
            };
        }
        if (subtype === 'underline') {
            return {
                end: image.height,
                start: Math.max(0, Math.floor(image.height * 0.55)),
            };
        }
        return {
            end: image.height,
            start: 0,
        };
    })();
    const inferredSourceSwatch = (() => {
        if (subtype === 'highlight' || sourceSwatch) {
            return sourceSwatch;
        }
        const counts = new Map<string, number>();
        for (let y = lineBand.start; y < lineBand.end; y += 1) {
            for (let x = 0; x < image.width; x += 1) {
                const index = (y * image.width + x) * 4;
                if (!isAnnotationPixel(index)) {
                    continue;
                }
                const swatch = textMarkupCanvasColor.nearestAnnotationSwatch(
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
        const currentSwatch = textMarkupCanvasColor.nearestAnnotationSwatch(
            pixels[pixelOffset]!,
            pixels[pixelOffset + 1]!,
            pixels[pixelOffset + 2]!,
        );
        if (inferredSourceSwatch && currentSwatch !== inferredSourceSwatch) {
            return false;
        }
        const x = (pixelOffset / 4) % image.width;
        const y = Math.floor((pixelOffset / 4) / image.width);
        if (y < lineBand.start || y >= lineBand.end) {
            return false;
        }
        let sameSwatchRun = 1;
        for (let above = y - 1; above >= 0; above -= 1) {
            const aboveIndex = (above * image.width + x) * 4;
            if (!isAnnotationPixel(aboveIndex)) {
                break;
            }
            if (textMarkupCanvasColor.nearestAnnotationSwatch(pixels[aboveIndex]!, pixels[aboveIndex + 1]!, pixels[aboveIndex + 2]!) === currentSwatch) {
                sameSwatchRun += 1;
            }
        }
        for (let below = y + 1; below < image.height; below += 1) {
            const belowIndex = (below * image.width + x) * 4;
            if (!isAnnotationPixel(belowIndex)) {
                break;
            }
            if (textMarkupCanvasColor.nearestAnnotationSwatch(pixels[belowIndex]!, pixels[belowIndex + 1]!, pixels[belowIndex + 2]!) === currentSwatch) {
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
    image.context.putImageData(image.data, image.left, image.top);
    return true;
}
