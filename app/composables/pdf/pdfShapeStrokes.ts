import type {
    IShapeAnnotation,
    IShapePoint,
} from '@app/types/annotations';

export function cloneShapePoints(points: IShapePoint[] | undefined) {
    return points?.map(point => ({ ...point }));
}

export function cloneShapeStrokes(strokes: IShapePoint[][] | undefined) {
    return strokes?.map(points => points.map(point => ({ ...point })));
}

export function getShapeStrokePointSets(shape: Pick<IShapeAnnotation, 'points' | 'strokes'>) {
    if (shape.strokes && shape.strokes.length > 0) {
        return shape.strokes.filter(points => points.length > 0);
    }

    if (shape.points && shape.points.length > 0) {
        return [shape.points];
    }

    return [];
}

export function getAllShapePoints(shape: Pick<IShapeAnnotation, 'points' | 'strokes'>) {
    return getShapeStrokePointSets(shape).flatMap(points => points);
}
