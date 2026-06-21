import { clamp } from 'es-toolkit/math';
import type { TShapeResizeHandle } from '@app/types/annotations';
import type { IShapeBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/shapeBounds';

function normalizeBounds(bounds: IShapeBounds): IShapeBounds {
    const minX = clamp(Math.min(bounds.minX, bounds.maxX), 0, 1);
    const maxX = clamp(Math.max(bounds.minX, bounds.maxX), 0, 1);
    const minY = clamp(Math.min(bounds.minY, bounds.maxY), 0, 1);
    const maxY = clamp(Math.max(bounds.minY, bounds.maxY), 0, 1);
    return {
        minX,
        minY,
        maxX,
        maxY,
    };
}

export function getResizedBoundsForHandle(
    baselineBounds: IShapeBounds,
    handle: TShapeResizeHandle,
    coords: {
        x: number;
        y: number;
    },
    minSize = 0.01,
): IShapeBounds {
    const bounds = normalizeBounds(baselineBounds);
    const safeMinSize = clamp(minSize, 0, 1);
    const x = clamp(coords.x, 0, 1);
    const y = clamp(coords.y, 0, 1);

    switch (handle) {
        case 'nw':
            return {
                minX: clamp(x, 0, Math.max(0, bounds.maxX - safeMinSize)),
                minY: clamp(y, 0, Math.max(0, bounds.maxY - safeMinSize)),
                maxX: bounds.maxX,
                maxY: bounds.maxY,
            };
        case 'ne':
            return {
                minX: bounds.minX,
                minY: clamp(y, 0, Math.max(0, bounds.maxY - safeMinSize)),
                maxX: clamp(x, Math.min(1, bounds.minX + safeMinSize), 1),
                maxY: bounds.maxY,
            };
        case 'sw':
            return {
                minX: clamp(x, 0, Math.max(0, bounds.maxX - safeMinSize)),
                minY: bounds.minY,
                maxX: bounds.maxX,
                maxY: clamp(y, Math.min(1, bounds.minY + safeMinSize), 1),
            };
        case 'se':
        default:
            return {
                minX: bounds.minX,
                minY: bounds.minY,
                maxX: clamp(x, Math.min(1, bounds.minX + safeMinSize), 1),
                maxY: clamp(y, Math.min(1, bounds.minY + safeMinSize), 1),
            };
    }
}
