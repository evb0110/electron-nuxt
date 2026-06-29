import {
    computed,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDjvuContinuousScrollController } from '@app/modules/djvu-viewer/runtime/useDjvuContinuousScrollController';

function createControllerHarness(options: {
    containerHeight?: number;
    currentPage?: number;
    pageHeights?: number[];
    pageCount?: number;
    scrollHeight?: number;
    scrollTop?: number;
} = {}) {
    const currentPage = ref(options.currentPage ?? 5);
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
        clientHeight: options.containerHeight ?? 0,
        scrollHeight: options.scrollHeight ?? 2_000,
        scrollTop: options.scrollTop ?? 0,
        scrollIntoView: vi.fn(),
    });
    const viewerContainer = ref<HTMLElement | null>(viewerElement);
    const emittedCurrentPages: number[] = [];
    const syncLoadedPages = vi.fn();
    const controller = useDjvuContinuousScrollController({
        containerHeight: ref(options.containerHeight ?? 0),
        currentPage,
        emitCurrentPage: pageNumber => emittedCurrentPages.push(pageNumber),
        getPageDisplayScale: () => 1,
        isActive: computed(() => true),
        isContinuousScroll: computed(() => true),
        pageGapPx: 10,
        pageSizes,
        pageSnapshotSelector: '[data-page-number]',
        renderMarginPages: 2,
        overscanViewports: 1,
        syncLoadedPages,
        totalPages: computed(() => pageSizes.value.length),
        viewerContainer,
    });

    return {
        controller,
        currentPage,
        emittedCurrentPages,
        syncLoadedPages,
        viewerContainer,
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

describe('useDjvuContinuousScrollController', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

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

    it('resolves stable page offsets, total height, and direct scroll targets', () => {
        useBrowserTimerHarness();
        const {
            controller,
            currentPage,
            emittedCurrentPages,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageHeights: [
                100,
                120,
                80,
            ],
        });

        expect(controller.resolveContinuousScrollGeometry()).toMatchObject({
            pageTops: [
                10,
                120,
                250,
            ],
            totalHeight: 340,
        });
        expect(controller.getContinuousPageTop(3)).toBe(250);
        expect(controller.getContinuousDocumentHeight()).toBe(340);

        controller.scrollToContinuousPage(3);

        expect(viewerElement.scrollTop).toBe(250);
        expect(controller.scrollTop.value).toBe(250);
        expect(currentPage.value).toBe(3);
        expect(emittedCurrentPages).toEqual([3]);
        expect(controller.isProgrammaticScrollGuardActive.value).toBe(true);
    });

    it('clamps direct page jumps to the browser scroll range', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 260,
            currentPage: 1,
            pageHeights: [
                100,
                100,
                100,
            ],
            scrollHeight: 340,
        });

        expect(controller.getContinuousPageTop(3)).toBe(230);

        controller.scrollToContinuousPage(3);

        expect(viewerElement.scrollTop).toBe(80);
        expect(controller.scrollTop.value).toBe(80);
        expect(controller.scrollDirection.value).toBe(1);
    });

    it('retains the previous mounted window during active user scrolling, then settles to raw geometry', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        const initialWindow = controller.resolveContinuousScrollWindow();
        expect(initialWindow?.pageNumbers).toEqual([
            1,
            2,
            3,
        ]);

        viewerElement.scrollTop = 330;
        expect(controller.handleViewerScroll()).toBe(true);

        const stabilizedWindow = controller.resolveContinuousScrollWindow();
        expect(stabilizedWindow?.pageNumbers).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);

        vi.advanceTimersByTime(181);

        const settledWindow = controller.resolveContinuousScrollWindow();
        expect(settledWindow?.pageNumbers).toEqual([
            2,
            3,
            4,
            5,
            6,
        ]);
    });

    it('detects current page from raw geometry while the mounted window is stabilized', () => {
        useBrowserTimerHarness();
        const {
            controller,
            currentPage,
            emittedCurrentPages,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        expect(controller.resolveContinuousScrollWindow()?.pageNumbers).toEqual([
            1,
            2,
            3,
        ]);

        viewerElement.scrollTop = 330;
        controller.handleViewerScroll();
        controller.detectCurrentPageFromViewport();

        expect(controller.resolveContinuousScrollWindow()?.pageNumbers).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect(currentPage.value).toBe(4);
        expect(emittedCurrentPages).toEqual([4]);
    });

    it('projects continuous wheel movement before the native scroll event updates the controller', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        expect(controller.resolveContinuousScrollWindow()?.pageNumbers).toEqual([
            1,
            2,
            3,
        ]);

        expect(controller.handleProjectedWheelScroll({
            ctrlKey: false,
            deltaMode: 0,
            deltaX: 0,
            deltaY: 330,
            metaKey: false,
        } as WheelEvent)).toBe(true);

        expect(viewerElement.scrollTop).toBe(0);
        expect(controller.scrollTop.value).toBe(330);
        expect(controller.scrollDirection.value).toBe(1);
        expect(controller.resolveContinuousScrollWindow()?.pageNumbers).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
    });

    it('ignores projected wheel movement for horizontal and zoom gestures', () => {
        const {controller} = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        expect(controller.handleProjectedWheelScroll({
            ctrlKey: false,
            deltaMode: 0,
            deltaX: 100,
            deltaY: 10,
            metaKey: false,
        } as WheelEvent)).toBe(false);
        expect(controller.handleProjectedWheelScroll({
            ctrlKey: false,
            deltaMode: 0,
            deltaX: 100,
            deltaY: 100,
            metaKey: false,
        } as WheelEvent)).toBe(false);
        expect(controller.handleProjectedWheelScroll({
            ctrlKey: true,
            deltaMode: 0,
            deltaX: 0,
            deltaY: 330,
            metaKey: false,
        } as WheelEvent)).toBe(false);
        expect(controller.scrollTop.value).toBe(0);
    });

    it('guards programmatic page jumps so emitted scroll events do not start user-scroll stabilization', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerElement,
        } = createControllerHarness({
            containerHeight: 100,
            currentPage: 1,
            pageCount: 20,
            scrollTop: 0,
        });

        controller.scrollToContinuousPage(4);
        expect(controller.isProgrammaticScrollGuardActive.value).toBe(true);

        viewerElement.scrollTop = 330;

        expect(controller.handleViewerScroll()).toBe(false);
        expect(controller.resolveContinuousScrollWindow()?.pageNumbers).toEqual([
            2,
            3,
            4,
            5,
            6,
        ]);

        vi.advanceTimersByTime(181);

        expect(controller.isProgrammaticScrollGuardActive.value).toBe(false);
    });

    it('clears programmatic scroll state when resetting without a mounted container', () => {
        useBrowserTimerHarness();
        const {
            controller,
            viewerContainer,
        } = createControllerHarness();

        controller.beginProgrammaticScrollGuard();
        expect(controller.isProgrammaticScrollGuardActive.value).toBe(true);

        viewerContainer.value = null;
        controller.resetContainerScrollPosition();

        expect(controller.isProgrammaticScrollGuardActive.value).toBe(false);
        vi.advanceTimersByTime(181);
        expect(controller.isProgrammaticScrollGuardActive.value).toBe(false);
    });
});
