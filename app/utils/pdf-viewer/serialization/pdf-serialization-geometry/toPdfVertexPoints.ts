import type { IShapePoint } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { toPdfPointFromMarkerPoint } from '@app/utils/pdf-viewer/annotation-geometry/toPdfPointFromMarkerPoint';

export function toPdfVertexPoints(
    points: IShapePoint[] | undefined,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    if (!points || points.length < 2) {
        return null;
    }

    const pdfPoints = points
        .map(point => toPdfPointFromMarkerPoint(point.x, point.y, pageView, pageRotation))
        .filter((point): point is NonNullable<typeof point> => Boolean(point));
    return pdfPoints.length === points.length ? pdfPoints : null;
}
