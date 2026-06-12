import { rectIntersectionArea } from '@app/modules/pdf-viewer/engine/annotation-geometry/rectIntersectionArea';

export function rectIoU(left: DOMRect, right: DOMRect) {
    const intersection = rectIntersectionArea(left, right);
    if (intersection <= 0) {
        return 0;
    }
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const union = leftArea + rightArea - intersection;
    if (union <= 0) {
        return 0;
    }
    return intersection / union;
}
