import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDjvuContinuousScrollController } from '@app/modules/djvu-viewer/runtime/useDjvuContinuousScrollController';

function createControllerHarness(options: {
    containerHeight?: number;
    currentPage?: number;
    scrollTop?: number;
} = {}) {
    const currentPage = ref(options.currentPage ?? 5);
    const pageSizes = ref(Array.from({ length: 12 }, () => ({
        dpi: 300,
        width: 100,
        height: 100,
    })));
    const viewerElement = Object.assign({} as HTMLElement, {
        clientHeight: options.containerHeight ?? 0,
        scrollHeight: 2_000,
        scrollTop: options.scrollTop ?? 0,
        scrollIntoView: vi.fn(),
    });
    const viewerContainer = ref<HTMLElement | null>(viewerElement);
    const emittedCurrentPages: number[] = [];
    const controller = useDjvuContinuousScrollController({
        containerHeight: ref(options.containerHeight ?? 0),
        currentPage,
        emitCurrentPage: pageNumber => emittedCurrentPages.push(pageNumber),
        getPageDisplayScale: () => 1,
        isActive: computed(() => true),
        isContinuousScroll: computed(() => true),
        pageElements: new Map(),
        pageGapPx: 10,
        pageSizes,
        pageSnapshotSelector: '[data-page-number]',
        renderMarginPages: 2,
        overscanViewports: 1,
        syncLoadedPages: vi.fn(),
        totalPages: computed(() => pageSizes.value.length),
        viewerContainer,
    });

    return {
        controller,
        currentPage,
        emittedCurrentPages,
        viewerElement,
    };
}

describe('useDjvuContinuousScrollController', () => {
    it('refreshes a fallback continuous-scroll cache when the current page changes', () => {
        const {
            controller,
            currentPage,
        } = createControllerHarness({
            containerHeight: 0,
            currentPage: 5,
        });

        expect(controller.resolveContinuousScrollWindow()).toMatchObject({
            start: 3,
            end: 7,
            mostVisiblePage: 5,
        });

        currentPage.value = 8;

        expect(controller.resolveContinuousScrollWindow()).toMatchObject({
            start: 6,
            end: 10,
            mostVisiblePage: 8,
        });
    });

    it('syncs scroll direction and current page from measured viewport geometry', () => {
        const {
            controller,
            currentPage,
            emittedCurrentPages,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 5,
            scrollTop: 125,
        });

        controller.updateScrollPositionFromContainer();
        controller.detectCurrentPageFromViewport();

        expect(controller.scrollDirection.value).toBe(1);
        expect(currentPage.value).toBe(2);
        expect(emittedCurrentPages).toEqual([2]);

        viewerElement.scrollTop = 20;
        controller.updateScrollPositionFromContainer();

        expect(controller.scrollDirection.value).toBe(-1);
    });
});
