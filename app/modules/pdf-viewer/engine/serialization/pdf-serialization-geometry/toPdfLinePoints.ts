import type { IShapeAnnotation } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfPointFromMarkerPoint } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfPointFromMarkerPoint';

export function toPdfLinePoints(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const start = toPdfPointFromMarkerPoint(shape.x, shape.y, pageView, pageRotation);
    const end = toPdfPointFromMarkerPoint(shape.x2 ?? shape.x, shape.y2 ?? shape.y, pageView, pageRotation);
    if (!start || !end) {
        return null;
    }

    return [
        start,
        end,
    ] as const;
}
