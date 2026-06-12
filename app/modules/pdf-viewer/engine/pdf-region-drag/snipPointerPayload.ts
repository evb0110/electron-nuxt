import type { IOverlayRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export interface ISnipPointerPayload {
    clientX: number;
    clientY: number;
    overlayRect: IOverlayRect;
}
