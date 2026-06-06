import type { IClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function getRectHeight(rect: IClientRect) {
    return Math.max(0, rect.bottom - rect.top);
}
