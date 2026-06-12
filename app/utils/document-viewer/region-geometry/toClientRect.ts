import type { IClientRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function toClientRect(rect: DOMRect): IClientRect {
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}
