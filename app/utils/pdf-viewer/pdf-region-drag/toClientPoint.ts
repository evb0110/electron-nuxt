import type { IClientPoint } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function toClientPoint(payload: IClientPoint): IClientPoint {
    return {
        clientX: payload.clientX,
        clientY: payload.clientY,
    };
}
