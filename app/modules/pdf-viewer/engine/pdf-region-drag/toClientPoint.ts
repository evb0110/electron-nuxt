import type { IClientPoint } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function toClientPoint(payload: IClientPoint): IClientPoint {
    return {
        clientX: payload.clientX,
        clientY: payload.clientY,
    };
}
