import type { IShapePoint } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfPointFromMarkerPoint } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfPointFromMarkerPoint';

export function toPdfVertexPoints(
    points: IShapePoint[] | undefined,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    if (!points || points.length < 2) {
        return null;
    }

    const pdfPoints: Array<NonNullable<ReturnType<typeof toPdfPointFromMarkerPoint>>> = [];
    for (const point of points) {
        const pdfPoint = toPdfPointFromMarkerPoint(point.x, point.y, pageView, pageRotation);
        if (!pdfPoint) {
            return null;
        }
        pdfPoints.push(pdfPoint);
    }

    return pdfPoints;
}
