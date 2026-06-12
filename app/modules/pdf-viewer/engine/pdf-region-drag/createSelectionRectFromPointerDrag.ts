import type {
    IClientPoint,
    IClientRect,
} from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';
import { clampClientPointToRect } from '@app/utils/document-viewer/region-geometry/clampClientPointToRect';
import { normalizeClientRect } from '@app/utils/document-viewer/region-geometry/normalizeClientRect';
import { toLocalRect } from '@app/utils/document-viewer/region-geometry/toLocalRect';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';

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
