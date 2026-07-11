export const THUMBNAIL_BACKGROUND_RENDER_PRIORITY = 10;
export const THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY = 80;

export interface IThumbnailRenderCoordination {
    owner: 'thumbnail' | 'thumbnail-current';
    priority: number;
}

export function resolveThumbnailRenderCoordination(
    pageNum: number,
    currentPage: number,
): IThumbnailRenderCoordination {
    if (pageNum === currentPage) {
        return {
            owner: 'thumbnail-current',
            priority: THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY,
        };
    }

    return {
        owner: 'thumbnail',
        priority: THUMBNAIL_BACKGROUND_RENDER_PRIORITY,
    };
}
