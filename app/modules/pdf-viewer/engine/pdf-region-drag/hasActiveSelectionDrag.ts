import type { IClientPoint } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function hasActiveSelectionDrag(
    state: string,
    startPoint: IClientPoint | null,
): startPoint is IClientPoint {
    return state === 'selecting' && startPoint !== null;
}
