

export function rectCenterDistance(left: DOMRect, right: DOMRect) {
    const leftX = left.left + left.width / 2;
    const leftY = left.top + left.height / 2;
    const rightX = right.left + right.width / 2;
    const rightY = right.top + right.height / 2;
    return Math.hypot(leftX - rightX, leftY - rightY);
}
