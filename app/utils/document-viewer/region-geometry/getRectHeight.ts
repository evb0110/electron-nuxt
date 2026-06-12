import type { IClientRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function getRectHeight(rect: IClientRect) {
    return Math.max(0, rect.bottom - rect.top);
}
