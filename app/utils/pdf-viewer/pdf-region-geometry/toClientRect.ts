import type { IClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function toClientRect(rect: DOMRect): IClientRect {
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}
