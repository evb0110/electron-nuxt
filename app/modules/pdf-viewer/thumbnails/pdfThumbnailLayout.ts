import { clamp } from 'es-toolkit/math';

const THUMBNAIL_GAP = 8;
export const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_ITEM_VERTICAL_PADDING = 8;
const THUMBNAIL_ITEM_CONTENT_GAP = 4;
const THUMBNAIL_NUMBER_LINE_HEIGHT = 16;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 2;
export const VIRTUAL_OVERSCAN = 8;
const AUTO_SYNC_COMFORT_PADDING_MIN_PX = 16;
const AUTO_SYNC_COMFORT_PADDING_MAX_PX = 48;

export interface IThumbnailLayoutSnapshot {
    heights: number[];
    tops: number[];
    totalHeight: number;
}

export interface IThumbnailPageBounds {
    bottom: number;
    height: number;
    top: number;
}

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

export function resolvePageAtScrollOffset(
    offset: number,
    totalPages: number,
    layout: Pick<IThumbnailLayoutSnapshot, 'heights' | 'tops'>,
    gap = THUMBNAIL_GAP,
) {
    if (totalPages <= 0) {
        return null;
    }

    const safeOffset = Math.max(0, offset);
    for (let index = 0; index < totalPages; index += 1) {
        const top = layout.tops[index] ?? 0;
        const height = layout.heights[index] ?? DEFAULT_THUMBNAIL_ITEM_HEIGHT;
        if (safeOffset < top + height + gap) {
            return index + 1;
        }
    }

    return totalPages;
}

export function resolveThumbnailInsertionIndex(
    offset: number,
    totalPages: number,
    layout: Pick<IThumbnailLayoutSnapshot, 'heights' | 'tops'>,
) {
    if (totalPages <= 0) {
        return 0;
    }

    for (let index = 0; index < totalPages; index += 1) {
        const top = layout.tops[index] ?? 0;
        const height = layout.heights[index] ?? DEFAULT_THUMBNAIL_ITEM_HEIGHT;
        if (offset < top + height / 2) {
            return index;
        }
    }

    return totalPages;
}

export function createThumbnailCanvasStyle(aspectRatio: number | null | undefined) {
    return isValidThumbnailAspectRatio(aspectRatio)
        ? {aspectRatio: `1 / ${aspectRatio}`}
        : {};
}

export function createThumbnailItemStyle(top: number) {
    return {transform: `translateY(${top}px)`};
}

export function resolveThumbnailPageBounds(
    page: number,
    layout: Pick<IThumbnailLayoutSnapshot, 'heights' | 'tops'>,
) {
    const top = Math.max(0, layout.tops[page - 1] ?? 0);
    const height = Math.max(1, layout.heights[page - 1] ?? DEFAULT_THUMBNAIL_ITEM_HEIGHT);
    return {
        top,
        bottom: top + height,
        height,
    };
}

export function getMaxThumbnailScrollTop(container: HTMLElement) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
}

export function getThumbnailComfortPaddingPx(container: HTMLElement) {
    return Math.min(
        AUTO_SYNC_COMFORT_PADDING_MAX_PX,
        Math.max(
            AUTO_SYNC_COMFORT_PADDING_MIN_PX,
            Math.round(container.clientHeight * 0.12),
        ),
    );
}

export function isThumbnailPageWithinComfortViewport(
    container: HTMLElement,
    bounds: IThumbnailPageBounds,
) {
    const comfortPadding = getThumbnailComfortPaddingPx(container);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const comfortTop = viewportTop + comfortPadding;
    const comfortBottom = viewportBottom - comfortPadding;

    return bounds.top >= comfortTop && bounds.bottom <= comfortBottom;
}

export function resolveCurrentPageThumbnailScrollTop(
    container: HTMLElement,
    bounds: IThumbnailPageBounds,
) {
    if (container.clientHeight <= 0) {
        return null;
    }

    const comfortPadding = getThumbnailComfortPaddingPx(container);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const comfortTop = viewportTop + comfortPadding;
    const comfortBottom = viewportBottom - comfortPadding;
    const maxScrollTop = getMaxThumbnailScrollTop(container);

    if (bounds.top >= comfortTop && bounds.bottom <= comfortBottom) {
        return null;
    }

    if (bounds.bottom <= viewportTop || bounds.top >= viewportBottom) {
        const centeredScrollTop = bounds.top - Math.max(0, (container.clientHeight - bounds.height) / 2);
        return clamp(centeredScrollTop, 0, maxScrollTop);
    }

    if (bounds.top < comfortTop) {
        return clamp(bounds.top - comfortPadding, 0, maxScrollTop);
    }

    return clamp(bounds.bottom + comfortPadding - container.clientHeight, 0, maxScrollTop);
}
