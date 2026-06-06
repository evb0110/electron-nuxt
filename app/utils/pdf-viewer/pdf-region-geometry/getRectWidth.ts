import type { IClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function getRectWidth(rect: IClientRect) {
    return Math.max(0, rect.right - rect.left);
}
