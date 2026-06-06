import { clamp } from 'es-toolkit/math';
import type {
    IClientPoint,
    IClientRect,
} from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function clampClientPointToRect(
    point: IClientPoint,
    rect: IClientRect,
): IClientPoint {
    return {
        clientX: clamp(point.clientX, rect.left, rect.right),
        clientY: clamp(point.clientY, rect.top, rect.bottom),
    };
}
