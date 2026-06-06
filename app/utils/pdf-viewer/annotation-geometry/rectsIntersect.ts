

export function rectsIntersect(
    leftRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
    rightRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
) {
    return !(
        leftRect.right < rightRect.left
        || leftRect.left > rightRect.right
        || leftRect.bottom < rightRect.top
        || leftRect.top > rightRect.bottom
    );
}
