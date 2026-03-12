import {
    describe,
    expect,
    it,
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
});
