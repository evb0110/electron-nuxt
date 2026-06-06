import { getRectHeight } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectHeight';
import { getRectWidth } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectWidth';
import type {
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function toLocalRect(rect: IClientRect, overlayRect: IOverlayRect): ILocalRect {
    return {
        x: rect.left - overlayRect.left,
        y: rect.top - overlayRect.top,
        width: getRectWidth(rect),
        height: getRectHeight(rect),
    };
}
