import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDjvuContinuousScrollGeometry,
    resolveDjvuContinuousScrollWindow,
} from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

describe('resolveDjvuContinuousScrollWindow', () => {
    const pageHeights = Array.from({ length: 12 }, () => 100);

    it('creates stable page offsets and full document height', () => {
        expect(resolveDjvuContinuousScrollGeometry({
            pageGapPx: 10,
            pageHeights: [
                100,
                120,
                80,
            ],
            totalPages: 3,
        })).toEqual({
            pageHeights: [
                100,
                120,
                80,
            ],
            pageTops: [
                10,
                120,
                250,
            ],
            totalHeight: 340,
        });
    });

    it('returns an anchored fallback window when the viewport has no height', () => {
        expect(resolveDjvuContinuousScrollWindow({
            currentPage: 10,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 3,
            scrollTop: 0,
            totalPages: 12,
            viewportHeight: 0,
            overscanViewports: 2,
        })).toEqual({
            start: 7,
            end: 12,
            mostVisiblePage: 10,
            pageNumbers: [
                7,
                8,
                9,
                10,
                11,
                12,
            ],
        });
    });

    it('resolves the visible page and render margin from page geometry', () => {
        expect(resolveDjvuContinuousScrollWindow({
            currentPage: 5,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 1,
            scrollTop: 125,
            totalPages: 12,
            viewportHeight: 100,
            overscanViewports: 1,
        })).toEqual({
            start: 1,
            end: 3,
            mostVisiblePage: 2,
            pageNumbers: [
                1,
                2,
                3,
            ],
        });
    });

    it('uses the overscan range when the viewport is between pages', () => {
        expect(resolveDjvuContinuousScrollWindow({
            currentPage: 5,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 1,
            scrollTop: 0,
            totalPages: 12,
            viewportHeight: 5,
            overscanViewports: 2,
        })).toEqual({
            start: 1,
            end: 6,
            mostVisiblePage: 5,
            pageNumbers: [
                1,
                2,
                3,
                4,
                5,
                6,
            ],
        });
    });

    it('bounds page intersection reads to the overscan band when geometry is precomputed', () => {
        const manyPageHeights = Array.from({ length: 5_000 }, () => 100);
        const rawGeometry = resolveDjvuContinuousScrollGeometry({
            pageGapPx: 10,
            pageHeights: manyPageHeights,
            totalPages: manyPageHeights.length,
        });
        let heightReads = 0;
        let topReads = 0;
        const countNumericReads = (values: number[], onRead: () => void) => {
            const countedValues = [...values];
            values.forEach((value, index) => {
                Object.defineProperty(countedValues, index, {
                    configurable: true,
                    get() {
                        onRead();
                        return value;
                    },
                });
            });
            return countedValues;
        };
        const geometry = {
            pageHeights: countNumericReads(rawGeometry.pageHeights, () => {
                heightReads += 1;
            }),
            pageTops: countNumericReads(rawGeometry.pageTops, () => {
                topReads += 1;
            }),
            totalHeight: rawGeometry.totalHeight,
        };

        expect(resolveDjvuContinuousScrollWindow({
            currentPage: 2_500,
            geometry,
            pageGapPx: 10,
            pageHeights: manyPageHeights,
            renderMarginPages: 2,
            scrollTop: rawGeometry.pageTops[2_499] ?? 0,
            totalPages: manyPageHeights.length,
            viewportHeight: 100,
            overscanViewports: 1,
        })?.mostVisiblePage).toBe(2_500);
        expect(topReads).toBeLessThan(80);
        expect(heightReads).toBeLessThan(80);
    });

    it('returns null when there are no document pages', () => {
        expect(resolveDjvuContinuousScrollWindow({
            currentPage: 1,
            pageGapPx: 10,
            pageHeights: [],
            renderMarginPages: 1,
            scrollTop: 0,
            totalPages: 0,
            viewportHeight: 100,
            overscanViewports: 1,
        })).toBeNull();
    });
});
