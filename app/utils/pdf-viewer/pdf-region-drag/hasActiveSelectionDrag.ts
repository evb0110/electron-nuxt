import type { IClientPoint } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';

export function hasActiveSelectionDrag(
    state: string,
    startPoint: IClientPoint | null,
): startPoint is IClientPoint {
    return state === 'selecting' && startPoint !== null;
}
