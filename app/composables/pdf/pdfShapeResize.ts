import { clamp } from 'es-toolkit/math';
import type {
    IShapeAnnotation,
    IShapePoint,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { getAllShapePoints } from '@app/composables/pdf/pdfShapeStrokes';

export interface IShapeBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

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

export function getPointMinMaxBounds(points: IShapePoint[]) {
    if (points.length === 0) {
        return null;
    }

    return {
        minX: Math.min(...points.map(point => point.x)),
        minY: Math.min(...points.map(point => point.y)),
        maxX: Math.max(...points.map(point => point.x)),
        maxY: Math.max(...points.map(point => point.y)),
    };
}

export function toShapeRect(bounds: IShapeBounds, minSize = 0.01): IShapeBounds {
    return {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.minX + Math.max(minSize, bounds.maxX - bounds.minX),
        maxY: bounds.minY + Math.max(minSize, bounds.maxY - bounds.minY),
    };
}

export interface IShapeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function getShapeRect(
    shape: IShapeAnnotation,
    options: { rectFallbackMinSize?: number } = {},
): IShapeRect {
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

function scalePointToBounds(point: IShapePoint, baselineBounds: IShapeBounds, nextBounds: IShapeBounds) {
    const baselineWidth = Math.max(0.01, baselineBounds.maxX - baselineBounds.minX);
    const baselineHeight = Math.max(0.01, baselineBounds.maxY - baselineBounds.minY);
    const nextWidth = Math.max(0.01, nextBounds.maxX - nextBounds.minX);
    const nextHeight = Math.max(0.01, nextBounds.maxY - nextBounds.minY);
    const ratioX = (point.x - baselineBounds.minX) / baselineWidth;
    const ratioY = (point.y - baselineBounds.minY) / baselineHeight;

    return {
        x: nextBounds.minX + ratioX * nextWidth,
        y: nextBounds.minY + ratioY * nextHeight,
    };
}

export function resizeShapeToBounds(
    shape: IShapeAnnotation,
    baselineBounds: IShapeBounds,
    nextBounds: IShapeBounds,
): IShapeAnnotation {
    if (shape.type === 'rectangle' || shape.type === 'circle') {
        return {
            ...shape,
            x: nextBounds.minX,
            y: nextBounds.minY,
            width: nextBounds.maxX - nextBounds.minX,
            height: nextBounds.maxY - nextBounds.minY,
        };
    }

    if (shape.type === 'line' || shape.type === 'arrow') {
        const start = scalePointToBounds({
            x: shape.x,
            y: shape.y,
        }, baselineBounds, nextBounds);
        const end = scalePointToBounds({
            x: shape.x2 ?? shape.x,
            y: shape.y2 ?? shape.y,
        }, baselineBounds, nextBounds);

        return {
            ...shape,
            x: start.x,
            y: start.y,
            x2: end.x,
            y2: end.y,
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y),
        };
    }

    if (shape.type === 'polyline' || shape.type === 'polygon') {
        const strokes = shape.strokes?.map(points => points.map(point => scalePointToBounds(point, baselineBounds, nextBounds)))
            ?? null;
        const points = shape.points?.map(point => scalePointToBounds(point, baselineBounds, nextBounds))
            ?? strokes?.[0]
            ?? [];
        if (points.length === 0) {
            return shape;
        }

        const allPoints = strokes?.flatMap(path => path) ?? points;
        const bounds = {
            minX: Math.min(...allPoints.map(point => point.x)),
            minY: Math.min(...allPoints.map(point => point.y)),
            maxX: Math.max(...allPoints.map(point => point.x)),
            maxY: Math.max(...allPoints.map(point => point.y)),
        };

        return {
            ...shape,
            x: bounds.minX,
            y: bounds.minY,
            width: Math.max(0.01, bounds.maxX - bounds.minX),
            height: Math.max(0.01, bounds.maxY - bounds.minY),
            points,
            strokes: strokes ?? shape.strokes,
        };
    }

    return shape;
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
