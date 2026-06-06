import type {
    IClientPoint,
    IClientRect,
} from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';
import { clampClientPointToRect } from '@app/utils/pdf-viewer/pdf-region-geometry/clampClientPointToRect';
import { normalizeClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/normalizeClientRect';
import { toLocalRect } from '@app/utils/pdf-viewer/pdf-region-geometry/toLocalRect';
import type { ISnipPointerPayload } from '@app/utils/pdf-viewer/pdf-region-drag/pdfRegionDragTypes';

export function createSelectionRectFromPointerDrag(
    payload: ISnipPointerPayload,
    startPoint: IClientPoint,
    clampRect?: IClientRect,
) {
    const start = clampRect
        ? clampClientPointToRect(startPoint, clampRect)
        : startPoint;
    const end = clampRect
        ? clampClientPointToRect(payload, clampRect)
        : payload;
    const clientRect = normalizeClientRect(
        start.clientX,
        start.clientY,
        end.clientX,
        end.clientY,
    );

    return {
        clientRect,
        localRect: toLocalRect(clientRect, payload.overlayRect),
    };
}
