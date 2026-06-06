import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/pageRotation';
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

export function toPdfPointFromMarkerPoint(
    markerX: number,
    markerY: number,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
) {
    const bounds = getPageRectBounds(pageView);
    if (!bounds) {
        return null;
    }

    return toPdfPointFromMarkerPointInternal(markerX, markerY, bounds, normalizePageRotation(pageRotation));
}
