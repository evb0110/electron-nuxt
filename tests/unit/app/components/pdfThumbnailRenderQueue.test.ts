import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildThumbnailRenderQueue } from '@app/components/pdf/pdfThumbnailRenderQueue';

describe('buildThumbnailRenderQueue', () => {
    it('renders only the current page on a cold start', () => {
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
        })).toEqual([9]);
    });

    it('stages nearby and visible pages once warm-up has started', () => {
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
            3,
            4,
            6,
            7,
            1,
            2,
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
