import type { PDFDocument } from 'pdf-lib';
import type {
    IShapeAnnotation,
    IShapePoint,
} from '@app/types/annotations';
import {
    normalizePageRotation,
    toPdfPointFromMarkerPoint,
} from '@app/composables/pdf/annotationGeometry';
import { resolvePdfPageView } from '@app/composables/pdf/pdfPageBoxes';
import { computePointsMinMax } from '@app/composables/pdf/pdfPageAnnotationIteration';
import { getShapeStrokePointSets } from '@app/composables/pdf/pdfShapeStrokes';

export function resolveShapePageContext(page: ReturnType<PDFDocument['getPages']>[number]) {
    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
    };
}

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

export function toPdfBoundsRect(points: ReadonlyArray<{
    x: number;
    y: number;
}>, strokeWidth: number) {
    const bounds = computePointsMinMax(points);
    if (!bounds) {
        return null;
    }

    return [
        bounds.minX - strokeWidth,
        bounds.minY - strokeWidth,
        bounds.maxX + strokeWidth,
        bounds.maxY + strokeWidth,
    ] as [number, number, number, number];
}
