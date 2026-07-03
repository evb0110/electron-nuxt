import {
    computed,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDjvuViewportController } from '@app/modules/djvu-viewer/runtime/useDjvuViewportController';
import type { TPdfViewMode } from '@contracts/shared';

function createViewportControllerHarness(options: {
    containerHeight?: number;
    continuousScroll?: boolean;
    currentPage?: number;
    pageCount?: number;
    pageHeights?: number[];
    scrollHeight?: number;
    scrollTop?: number;
    viewMode?: TPdfViewMode;
} = {}) {
    const currentPage = ref(options.currentPage ?? 1);
    const isContinuousScroll = ref(options.continuousScroll ?? true);
    const viewMode = ref<TPdfViewMode>(options.viewMode ?? 'single');
    const heights = options.pageHeights ?? Array.from(
        { length: options.pageCount ?? 12 },
        () => 100,
    );
    const pageSizes = ref(heights.map(height => ({
        dpi: 300,
        width: 100,
        height,
    })));
    const viewerElement = Object.assign({} as HTMLElement, {
        clientHeight: options.containerHeight ?? 100,
        scrollHeight: options.scrollHeight ?? 2_000,
        scrollTop: options.scrollTop ?? 0,
    });
    const emittedCurrentPages: number[] = [];
    const clearPageFlipWheelAccumulator = vi.fn();
    const scrollActiveSpreadIntoView = vi.fn();
    const syncLoadedPages = vi.fn();
    const controller = useDjvuViewportController({
        clearPageFlipWheelAccumulator,
        containerHeight: ref(options.containerHeight ?? 100),
        currentPage,
        emitCurrentPage: pageNumber => emittedCurrentPages.push(pageNumber),
        getPageDisplayScale: () => 1,
        isActive: computed(() => true),
        isContinuousScroll: computed(() => isContinuousScroll.value),
        pageGapPx: 10,
        pageSizes,
        pageSnapshotSelector: '[data-page-number]',
        renderMarginPages: 2,
        overscanViewports: 1,
        scrollActiveSpreadIntoView,
        syncLoadedPages,
        totalPages: computed(() => pageSizes.value.length),
        viewMode: computed(() => viewMode.value),
        viewerContainer: ref(viewerElement),
    });

    return {
        clearPageFlipWheelAccumulator,
        controller,
        currentPage,
        emittedCurrentPages,
        scrollActiveSpreadIntoView,
        syncLoadedPages,
        viewerElement,
    };
}

function useBrowserTimerHarness() {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
        cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
        clearTimeout: globalThis.clearTimeout,
        requestAnimationFrame: (callback: FrameRequestCallback) => Number(globalThis.setTimeout(() => callback(0), 0)),
        setTimeout: globalThis.setTimeout,
    });
}

describe('useDjvuViewportController', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('exposes continuous rendered pages and visible range through the adapter', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerElement,
        } = createViewportControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        expect(controller.renderedPageNumbers.value).toEqual([
            1,
            2,
            3,
        ]);
        expect(controller.visibleRange.value).toEqual({
            start: 1,
            end: 3,
        });

        expect(controller.handleProjectedWheelScroll({
            ctrlKey: false,
            deltaMode: 0,
            deltaX: 0,
            deltaY: 330,
            metaKey: false,
        } as WheelEvent)).toBe(true);

        expect(viewerElement.scrollTop).toBe(0);
        expect(controller.renderedPageNumbers.value).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect(controller.visibleRange.value).toEqual({
            start: 1,
            end: 6,
        });
    });

    it('keeps non-continuous page jumps on the old emit and sync path', async () => {
        const {
            clearPageFlipWheelAccumulator,
            controller,
            currentPage,
            emittedCurrentPages,
            scrollActiveSpreadIntoView,
            syncLoadedPages,
        } = createViewportControllerHarness({
            continuousScroll: false,
            currentPage: 2,
            pageCount: 6,
            viewMode: 'single',
        });

        expect(controller.renderedPageNumbers.value).toEqual([2]);

        controller.scrollToPage(4);

        expect(currentPage.value).toBe(4);
        expect(emittedCurrentPages).toEqual([4]);
        expect(clearPageFlipWheelAccumulator).toHaveBeenCalledTimes(1);

        await nextTick();
        await Promise.resolve();

        expect(scrollActiveSpreadIntoView).toHaveBeenCalledTimes(1);
        expect(syncLoadedPages).toHaveBeenCalledTimes(1);
    });
});
