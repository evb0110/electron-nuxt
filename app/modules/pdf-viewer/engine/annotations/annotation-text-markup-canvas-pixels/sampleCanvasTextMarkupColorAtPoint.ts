import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import { textMarkupCanvasColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/textMarkupCanvasColor';

export function sampleCanvasTextMarkupColorAtPoint(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
) {
    const rect = canvas.getBoundingClientRect();
    if (
        rect.width <= 0
        || rect.height <= 0
        || clientX < rect.left
        || clientX > rect.right
        || clientY < rect.top
        || clientY > rect.bottom
    ) {
        return null;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const centerX = Math.round((clientX - rect.left) * scaleX);
    const centerY = Math.round((clientY - rect.top) * scaleY);
    const radiusX = Math.max(2, Math.round(7 * scaleX));
    const radiusY = Math.max(2, Math.round(7 * scaleY));
    const left = Math.max(0, centerX - radiusX);
    const top = Math.max(0, centerY - radiusY);
    const width = Math.min(canvas.width - left, radiusX * 2 + 1);
    const height = Math.min(canvas.height - top, radiusY * 2 + 1);
    if (width <= 0 || height <= 0) {
        return null;
    }

    let data: ImageData;
    try {
        data = context.getImageData(left, top, width, height);
    } catch {
        return null;
    }

    let best: {
        color: string;
        score: number;
    } | null = null;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const r = data.data[index]!;
            const g = data.data[index + 1]!;
            const b = data.data[index + 2]!;
            const alpha = data.data[index + 3]!;
            const score = textMarkupCanvasColor.colorDistanceScoreFromPoint(
                (left + x - centerX) / scaleX,
                (top + y - centerY) / scaleY,
                r,
                g,
                b,
                alpha,
            );
            if (score === null || (best && score <= best.score)) {
                continue;
            }
            best = {
                color: rgbToHex({
                    r,
                    g,
                    b,
                }),
                score,
            };
        }
    }
    return best?.color ?? null;
}
