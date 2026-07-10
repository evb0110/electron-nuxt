import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
    resolveDocumentViewportPageNumbers,
} from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';

function bruteForceVisiblePages(options: {
    pageHeights: number[];
    pageGapPx: number;
    scrollTop: number;
    viewportHeight: number;
    overscanViewports: number;
}) {
    const geometry = resolveDocumentContinuousScrollGeometry({
        pageGapPx: options.pageGapPx,
        pageHeights: options.pageHeights,
        totalPages: options.pageHeights.length,
    });
    const start = Math.max(0, options.scrollTop - options.viewportHeight * options.overscanViewports);
    const end = options.scrollTop + options.viewportHeight * (1 + options.overscanViewports);
    return geometry.pageTops.flatMap((top, index) => (
        top + (geometry.pageHeights[index] ?? 0) >= start && top <= end ? [index + 1] : []
    ));
}

describe('Native PDF viewer viewport primitive parity', () => {
    it.each([
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 0,
            viewportHeight: 160,
            overscan: 0,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 125,
            viewportHeight: 190,
            overscan: 0,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 280,
            viewportHeight: 120,
            overscan: 2,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 116,
            viewportHeight: 216,
            overscan: 0,
        },
    ])('matches the legacy intersection window for $scrollTop', ({
        heights,
        scrollTop,
        viewportHeight,
        overscan,
    }) => {
        const pageGapPx = 16;
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx,
            pageHeights: heights,
            totalPages: heights.length,
        });
        const pages = resolveDocumentViewportPageNumbers({
            geometry,
            pageGapPx,
            scrollTop,
            totalPages: heights.length,
            viewportHeight,
            overscanViewports: overscan,
        });
        expect(pages).toEqual(bruteForceVisiblePages({
            pageHeights: heights,
            pageGapPx,
            scrollTop,
            viewportHeight,
            overscanViewports: overscan,
        }));
    });

    it('selects the page with the largest viewport intersection', () => {
        const heights = [
            100,
            200,
            80,
        ];
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 16,
            pageHeights: heights,
            totalPages: heights.length,
        });
        expect(resolveDocumentContinuousScrollWindow({
            currentPage: 1,
            geometry,
            pageGapPx: 16,
            pageHeights: heights,
            renderMarginPages: 0,
            scrollTop: 90,
            totalPages: heights.length,
            viewportHeight: 180,
            overscanViewports: 0,
        })?.mostVisiblePage).toBe(2);
    });
});
