import { clamp } from 'es-toolkit/math';
import type { TShapeResizeHandle } from '@app/types/annotations';
import type { IShapeBounds } from '@app/utils/pdf-viewer/pdf-shape-resize/pdfShapeResizeTypes';

export function getResizedBoundsForHandle(
    baselineBounds: IShapeBounds,
    handle: TShapeResizeHandle,
    coords: {
        x: number;
        y: number;
    },
    minSize = 0.01,
): IShapeBounds {
    const x = clamp(coords.x, 0, 1);
    const y = clamp(coords.y, 0, 1);

    switch (handle) {
        case 'nw':
            return {
                minX: clamp(x, 0, baselineBounds.maxX - minSize),
                minY: clamp(y, 0, baselineBounds.maxY - minSize),
                maxX: baselineBounds.maxX,
                maxY: baselineBounds.maxY,
            };
        case 'ne':
            return {
                minX: baselineBounds.minX,
                minY: clamp(y, 0, baselineBounds.maxY - minSize),
                maxX: clamp(x, baselineBounds.minX + minSize, 1),
                maxY: baselineBounds.maxY,
            };
        case 'sw':
            return {
                minX: clamp(x, 0, baselineBounds.maxX - minSize),
                minY: baselineBounds.minY,
                maxX: baselineBounds.maxX,
                maxY: clamp(y, baselineBounds.minY + minSize, 1),
            };
        case 'se':
        default:
            return {
                minX: baselineBounds.minX,
                minY: baselineBounds.minY,
                maxX: clamp(x, baselineBounds.minX + minSize, 1),
                maxY: clamp(y, baselineBounds.minY + minSize, 1),
            };
    }
}
