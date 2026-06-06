import type { IShapePoint } from '@app/types/annotations';

export function cloneShapePoints(points: IShapePoint[] | undefined) {
    return points?.map(point => ({ ...point }));
}
