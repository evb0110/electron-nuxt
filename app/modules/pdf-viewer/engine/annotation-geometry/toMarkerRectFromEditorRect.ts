import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';

export function toMarkerRectFromEditorRect(
    markerRect: IAnnotationMarkerRect | null | undefined,
    pageRotation: TPageRotation = 0,
): IAnnotationMarkerRect | null {
    const normalized = normalizeMarkerRect(markerRect);
    if (!normalized) {
        return null;
    }

    const normalizedRotation = normalizePageRotation(pageRotation);
    switch (normalizedRotation) {
        case 90:
            return normalizeMarkerRect({
                left: 1 - normalized.top,
                top: normalized.left,
                width: normalized.width,
                height: normalized.height,
            });
        case 180:
            return normalizeMarkerRect({
                left: 1 - normalized.left,
                top: 1 - normalized.top,
                width: normalized.width,
                height: normalized.height,
            });
        case 270:
            return normalizeMarkerRect({
                left: normalized.top,
                top: 1 - normalized.left,
                width: normalized.width,
                height: normalized.height,
            });
        default:
            return normalized;
    }
}
