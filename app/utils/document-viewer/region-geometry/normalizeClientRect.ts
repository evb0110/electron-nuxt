import type { IClientRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function normalizeClientRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
): IClientRect {
    return {
        left: Math.min(startX, endX),
        top: Math.min(startY, endY),
        right: Math.max(startX, endX),
        bottom: Math.max(startY, endY),
    };
}
