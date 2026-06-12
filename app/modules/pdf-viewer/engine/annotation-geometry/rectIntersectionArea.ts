

export function rectIntersectionArea(left: DOMRect, right: DOMRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.right, right.right);
    const y2 = Math.min(left.bottom, right.bottom);
    const width = Math.max(0, x2 - x1);
    const height = Math.max(0, y2 - y1);
    return width * height;
}
