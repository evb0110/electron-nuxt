export const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_ITEM_VERTICAL_PADDING = 8;
const THUMBNAIL_ITEM_CONTENT_GAP = 4;
const THUMBNAIL_NUMBER_LINE_HEIGHT = 16;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 2;
export const VIRTUAL_OVERSCAN = 8;
const CURRENT_PAGE_NEIGHBOR_COUNT = 2;

export function resolveThumbnailVirtualPages(
    visibleStartIndex: number,
    visibleEndIndex: number,
    totalPages: number,
    currentPage: number,
) {
    if (totalPages <= 0) {
        return [] as number[];
    }

    const pages = new Set<number>();
    const startIndex = Math.max(0, visibleStartIndex);
    const endIndex = Math.min(totalPages - 1, visibleEndIndex);
    for (let index = startIndex; index <= endIndex; index += 1) {
        pages.add(index + 1);
    }

    const clampedCurrentPage = Math.min(Math.max(currentPage, 1), totalPages);
    for (
        let page = Math.max(1, clampedCurrentPage - CURRENT_PAGE_NEIGHBOR_COUNT);
        page <= Math.min(totalPages, clampedCurrentPage + CURRENT_PAGE_NEIGHBOR_COUNT);
        page += 1
    ) {
        pages.add(page);
    }
    return [...pages].sort((left, right) => left - right);
}

function isValidThumbnailAspectRatio(value: number | null | undefined): value is number {
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
