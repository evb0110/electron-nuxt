import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    normalizeMarkerRectBounds,
    orderPdfRectBounds,
} from '@app/utils/pdfMarkerRect';
import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/annotationGeometryTypes';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';

const MIN_POINT_MARKER_SIZE = 0.0016;

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

export function toMarkerRectFromPdfRect(
    rect: number[] | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
): IAnnotationMarkerRect | null {
    const bounds = getPageRectBounds(pageView);
    if (!rect || rect.length < 4 || !bounds) {
        return null;
    }

    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const {
        minX,
        maxX,
        minY,
        maxY,
    } = orderPdfRectBounds(x1, y1, x2, y2);

    const normalizedRotation = normalizePageRotation(pageRotation);

    const cornerPoints = [
        toMarkerPointFromPdfPointInternal(minX, minY, bounds, normalizedRotation),
        toMarkerPointFromPdfPointInternal(minX, maxY, bounds, normalizedRotation),
        toMarkerPointFromPdfPointInternal(maxX, minY, bounds, normalizedRotation),
        toMarkerPointFromPdfPointInternal(maxX, maxY, bounds, normalizedRotation),
    ];

    const markerLeft = Math.min(...cornerPoints.map(point => point.x));
    const markerTop = Math.min(...cornerPoints.map(point => point.y));
    const markerRight = Math.max(...cornerPoints.map(point => point.x));
    const markerBottom = Math.max(...cornerPoints.map(point => point.y));

    let normLeft = markerLeft;
    let normTop = markerTop;
    let normWidth = markerRight - markerLeft;
    let normHeight = markerBottom - markerTop;

    // Degenerate (zero-area) rects occur when a FreeText annotation is serialized
    // with minimal content (e.g. ZWS placeholder for sticky-note style comments).
    // Expand to a minimum point-marker size centered on the annotation position so
    // the annotation still produces a valid markerRect for the overlay system.
    if (normWidth < MIN_POINT_MARKER_SIZE) {
        const centerX = normLeft + normWidth / 2;
        normLeft = centerX - MIN_POINT_MARKER_SIZE / 2;
        normWidth = MIN_POINT_MARKER_SIZE;
    }
    if (normHeight < MIN_POINT_MARKER_SIZE) {
        const centerY = normTop + normHeight / 2;
        normTop = centerY - MIN_POINT_MARKER_SIZE / 2;
        normHeight = MIN_POINT_MARKER_SIZE;
    }

    return normalizeMarkerRectBounds({
        left: normLeft,
        top: normTop,
        right: normLeft + normWidth,
        bottom: normTop + normHeight,
    }, { clampSizeToRemaining: true });
}
