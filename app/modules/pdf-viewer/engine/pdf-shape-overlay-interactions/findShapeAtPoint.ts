import type {
    IShapeAnnotation,
    IShapePoint,
} from '@app/types/annotations';
import { getShapeStrokePointSets } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/getShapeStrokePointSets';
import { clamp } from 'es-toolkit/math';

interface IFindShapeAtPointOptions {
    shapes: IShapeAnnotation[];
    x: number;
    y: number;
    svgWidth: number;
    svgHeight: number;
    thresholdPx?: number;
}

function toPxX(x: number, svgWidth: number) {
    return x * Math.max(svgWidth, 1);
}

function toPxY(y: number, svgHeight: number) {
    return y * Math.max(svgHeight, 1);
}

function pointInExpandedRect(
    x: number,
    y: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    padX: number,
    padY: number,
) {
    return (
        x >= left - padX
        && x <= right + padX
        && y >= top - padY
        && y <= bottom + padY
    );
}

function pointToSegmentDistancePx(
    point: IShapePoint,
    start: IShapePoint,
    end: IShapePoint,
    svgWidth: number,
    svgHeight: number,
) {
    const pointX = toPxX(point.x, svgWidth);
    const pointY = toPxY(point.y, svgHeight);
    const startX = toPxX(start.x, svgWidth);
    const startY = toPxY(start.y, svgHeight);
    const endX = toPxX(end.x, svgWidth);
    const endY = toPxY(end.y, svgHeight);
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;

    if (lengthSquared <= Number.EPSILON) {
        return Math.hypot(pointX - startX, pointY - startY);
    }

    const projection = ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared;
    const t = clamp(projection, 0, 1);
    const closestX = startX + deltaX * t;
    const closestY = startY + deltaY * t;

    return Math.hypot(pointX - closestX, pointY - closestY);
}

function pointInPolygon(point: IShapePoint, polygon: IShapePoint[]) {
    if (polygon.length < 3) {
        return false;
    }

    let inside = false;
    for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
        const current = polygon[index]!;
        const previous = polygon[previousIndex]!;
        const intersects = (
            ((current.y > point.y) !== (previous.y > point.y))
            && (point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x)
        );
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function segmentThresholdPx(shape: IShapeAnnotation, fallbackPx: number) {
    return Math.max(fallbackPx, shape.strokeWidth / 2 + 10);
}

function isPointNearPolyline(
    point: IShapePoint,
    points: IShapePoint[],
    shape: IShapeAnnotation,
    svgWidth: number,
    svgHeight: number,
    fallbackPx: number,
) {
    if (points.length === 0) {
        return false;
    }

    const thresholdPx = segmentThresholdPx(shape, fallbackPx);
    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1]!;
        const end = points[index]!;
        if (pointToSegmentDistancePx(point, start, end, svgWidth, svgHeight) <= thresholdPx) {
            return true;
        }
    }

    return false;
}

function shapeContainsPoint(
    shape: IShapeAnnotation,
    point: IShapePoint,
    svgWidth: number,
    svgHeight: number,
    fallbackPx: number,
) {
    const padX = fallbackPx / Math.max(svgWidth, 1);
    const padY = fallbackPx / Math.max(svgHeight, 1);

    switch (shape.type) {
        case 'rectangle': {
            const left = shape.x;
            const top = shape.y;
            const right = shape.x + shape.width;
            const bottom = shape.y + shape.height;
            return pointInExpandedRect(point.x, point.y, left, top, right, bottom, padX, padY);
        }
        case 'circle': {
            const radiusX = Math.max(shape.width / 2, padX);
            const radiusY = Math.max(shape.height / 2, padY);
            const centerX = shape.x + shape.width / 2;
            const centerY = shape.y + shape.height / 2;
            const normalizedX = (point.x - centerX) / (radiusX + padX);
            const normalizedY = (point.y - centerY) / (radiusY + padY);
            return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
        }
        case 'line':
        case 'arrow':
            return pointToSegmentDistancePx(
                point,
                {
                    x: shape.x,
                    y: shape.y,
                },
                {
                    x: shape.x2 ?? shape.x,
                    y: shape.y2 ?? shape.y,
                },
                svgWidth,
                svgHeight,
            ) <= segmentThresholdPx(shape, fallbackPx);
        case 'polyline':
            return getShapeStrokePointSets(shape).some(points => (
                isPointNearPolyline(point, points, shape, svgWidth, svgHeight, fallbackPx)
            ));
        case 'polygon': {
            const points = shape.points ?? getShapeStrokePointSets(shape)[0] ?? [];
            if (pointInPolygon(point, points)) {
                return true;
            }
            return isPointNearPolyline(point, [
                ...points,
                points[0]!,
            ].filter(Boolean), shape, svgWidth, svgHeight, fallbackPx);
        }
        default:
            return false;
    }
}

export function findShapeAtPoint(options: IFindShapeAtPointOptions) {
    const {
        shapes,
        x,
        y,
        svgWidth,
        svgHeight,
        thresholdPx = 24,
    } = options;

    const point = {
        x,
        y,
    };

    for (let index = shapes.length - 1; index >= 0; index -= 1) {
        const shape = shapes[index];
        if (!shape) {
            continue;
        }
        if (shapeContainsPoint(shape, point, svgWidth, svgHeight, thresholdPx)) {
            return shape;
        }
    }

    return null;
}
