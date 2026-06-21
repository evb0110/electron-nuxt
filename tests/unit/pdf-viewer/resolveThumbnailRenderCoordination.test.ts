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
        const coordination = resolveThumbnailRenderCoordination(7, 7);

        expect(THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY).toBe(100);
        expect(coordination).toEqual({
            owner: 'thumbnail-current',
            priority: THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY,
        });
        expect(coordination.priority).toBeGreaterThan(THUMBNAIL_BACKGROUND_RENDER_PRIORITY);
    });

    it('keeps background thumbnail prefetches low priority', () => {
        const coordination = resolveThumbnailRenderCoordination(8, 7);

        expect(THUMBNAIL_BACKGROUND_RENDER_PRIORITY).toBe(10);
        expect(coordination).toEqual({
            owner: 'thumbnail',
            priority: THUMBNAIL_BACKGROUND_RENDER_PRIORITY,
        });
        expect(coordination.priority).toBeLessThan(THUMBNAIL_CURRENT_PAGE_RENDER_PRIORITY);
    });
});
