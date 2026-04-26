import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { buildPageLayoutMetrics } from '@app/composables/pdf/pdfPageLayout';

function cast<T>(value: unknown): T {
    return value as T;
}

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

function createPageElementStub(pageNumber: number, top: number, height: number) {
    return cast<HTMLElement>({
        dataset: { page: String(pageNumber) },
        offsetTop: top,
        offsetHeight: height,
    });
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
});
