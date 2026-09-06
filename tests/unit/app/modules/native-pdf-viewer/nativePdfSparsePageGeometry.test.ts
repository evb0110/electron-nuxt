import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createNativePdfPageGeometry,
    createNativePdfSparsePageLayout,
    NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT,
} from '@app/modules/native-pdf-viewer/runtime/nativePdfSparsePageGeometry';
import {requirePageNumber} from '@contracts/pageNumbers';

describe('native PDF sparse page geometry', () => {
    it('keeps first and last page windows bounded for a million-page document', () => {
        const pageCount = 1_000_000;
        const pageGeometry = createNativePdfPageGeometry({
            pageCount,
            defaultPageSize: {
                width: 612,
                height: 792,
            },
            overrides: [
                {
                    pageNumber: requirePageNumber(1),
                    width: 500,
                    height: 700,
                },
                {
                    pageNumber: requirePageNumber(pageCount),
                    width: 1_000,
                    height: 1_400,
                },
            ],
        });
        const layout = createNativePdfSparsePageLayout(pageGeometry, {
            availableHeight: 800,
            availableWidth: 900,
            manualZoom: 1,
            pageGapPx: 16,
            zoomMode: 'custom',
        });

        expect(pageGeometry.pageCount).toBe(pageCount);
        expect(pageGeometry.getKnownPageNumbers()).toEqual([
            1,
            pageCount,
        ]);
        expect(layout.getPageSize(1)).toEqual({
            width: 500,
            height: 700,
        });
        expect(layout.getPageSize(pageCount)).toEqual({
            width: 1_000,
            height: 1_400,
        });

        const firstWindow = layout.resolvePageNumbers({
            activePage: 1,
            overscanViewports: 2,
            renderMarginPages: 3,
            scrollTop: 0,
            viewportHeight: 800,
        });
        const lastWindow = layout.resolvePageNumbers({
            activePage: pageCount,
            overscanViewports: 2,
            renderMarginPages: 3,
            scrollTop: layout.getPageTop(pageCount),
            viewportHeight: 800,
        });

        expect(firstWindow[0]).toBe(1);
        expect(firstWindow.length).toBeLessThanOrEqual(NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT);
        expect(lastWindow.at(-1)).toBe(pageCount);
        expect(lastWindow.length).toBeLessThanOrEqual(NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT);
        expect(layout.totalHeight).toBeGreaterThan(layout.getPageTop(pageCount));

        const visitedPageNumbers: number[] = [];
        const adapter = layout.createZoomLayoutAdapter({
            getActivePage: () => pageCount,
            getPageLeft: () => 16,
            getScrollTop: () => layout.getPageTop(pageCount),
            getViewportHeight: () => 800,
            overscanViewports: 2,
            renderMarginPages: 3,
        });
        adapter.forEach((_page, pageIndex) => {
            visitedPageNumbers.push(pageIndex + 1);
        });

        expect(adapter.length).toBe(pageCount);
        expect(visitedPageNumbers.length).toBeLessThanOrEqual(
            NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT + 2 + 2 * 4,
        );
        expect(visitedPageNumbers).toContain(1);
        expect(visitedPageNumbers).toContain(pageCount);
        expect(adapter[pageCount - 1]).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number),
            top: layout.getPageTop(pageCount),
        });
    });
});
