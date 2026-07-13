import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildThumbnailRenderQueue } from '@app/modules/pdf-viewer/thumbnails/buildThumbnailRenderQueue';

describe('buildThumbnailRenderQueue', () => {
    it('renders symmetrically around current before viewport and mounted overscan', () => {
        expect(buildThumbnailRenderQueue({
            totalPages: 158,
            currentPage: 9,
            visiblePages: [
                1,
                2,
                3,
                4,
            ],
            mountedPages: [
                1,
                2,
                3,
                4,
                14,
            ],
            renderedPages: new Set<number>(),
            renderingPages: new Set<number>(),
            immediateRenderRadius: 2,
            prefetchRenderRadius: 4,
        })).toEqual([
            9,
            8,
            10,
            7,
            11,
            4,
            3,
            2,
            1,
            6,
            5,
            12,
            13,
            14,
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
            4,
            6,
            3,
            7,
            2,
            1,
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
            8,
            3,
        ]);
    });
});
