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
