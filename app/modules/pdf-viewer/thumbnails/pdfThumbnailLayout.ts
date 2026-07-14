export const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_ITEM_VERTICAL_PADDING = 8;
const THUMBNAIL_ITEM_CONTENT_GAP = 4;
const THUMBNAIL_NUMBER_LINE_HEIGHT = 16;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 2;
export const VIRTUAL_OVERSCAN = 8;

export function isValidThumbnailAspectRatio(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function resolveThumbnailItemHeightFromCanvasHeight(canvasHeight: number) {
    return Math.ceil(canvasHeight)
        + THUMBNAIL_ITEM_VERTICAL_PADDING
        + THUMBNAIL_ITEM_CONTENT_GAP
        + THUMBNAIL_NUMBER_LINE_HEIGHT
        + THUMBNAIL_CANVAS_BORDER_WIDTH;
}

export function resolveThumbnailItemHeightFromAspect(
    aspectRatio: number | null | undefined,
    renderWidth: number,
) {
    if (!isValidThumbnailAspectRatio(aspectRatio)) {
        return DEFAULT_THUMBNAIL_ITEM_HEIGHT;
    }

    return resolveThumbnailItemHeightFromCanvasHeight(renderWidth * aspectRatio);
}

export function createThumbnailCanvasStyle(aspectRatio: number | null | undefined) {
    return isValidThumbnailAspectRatio(aspectRatio)
        ? {aspectRatio: `1 / ${aspectRatio}`}
        : {};
}

export function createThumbnailItemStyle(top: number) {
    return {transform: `translateY(${top}px)`};
}
