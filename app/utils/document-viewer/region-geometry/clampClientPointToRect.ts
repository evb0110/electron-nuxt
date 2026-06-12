import { clamp } from 'es-toolkit/math';
import type {
    IClientPoint,
    IClientRect,
} from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function clampClientPointToRect(
    point: IClientPoint,
    rect: IClientRect,
): IClientPoint {
    return {
        clientX: clamp(point.clientX, rect.left, rect.right),
        clientY: clamp(point.clientY, rect.top, rect.bottom),
    };
}
