import type { IShapeAnnotation } from '@app/types/annotations';
import { getShapeStrokePointSets } from '@app/utils/pdf-viewer/pdf-shape-strokes/getShapeStrokePointSets';

export function getAllShapePoints(shape: Pick<IShapeAnnotation, 'points' | 'strokes'>) {
    return getShapeStrokePointSets(shape).flatMap(points => points);
}
