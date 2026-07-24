import {
    describe,
    expect,
    it,
} from 'vitest';
import { expandPdfThumbnailRasterDemand } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime';

const fence = {
    documentRevision: null,
    documentVersion: 1,
    loadToken: 1,
};

describe('PDF thumbnail raster demand policy', () => {
    it('classifies current, visible, immediate-neighbor, and mounted prefetch demand', () => {
        const demands = expandPdfThumbnailRasterDemand({
            active: true,
            currentPage: 9,
            documentFence: fence,
            estimatedPixels: () => 100,
            generation: 3,
            mountedPages: [
                1,
                2,
                3,
                4,
                7,
                8,
                9,
                10,
                11,
                12,
                13,
                14,
            ],
            totalPages: 158,
            visiblePages: [
                1,
                2,
                3,
                4,
            ],
        });

        expect(demands.find(demand => demand.pageNumber === 9)?.lane)
            .toBe('thumbnail-current');
        expect(demands.filter(demand => [
            7,
            8,
            10,
            11,
        ].includes(demand.pageNumber)).every(
            demand => demand.lane === 'thumbnail-visible',
        )).toBe(true);
        expect(demands.filter(demand => [
            1,
            2,
            3,
            4,
        ].includes(demand.pageNumber)).every(
            demand => demand.lane === 'thumbnail-visible',
        )).toBe(true);
        expect(demands.filter(demand => [
            12,
            13,
            14,
        ].includes(demand.pageNumber)).every(
            demand => demand.lane === 'prefetch',
        )).toBe(true);
    });

    it('deduplicates pages and excludes unmounted candidates', () => {
        const demands = expandPdfThumbnailRasterDemand({
            active: true,
            currentPage: 5,
            documentFence: fence,
            estimatedPixels: () => 100,
            generation: 1,
            mountedPages: [
                4,
                5,
                6,
            ],
            totalPages: 20,
            visiblePages: [
                1,
                4,
                5,
                6,
            ],
        });

        expect(demands.map(demand => demand.pageNumber)).toEqual([
            5,
            4,
            6,
        ]);
        expect(new Set(demands.map(demand => demand.pageNumber)).size)
            .toBe(demands.length);
    });

    it('publishes no demand while inactive', () => {
        expect(expandPdfThumbnailRasterDemand({
            active: false,
            currentPage: 1,
            documentFence: fence,
            estimatedPixels: () => 100,
            generation: 1,
            mountedPages: [1],
            totalPages: 1,
            visiblePages: [1],
        })).toEqual([]);
    });
});
