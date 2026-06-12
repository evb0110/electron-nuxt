import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';

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

function toMarkerPointFromPdfPointInternal(
    x: number,
    y: number,
    bounds: IPageRectBounds,
    pageRotation: TPageRotation,
) {
    const normX = (x - bounds.xMin) / bounds.width;
    const normY = (y - bounds.yMin) / bounds.height;

    switch (pageRotation) {
        case 90:
            return {
                x: normY,
                y: normX,
            };
        case 180:
            return {
                x: 1 - normX,
                y: normY,
            };
        case 270:
            return {
                x: 1 - normY,
                y: 1 - normX,
            };
        default:
            return {
                x: normX,
                y: 1 - normY,
            };
    }
}

export function toMarkerPointFromPdfPoint(
    x: number,
    y: number,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
) {
    const bounds = getPageRectBounds(pageView);
    if (!bounds) {
        return null;
    }

    return toMarkerPointFromPdfPointInternal(x, y, bounds, normalizePageRotation(pageRotation));
}
