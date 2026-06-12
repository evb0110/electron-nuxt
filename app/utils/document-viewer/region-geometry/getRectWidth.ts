import type { IClientRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function getRectWidth(rect: IClientRect) {
    return Math.max(0, rect.right - rect.left);
}
