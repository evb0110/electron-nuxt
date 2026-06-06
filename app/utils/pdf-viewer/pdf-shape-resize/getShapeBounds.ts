import type { IShapeAnnotation } from '@app/types/annotations';
import { getAllShapePoints } from '@app/utils/pdf-viewer/pdf-shape-strokes/getAllShapePoints';
import type { IShapeBounds } from '@app/utils/pdf-viewer/pdf-shape-resize/shapeBounds';

export function getShapeBounds(shape: IShapeAnnotation): IShapeBounds {
    if (shape.type === 'polyline' || shape.type === 'polygon') {
        const points = getAllShapePoints(shape);
        if (points.length > 0) {
            const xs = points.map(point => point.x);
            const ys = points.map(point => point.y);
            return {
                minX: Math.min(...xs),
                minY: Math.min(...ys),
                maxX: Math.max(...xs),
                maxY: Math.max(...ys),
            };
        }
    }

    if (shape.type === 'line' || shape.type === 'arrow') {
        const x2 = shape.x2 ?? shape.x;
        const y2 = shape.y2 ?? shape.y;
        return {
            minX: Math.min(shape.x, x2),
            minY: Math.min(shape.y, y2),
            maxX: Math.max(shape.x, x2),
            maxY: Math.max(shape.y, y2),
        };
    }

    return {
        minX: shape.x,
        minY: shape.y,
        maxX: shape.x + shape.width,
        maxY: shape.y + shape.height,
    };
}
