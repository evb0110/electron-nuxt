import type { IOverlayRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export interface ISnipPointerPayload {
    clientX: number;
    clientY: number;
    overlayRect: IOverlayRect;
}
