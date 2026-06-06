import type { IShapeAnnotation } from '@app/types/annotations';
import { cloneShapePoints } from '@app/utils/pdf-viewer/pdf-shape-strokes/cloneShapePoints';
import { cloneShapeStrokes } from '@app/utils/pdf-viewer/pdf-shape-strokes/cloneShapeStrokes';

export function cloneShape(shape: IShapeAnnotation): IShapeAnnotation {
    return {
        ...shape,
        points: cloneShapePoints(shape.points),
        strokes: cloneShapeStrokes(shape.strokes),
    };
}
