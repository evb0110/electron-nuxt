import type { IShapePoint } from '@app/types/annotations';

export function cloneShapeStrokes(strokes: IShapePoint[][] | undefined) {
    return strokes?.map(points => points.map(point => ({ ...point })));
}
