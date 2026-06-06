import type { IShapeAnnotation } from '@app/types/annotations';
import { getAllShapePoints } from '@app/utils/pdf-viewer/pdf-shape-strokes/getAllShapePoints';
import { getPointMinMaxBounds } from '@app/utils/pdf-viewer/pdf-shape-resize/getPointMinMaxBounds';
import { getShapeBounds } from '@app/utils/pdf-viewer/pdf-shape-resize/getShapeBounds';
import { toShapeRect } from '@app/utils/pdf-viewer/pdf-shape-resize/toShapeRect';

export function getShapeRect(
    shape: IShapeAnnotation,
    options: { rectFallbackMinSize?: number } = {},
) {
    const { rectFallbackMinSize = 0 } = options;

    if (shape.type === 'polyline' || shape.type === 'polygon') {
        const bounds = getPointMinMaxBounds(getAllShapePoints(shape));
        if (bounds) {
            const rect = toShapeRect(bounds, 0.01);
            return {
                x: rect.minX,
                y: rect.minY,
                width: rect.maxX - rect.minX,
                height: rect.maxY - rect.minY,
            };
        }
    }

    if (shape.type === 'line' || shape.type === 'arrow') {
        const rect = toShapeRect(getShapeBounds(shape), 0.01);
        return {
            x: rect.minX,
            y: rect.minY,
            width: rect.maxX - rect.minX,
            height: rect.maxY - rect.minY,
        };
    }

    return {
        x: shape.x,
        y: shape.y,
        width: rectFallbackMinSize > 0 ? Math.max(rectFallbackMinSize, shape.width) : shape.width,
        height: rectFallbackMinSize > 0 ? Math.max(rectFallbackMinSize, shape.height) : shape.height,
    };
}
