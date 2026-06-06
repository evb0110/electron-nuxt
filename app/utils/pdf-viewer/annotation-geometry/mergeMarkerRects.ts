import type { IAnnotationMarkerRect } from '@app/types/annotations';

export function mergeMarkerRects(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const minLeft = Math.min(left.left, right.left);
    const minTop = Math.min(left.top, right.top);
    const maxRight = Math.max(left.left + left.width, right.left + right.width);
    const maxBottom = Math.max(left.top + left.height, right.top + right.height);
    return {
        left: minLeft,
        top: minTop,
        width: Math.max(0.0001, maxRight - minLeft),
        height: Math.max(0.0001, maxBottom - minTop),
    };
}
