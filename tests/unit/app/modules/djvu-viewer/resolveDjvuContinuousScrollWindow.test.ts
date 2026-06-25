import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDjvuContinuousScrollWindow } from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

describe('resolveDjvuContinuousScrollWindow', () => {
    const pageHeights = Array.from({ length: 12 }, () => 100);

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

