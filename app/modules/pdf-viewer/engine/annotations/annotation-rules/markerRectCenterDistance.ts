import type { IAnnotationMarkerRect } from '@app/types/annotations';

export function markerRectCenterDistance(
    left: IAnnotationMarkerRect | null | undefined,
    right: IAnnotationMarkerRect | null | undefined,
) {
    if (!left || !right) {
        return Number.POSITIVE_INFINITY;
    }
    if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) {
        return Number.POSITIVE_INFINITY;
    }
    const leftCx = left.left + left.width / 2;
    const leftCy = left.top + left.height / 2;
    const rightCx = right.left + right.width / 2;
    const rightCy = right.top + right.height / 2;
    return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}
