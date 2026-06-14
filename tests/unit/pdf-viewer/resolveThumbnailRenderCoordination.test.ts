import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    THUMBNAIL_BACKGROUND_RENDER_PRIORITY,
    THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY,
    resolveThumbnailRenderCoordination,
} from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderCoordination';

describe('resolveThumbnailRenderCoordination', () => {
    it('gives the current page thumbnail viewer-level priority', () => {
        expect(resolveThumbnailRenderCoordination(7, 7)).toEqual({
            owner: 'thumbnail-current',
            priority: THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY,
        });
    });

    it('keeps background thumbnail prefetches low priority', () => {
        expect(resolveThumbnailRenderCoordination(8, 7)).toEqual({
            owner: 'thumbnail',
            priority: THUMBNAIL_BACKGROUND_RENDER_PRIORITY,
        });
    });
});
