import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { textMarkupCanvasColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/textMarkupCanvasColor';
import { traverseTextMarkupCanvasRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/traverseTextMarkupCanvasRect';

export function sampleCanvasTextMarkupColorInRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
) {
    const counts = new Map<string, number>();
    const image = traverseTextMarkupCanvasRect(
        canvas,
        pageContainer,
        targetRect,
        ({
            data,
            index,
        }) => {
            const pixels = data.data;
            const r = pixels[index]!;
            const g = pixels[index + 1]!;
            const b = pixels[index + 2]!;
            const alpha = pixels[index + 3]!;
            const score = textMarkupCanvasColor.colorDistanceScoreFromPoint(0, 0, r, g, b, alpha);
            if (score === null) {
                return;
            }
            const color = textMarkupCanvasColor.nearestAnnotationSwatch(r, g, b);
            counts.set(color, (counts.get(color) ?? 0) + 1);
        },
        {stride: (width, height) => Math.floor(Math.min(width, height) / 180)},
    );
    if (!image) {
        return null;
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
