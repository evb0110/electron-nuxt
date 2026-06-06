import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/pageRotation';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';

interface IPageRectBounds {
    xMin: number;
    yMin: number;
    width: number;
    height: number;
}

function getPageRectBounds(pageView: number[] | null | undefined): IPageRectBounds | null {
    if (!pageView || pageView.length < 4) {
        return null;
    }

    const xMin = pageView[0] ?? 0;
    const yMin = pageView[1] ?? 0;
    const xMax = pageView[2] ?? 0;
    const yMax = pageView[3] ?? 0;
    const pageWidth = xMax - xMin;
    const pageHeight = yMax - yMin;
    if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    return {
        xMin,
        yMin,
        width: pageWidth,
        height: pageHeight,
    };
}

function toPdfPointFromMarkerPointInternal(
    markerX: number,
    markerY: number,
    bounds: IPageRectBounds,
    pageRotation: TPageRotation,
) {
    let normX = markerX;
    let normY = 1 - markerY;

    switch (pageRotation) {
        case 90:
            normX = markerY;
            normY = markerX;
            break;
        case 180:
            normX = 1 - markerX;
            normY = markerY;
            break;
        case 270:
            normX = 1 - markerY;
            normY = 1 - markerX;
            break;
        default:
            break;
    }

    return {
        x: bounds.xMin + normX * bounds.width,
        y: bounds.yMin + normY * bounds.height,
    };
}

export function toPdfRectFromMarkerRect(
    markerRect: IAnnotationMarkerRect | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
): [number, number, number, number] | null {
    const normalized = normalizeMarkerRect(markerRect);
    const bounds = getPageRectBounds(pageView);
    if (!normalized || !bounds) {
        return null;
    }

    const normalizedRotation = normalizePageRotation(pageRotation);
    const markerRight = normalized.left + normalized.width;
    const markerBottom = normalized.top + normalized.height;

    const cornerPoints = [
        toPdfPointFromMarkerPointInternal(normalized.left, normalized.top, bounds, normalizedRotation),
        toPdfPointFromMarkerPointInternal(markerRight, normalized.top, bounds, normalizedRotation),
        toPdfPointFromMarkerPointInternal(normalized.left, markerBottom, bounds, normalizedRotation),
        toPdfPointFromMarkerPointInternal(markerRight, markerBottom, bounds, normalizedRotation),
    ];

    const minX = Math.min(...cornerPoints.map(point => point.x));
    const minY = Math.min(...cornerPoints.map(point => point.y));
    const maxX = Math.max(...cornerPoints.map(point => point.x));
    const maxY = Math.max(...cornerPoints.map(point => point.y));

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}
