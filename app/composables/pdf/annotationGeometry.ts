import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    normalizeMarkerRectBounds,
    orderPdfRectBounds,
} from '@app/utils/pdfMarkerRect';
import { clamp } from 'es-toolkit/math';

export type TPageRotation = 0 | 90 | 180 | 270;

export function normalizePageRotation(value: number): TPageRotation {
    if (!Number.isFinite(value)) {
        return 0;
    }

    const snapped = Math.round(value / 90) * 90;
    const normalized = ((snapped % 360) + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }
    return 0;
}

export function clamp01(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return clamp(value, 0, 1);
}

export function normalizeMarkerRect(rect: IAnnotationMarkerRect | null | undefined): IAnnotationMarkerRect | null {
    if (!rect) {
        return null;
    }
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (width <= 0 || height <= 0) {
        return null;
    }

    const clampedLeft = clamp(left, 0, 1);
    const clampedTop = clamp(top, 0, 1);
    const maxWidth = 1 - clampedLeft;
    const maxHeight = 1 - clampedTop;
    const clampedWidth = clamp(width, 0, maxWidth);
    const clampedHeight = clamp(height, 0, maxHeight);
    if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
    }

    return {
        left: clampedLeft,
        top: clampedTop,
        width: clampedWidth,
        height: clampedHeight,
    };
}

const MIN_POINT_MARKER_SIZE = 0.0016;

export function toMarkerRectFromEditorRect(
    markerRect: IAnnotationMarkerRect | null | undefined,
    pageRotation: TPageRotation = 0,
): IAnnotationMarkerRect | null {
    const normalized = normalizeMarkerRect(markerRect);
    if (!normalized) {
        return null;
    }

    const normalizedRotation = normalizePageRotation(pageRotation);
    switch (normalizedRotation) {
        case 90:
            return normalizeMarkerRect({
                left: 1 - normalized.top,
                top: normalized.left,
                width: normalized.width,
                height: normalized.height,
            });
        case 180:
            return normalizeMarkerRect({
                left: 1 - normalized.left,
                top: 1 - normalized.top,
                width: normalized.width,
                height: normalized.height,
            });
        case 270:
            return normalizeMarkerRect({
                left: normalized.top,
                top: 1 - normalized.left,
                width: normalized.width,
                height: normalized.height,
            });
        default:
            return normalized;
    }
}

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

export function markerRectIoU(
    leftRect: IAnnotationMarkerRect | null | undefined,
    rightRect: IAnnotationMarkerRect | null | undefined,
) {
    const left = normalizeMarkerRect(leftRect);
    const right = normalizeMarkerRect(rightRect);
    if (!left || !right) {
        return 0;
    }

    const intersectionLeft = Math.max(left.left, right.left);
    const intersectionTop = Math.max(left.top, right.top);
    const intersectionRight = Math.min(left.left + left.width, right.left + right.width);
    const intersectionBottom = Math.min(left.top + left.height, right.top + right.height);
    const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
    const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
    const intersectionArea = intersectionWidth * intersectionHeight;
    if (intersectionArea <= 0) {
        return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const unionArea = leftArea + rightArea - intersectionArea;
    if (unionArea <= 0) {
        return 0;
    }

    return intersectionArea / unionArea;
}

export function rectIntersectionArea(left: DOMRect, right: DOMRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.right, right.right);
    const y2 = Math.min(left.bottom, right.bottom);
    const width = Math.max(0, x2 - x1);
    const height = Math.max(0, y2 - y1);
    return width * height;
}

export function rectIoU(left: DOMRect, right: DOMRect) {
    const intersection = rectIntersectionArea(left, right);
    if (intersection <= 0) {
        return 0;
    }
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const union = leftArea + rightArea - intersection;
    if (union <= 0) {
        return 0;
    }
    return intersection / union;
}

export function rectCenterDistance(left: DOMRect, right: DOMRect) {
    const leftX = left.left + left.width / 2;
    const leftY = left.top + left.height / 2;
    const rightX = right.left + right.width / 2;
    const rightY = right.top + right.height / 2;
    return Math.hypot(leftX - rightX, leftY - rightY);
}

export function rectsIntersect(
    leftRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
    rightRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
) {
    return !(
        leftRect.right < rightRect.left
        || leftRect.left > rightRect.right
        || leftRect.bottom < rightRect.top
        || leftRect.top > rightRect.bottom
    );
}

export function mergeMarkerRects(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const minLeft = Math.min(left.left, right.left);
    const minTop = Math.min(left.top, right.top);
    const maxRight = Math.max(left.left + left.width, right.left + right.width);
    const maxBottom = Math.max(left.top + left.height, right.top + right.height);
    return {
        left: minLeft,
        top: minTop,
        width: Math.max(0.0001, maxRight - minLeft),
        height: Math.max(0.0001, maxBottom - minTop),
    };
}
