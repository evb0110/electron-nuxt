import type { IShapeAnnotation } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { getShapeStrokePointSets } from '@app/utils/pdf-viewer/pdf-shape-strokes/getShapeStrokePointSets';
import { toPdfVertexPoints } from '@app/utils/pdf-viewer/serialization/pdf-serialization-geometry/toPdfVertexPoints';

export function toPdfInkList(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const strokePointSets = getShapeStrokePointSets(shape);
    if (strokePointSets.length === 0) {
        return null;
    }

    const inkList: number[][] = [];
    const pdfPoints = strokePointSets.flatMap((points) => {
        const strokePdfPoints = toPdfVertexPoints(points, pageView, pageRotation);
        if (!strokePdfPoints) {
            return [];
        }
        inkList.push(strokePdfPoints.flatMap(point => [
            point.x,
            point.y,
        ]));
        return strokePdfPoints;
    });
    if (inkList.length === 0 || pdfPoints.length === 0) {
        return null;
    }

    return {
        pdfPoints,
        inkList,
    };
}
