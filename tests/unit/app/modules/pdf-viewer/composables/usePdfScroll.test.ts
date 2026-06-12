import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfScroll } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { cast } from '@tests/helpers/cast';

function createContainerStub() {
    let scrollTop = 0;

    const container = cast<HTMLElement>({
        clientHeight: 200,
        scrollHeight: 2000,
        scrollTop: 0,
        querySelector: () => null,
        querySelectorAll: () => [],
    });

    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });

    return {
        container,
        getScrollTop: () => scrollTop,
    };
}

function createPageElementStub(pageNumber: number, top: number, height: number, buffered = false) {
    return cast<HTMLElement>({
        dataset: { page: String(pageNumber) },
        offsetTop: top,
        offsetHeight: height,
        classList: { contains: (className: string) => buffered && className === 'page_container--buffered' },
    });
}

function createMountedPageScrollHarness(options: {
    clientWidth: number;
    clientHeight: number;
    pageNumber: number;
    pageLeft: number;
    pageTop: number;
    pageWidth: number;
    pageHeight: number;
}) {
    let scrollLeft = 0;
    let scrollTop = 0;
    const selector = `.page_container[data-page="${options.pageNumber}"]`;
    const page = cast<HTMLElement>({
        dataset: { page: String(options.pageNumber) },
        offsetLeft: options.pageLeft,
        offsetTop: options.pageTop,
        offsetWidth: options.pageWidth,
        offsetHeight: options.pageHeight,
        clientWidth: options.pageWidth,
        clientHeight: options.pageHeight,
        classList: { contains: () => false },
    });
    const container = cast<HTMLElement>({
        clientWidth: options.clientWidth,
        clientHeight: options.clientHeight,
        scrollWidth: Math.max(options.clientWidth, options.pageLeft + options.pageWidth),
        scrollHeight: options.pageTop + options.pageHeight,
        querySelector: (requestedSelector: string) => requestedSelector === selector ? page : null,
        querySelectorAll: () => [page],
    });

    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = value;
        },
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });

    return {
        container,
        getScrollLeft: () => scrollLeft,
        getScrollTop: () => scrollTop,
    };
}

describe('usePdfScroll page layout fallback', () => {
    it('prefers a pinned current page while viewport metrics are stabilizing', () => {
        const { container } = createContainerStub();
        const getPinnedMostVisiblePage = vi.fn(() => 3);
        const scroll = usePdfScroll({ getPinnedMostVisiblePage });

        expect(scroll.getMostVisiblePage(container, 5)).toBe(3);
        expect(scroll.updateCurrentPage(container, 5)).toBe(3);
        expect(scroll.currentPage.value).toBe(3);
    });

    it('scrolls to hidden pages using per-page layout metrics', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub();
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 200,
                    height: 100,
                },
                {
                    width: 200,
                    height: 250,
                },
                {
                    width: 200,
                    height: 150,
                },
            ],
            totalPages: 3,
            viewMode: 'single',
            scale: 2,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: 200,
            fallbackHeight: 100,
        }));

        scroll.scrollToPage(container, 3, 3, 20);

        expect(getScrollTop()).toBe(740);
    });

    it('prefers mounted DOM visibility when layout metrics disagree during virtualization', () => {
        const mountedPage = createPageElementStub(5, 500, 200);
        const container = cast<HTMLElement>({
            clientHeight: 100,
            clientWidth: 200,
            scrollHeight: 2000,
            scrollWidth: 200,
            scrollLeft: 0,
            scrollTop: 550,
            querySelector: () => null,
            querySelectorAll: () => [mountedPage],
        });
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: Array.from({ length: 10 }, () => ({
                width: 200,
                height: 100,
            })),
            totalPages: 10,
            viewMode: 'single',
            scale: 1,
            gap: 0,
            paddingTop: 0,
            paddingBottom: 0,
            fallbackWidth: 200,
            fallbackHeight: 100,
        }));

        expect(scroll.getVisiblePageRange(container, 10)).toEqual({
            start: 5,
            end: 5,
        });
        expect(scroll.getMostVisiblePage(container, 10)).toBe(5);
    });

    it('ignores offscreen buffered pages when resolving visible page state', () => {
        const bufferedPage = createPageElementStub(2, 0, 300, true);
        const activePage = createPageElementStub(4, 20, 180);
        const container = cast<HTMLElement>({
            clientHeight: 200,
            clientWidth: 200,
            scrollHeight: 240,
            scrollWidth: 200,
            scrollLeft: 0,
            scrollTop: 0,
            querySelector: () => null,
            querySelectorAll: () => [
                bufferedPage,
                activePage,
            ],
        });
        const scroll = usePdfScroll();

        expect(scroll.getVisiblePageRange(container, 10)).toEqual({
            start: 4,
            end: 4,
        });
        expect(scroll.getMostVisiblePage(container, 10)).toBe(4);
    });

    it('scrolls to spread rows using row-aware layout metrics', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub();
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 300,
                    height: 100,
                },
                {
                    width: 280,
                    height: 140,
                },
                {
                    width: 320,
                    height: 120,
                },
                {
                    width: 260,
                    height: 160,
                },
                {
                    width: 240,
                    height: 110,
                },
            ],
            totalPages: 5,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: 240,
            fallbackHeight: 110,
        }));

        scroll.scrollToPage(container, 3, 5, 20);

        expect(getScrollTop()).toBe(160);
    });

    it('keeps marker navigation horizontally stable when the mounted page fits the viewport', () => {
        const {
            container,
            getScrollLeft,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 960,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();
        const rightSideMarkerRect = {
            left: 0.7,
            top: 0.25,
            width: 0.2,
            height: 0.1,
        };

        scroll.scrollToPage(container, 2, 3, 20, { markerRect: rightSideMarkerRect });

        expect(getScrollLeft()).toBe(0);
    });

    it('aligns PDF destination y coordinates to the viewport top', () => {
        const {
            container,
            getScrollTop,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 960,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();

        scroll.scrollToPage(container, 2, 3, 20, { pageYRatio: 0.25 });

        expect(getScrollTop()).toBe(580);
    });

    it('bounds marker navigation horizontally to the mounted page when the page is wider than the viewport', () => {
        const {
            container,
            getScrollLeft,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 1400,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();
        const farRightMarkerRect = {
            left: 0.8,
            top: 0.25,
            width: 0.2,
            height: 0.1,
        };

        scroll.scrollToPage(container, 2, 3, 20, { markerRect: farRightMarkerRect });

        expect(getScrollLeft()).toBe(440);
    });
});
