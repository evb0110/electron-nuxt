import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildThumbnailRenderQueue } from '@app/modules/pdf-viewer/thumbnails/buildThumbnailRenderQueue';

describe('buildThumbnailRenderQueue', () => {
    it('prioritizes the current page and mounted visible pages on a cold start', () => {
        expect(buildThumbnailRenderQueue({
            totalPages: 158,
            currentPage: 9,
            visiblePages: [
                1,
                2,
                3,
                4,
            ],
            renderedPages: new Set<number>(),
            renderingPages: new Set<number>(),
            immediateRenderRadius: 2,
            prefetchRenderRadius: 4,
        })).toEqual([
            9,
            1,
            2,
            3,
            4,
            7,
            8,
            10,
            11,
            5,
            6,
            12,
            13,
        ]);
    });

    it('stages visible pages before nearby prefetches once warm-up has started', () => {
        expect(buildThumbnailRenderQueue({
            totalPages: 20,
            currentPage: 5,
            visiblePages: [
                1,
                2,
                3,
            ],
            renderedPages: new Set<number>([5]),
            renderingPages: new Set<number>(),
            immediateRenderRadius: 2,
            prefetchRenderRadius: 4,
        })).toEqual([
            1,
            2,
            3,
            4,
            6,
            7,
            8,
            9,
        ]);
    });

    it('skips pages that are already rendered or in flight', () => {
        expect(buildThumbnailRenderQueue({
            totalPages: 12,
            currentPage: 6,
            visiblePages: [
                4,
                5,
                6,
                7,
            ],
            renderedPages: new Set<number>([
                4,
                6,
                7,
            ]),
            renderingPages: new Set<number>([5]),
            immediateRenderRadius: 1,
            prefetchRenderRadius: 2,
        })).toEqual([
            3,
            8,
        ]);
    });
});
