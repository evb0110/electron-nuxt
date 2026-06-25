import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { clamp } from 'es-toolkit/math';
import {
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type { Ref } from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { usePdfSinglePageScroll } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScroll';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { accumulateWheelForPageFlips } from '@app/utils/document-viewer/single-page-wheel/accumulateWheelForPageFlips';
import { resolveWheelPageFlipStepDelta } from '@app/utils/document-viewer/single-page-wheel/resolveWheelPageFlipStepDelta';
import { resolveSnapAnchorForWheelDirection } from '@app/utils/document-viewer/single-page-wheel/resolveSnapAnchorForWheelDirection';
import type { TWheelDirection } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';
import type { TPdfViewMode } from '@contracts/shared';
import { cast } from '@tests/helpers/cast';

type TRenderVisiblePages = Parameters<typeof usePdfSinglePageScroll>[0]['renderVisiblePages'];
type TVisibleRangeRef = Ref<{
    start: number;
    end: number;
}>;

interface ITestPageGeometry {
    offsetLeft?: number;
    offsetTop: number;
    offsetWidth?: number;
    offsetHeight: number;
}

interface IScrollHarnessOptions {
    viewMode?: TPdfViewMode;
    pageGeometries?: ITestPageGeometry[];
    mountedPageNumbers?: number[];
    canvasReadyPageNumbers?: number[];
    freshRenderedPageNumbers?: number[];
    hiddenSkeletonPageNumbers?: number[];
    skeletonPageNumbers?: number[];
    visuallyReadyPageNumbers?: number[];
    getMostVisiblePage?: (viewer: HTMLElement | null) => number;
    clientHeight?: number;
    scrollHeight?: number;
    continuousScroll?: boolean;
    suppressPagedRowRender?: () => boolean;
    preparePagedTargetLayout?: Parameters<typeof usePdfSinglePageScroll>[0]['preparePagedTargetLayout'];
    renderVisiblePages?: TRenderVisiblePages;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    clientWidth?: number;
    scrollWidth?: number;
    updateVisibleRange?: (
        container: HTMLElement | null,
        numPages: number,
        visibleRange: TVisibleRangeRef,
    ) => void;
}

function createWheelEvent(
    deltaY: number,
    timeStamp: number,
    deltaX = 0,
    deltaMode = 0,
    modifiers?: {
        ctrlKey?: boolean;
        metaKey?: boolean;
    },
): WheelEvent {
    return cast<WheelEvent>({
        deltaX,
        deltaY,
        deltaMode,
        timeStamp,
        ctrlKey: modifiers?.ctrlKey ?? false,
        metaKey: modifiers?.metaKey ?? false,
        preventDefault: vi.fn(),
    });
}

function createSinglePageScrollHarness(options?: IScrollHarnessOptions) {
    const pageGeometries: ITestPageGeometry[] = options?.pageGeometries ?? [
        {
            offsetTop: 20,
            offsetHeight: 100,
        },
        {
            offsetTop: 140,
            offsetHeight: 180,
        },
        {
            offsetTop: 340,
            offsetHeight: 100,
        },
    ];

    const clientHeight = options?.clientHeight ?? 100;
    const clientWidth = options?.clientWidth ?? 100;
    const scrollHeight = options?.scrollHeight ?? 440;
    const scrollWidth = options?.scrollWidth ?? clientWidth;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    let scrollTop = 0;
    let scrollLeft = 0;
    const mountedPageNumbers = options?.mountedPageNumbers
        ?? pageGeometries.map((_, index) => index + 1);
    const visuallyReadyPageNumbers = new Set(
        options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const canvasReadyPageNumbers = new Set(
        options?.canvasReadyPageNumbers ?? options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const freshRenderedPageNumbers = new Set(
        options?.freshRenderedPageNumbers ?? options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const skeletonPageNumbers = new Set(options?.skeletonPageNumbers ?? []);
    const hiddenSkeletonPageNumbers = new Set(options?.hiddenSkeletonPageNumbers ?? []);
    const pageElements = pageGeometries.map((page, index) => {
        const mountedPage = mountedPageNumbers[index] ?? index + 1;
        return cast<HTMLElement>({
            offsetLeft: page.offsetLeft ?? 0,
            ...page,
            offsetWidth: page.offsetWidth ?? clientWidth,
            dataset: {page: String(mountedPage)},
            classList: { contains: vi.fn((className: string) => (
                className === 'page_container--rendered'
                && visuallyReadyPageNumbers.has(mountedPage)
            )) },
            querySelector: vi.fn((selector: string) => {
                if (selector === '.page_canvas canvas') {
                    return canvasReadyPageNumbers.has(mountedPage) ? {} : null;
                }
                if (selector === '.pdf-page-skeleton') {
                    return skeletonPageNumbers.has(mountedPage)
                        ? {style: {display: hiddenSkeletonPageNumbers.has(mountedPage) ? 'none' : ''}}
                        : null;
                }
                return null;
            }),
        });
    });
    const container = cast<HTMLElement>({
        clientHeight,
        clientWidth,
        scrollHeight,
        scrollWidth,
        querySelector: vi.fn((selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements.find((pageElement) => {
                const mountedPage = Number.parseInt(pageElement.dataset?.page ?? '', 10);
                return mountedPage === pageNumber;
            }) ?? null;
        }),
        querySelectorAll: vi.fn(() => pageElements),
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = clamp(value, 0, maxScrollTop);
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = clamp(value, 0, maxScrollLeft);
        },
    });

    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const scrollToPageInternal = vi.fn();
    const renderVisiblePages = vi.fn(options?.renderVisiblePages ?? (async () => {}));
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });
    const emitNavigationFeedbackPage = vi.fn();

    const defaultMostVisiblePage = (viewer: HTMLElement | null) => {
        if (!viewer) {
            return 1;
        }
        if (viewer.scrollTop >= 320) {
            return 3;
        }
        if (viewer.scrollTop >= 120) {
            return 2;
        }
        return 1;
    };
    const getMostVisiblePage = options?.getMostVisiblePage ?? defaultMostVisiblePage;
    const updateVisibleRange = vi.fn((
        viewer: HTMLElement | null,
        pageCount: number,
    ) => options?.updateVisibleRange?.(viewer, pageCount, visibleRange));

    const singlePageScroll = usePdfSinglePageScroll({
        viewerContainer: shallowRef(container),
        numPages: ref(pageGeometries.length),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref(options?.viewMode ?? 'single'),
        continuousScroll: ref(options?.continuousScroll ?? false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage,
        scrollToPageInternal,
        updateVisibleRange,
        updateCurrentPage: vi.fn((viewer: HTMLElement | null) => getMostVisiblePage(viewer)),
        renderVisiblePages,
        ensurePageMetricsInRange: options?.ensurePageMetricsInRange,
        preparePagedTargetLayout: options?.preparePagedTargetLayout,
        suppressPagedRowRender: options?.suppressPagedRowRender,
        isPageFreshlyRenderedForNavigation: pageNumber => freshRenderedPageNumbers.has(pageNumber),
        visibleRange,
        emitCurrentPage,
        emitNavigationFeedbackPage,
    });

    return {
        container,
        currentPage,
        emitCurrentPage,
        emitNavigationFeedbackPage,
        markPageCanvasReady: (pageNumber: number) => canvasReadyPageNumbers.add(pageNumber),
        markPageFreshRendered: (pageNumber: number) => freshRenderedPageNumbers.add(pageNumber),
        markPageStaleRendered: (pageNumber: number) => freshRenderedPageNumbers.delete(pageNumber),
        hidePageSkeleton: (pageNumber: number) => skeletonPageNumbers.delete(pageNumber),
        markPageVisualReady: (pageNumber: number) => {
            visuallyReadyPageNumbers.add(pageNumber);
            freshRenderedPageNumbers.add(pageNumber);
        },
        renderVisiblePages,
        updateVisibleRange,
        visibleRange,
        scrollToPageInternal,
        singlePageScroll,
    };
}

function createSinglePageNavigationControllerHarness() {
    const pageGeometries: ITestPageGeometry[] = [
        {
            offsetTop: 20,
            offsetHeight: 100,
        },
        {
            offsetTop: 140,
            offsetHeight: 100,
        },
        {
            offsetTop: 260,
            offsetHeight: 100,
        },
    ];
    let scrollTop = 0;
    const visuallyReadyPageNumbers = new Set([
        1,
        2,
    ]);
    const pageElements = pageGeometries.map((page, index) => {
        const pageNumber = index + 1;
        return cast<HTMLElement>({
            ...page,
            offsetLeft: 0,
            offsetWidth: 100,
            dataset: {page: String(pageNumber)},
            classList: { contains: vi.fn((className: string) => (
                className === 'page_container--rendered'
                && visuallyReadyPageNumbers.has(pageNumber)
            )) },
            querySelector: vi.fn((selector: string) => (
                selector === '.page_canvas canvas'
                && visuallyReadyPageNumbers.has(pageNumber)
                    ? {}
                    : null
            )),
        });
    });
    const container = cast<HTMLElement>({
        clientHeight: 100,
        clientWidth: 100,
        scrollHeight: 400,
        scrollWidth: 100,
        querySelector: vi.fn((selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements[pageNumber - 1] ?? null;
        }),
        querySelectorAll: vi.fn(() => pageElements),
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = clamp(value, 0, 300);
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => 0,
        set: () => {},
    });

    const currentPage = ref(1);
    const requestedCurrentPage = ref<number | undefined>(undefined);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const cancelPendingSearchScroll = vi.fn();
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });
    const singlePageScroll = usePdfSinglePageNavigationController({
        requestedCurrentPage,
        viewerContainer: shallowRef(container),
        numPages: ref(3),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref<TPdfViewMode>('single'),
        continuousScroll: ref(false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage: () => currentPage.value,
        scrollToPageInternal: vi.fn(),
        updateVisibleRange: vi.fn(),
        updateCurrentPage: vi.fn(() => currentPage.value),
        renderVisiblePages: vi.fn(async () => {}),
        visibleRange,
        emitCurrentPage,
        cancelPendingSearchScroll,
    });

    return {
        cancelPendingSearchScroll,
        requestedCurrentPage,
        singlePageScroll,
    };
}

describe('usePdfSinglePageNavigationController', () => {
    it('cancels stale pending navigation when requested page reverts to the current page', async () => {
        const {
            cancelPendingSearchScroll,
            requestedCurrentPage,
            singlePageScroll,
        } = createSinglePageNavigationControllerHarness();

        singlePageScroll.scrollToPage(3);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);

        requestedCurrentPage.value = 1;
        await nextTick();

        expect(cancelPendingSearchScroll).toHaveBeenCalledOnce();
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
        expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
    });
});

describe('usePdfSinglePageScroll programmatic scroll ownership', () => {
    it('reports a held continuous target as overridden after viewport scroll drift', () => {
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({continuousScroll: true});

        singlePageScroll.scrollToPage(2);
        container.scrollTop = 120;

        expect(singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll()).toBe(false);

        container.scrollTop = 180;

        expect(singlePageScroll.shouldCancelProgrammaticNavigationForViewportScroll()).toBe(true);
    });
});

describe('usePdfSinglePageScroll helpers', () => {
    it('accumulates small deltas and flips only after threshold', () => {
        let state: {
            delta: number;
            direction: TWheelDirection | 0;
            lastEventTimeMs: number 
        } = {
            delta: 0,
            direction: 0,
            lastEventTimeMs: 0,
        };

        let result = accumulateWheelForPageFlips({
            state,
            delta: 40,
            direction: 1,
            eventTimeMs: 10,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(0);
        expect(result.state.delta).toBe(40);

        state = result.state;
        result = accumulateWheelForPageFlips({
            state,
            delta: 50,
            direction: 1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(0);
        expect(result.state.delta).toBe(90);

        state = result.state;
        result = accumulateWheelForPageFlips({
            state,
            delta: 40,
            direction: 1,
            eventTimeMs: 30,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(1);
        expect(result.state.delta).toBe(10);
    });

    it('applies repeated flips without time lock and caps flips per event', () => {
        const first = accumulateWheelForPageFlips({
            state: {
                delta: 0,
                direction: 0,
                lastEventTimeMs: 0,
            },
            delta: 130,
            direction: 1,
            eventTimeMs: 10,
            stepDelta: 120,
        });
        expect(first.stepsToFlip).toBe(1);

        const second = accumulateWheelForPageFlips({
            state: first.state,
            delta: 130,
            direction: 1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(second.stepsToFlip).toBe(1);

        const capped = accumulateWheelForPageFlips({
            state: {
                delta: 0,
                direction: 0,
                lastEventTimeMs: 0,
            },
            delta: 720,
            direction: 1,
            eventTimeMs: 30,
            stepDelta: 120,
        });
        expect(capped.stepsToFlip).toBe(3);
    });

    it('resets accumulated progress on direction change and idle gap', () => {
        const changedDirection = accumulateWheelForPageFlips({
            state: {
                delta: 100,
                direction: 1,
                lastEventTimeMs: 10,
            },
            delta: -30,
            direction: -1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(changedDirection.stepsToFlip).toBe(0);
        expect(changedDirection.state.delta).toBe(-30);

        const stale = accumulateWheelForPageFlips({
            state: {
                delta: 100,
                direction: 1,
                lastEventTimeMs: 10,
            },
            delta: 50,
            direction: 1,
            eventTimeMs: 200,
            stepDelta: 120,
        });
        expect(stale.stepsToFlip).toBe(0);
        expect(stale.state.delta).toBe(50);
    });

    it('maps wheel direction to directional page anchors', () => {
        expect(resolveSnapAnchorForWheelDirection(1)).toBe('top');
        expect(resolveSnapAnchorForWheelDirection(-1)).toBe('bottom');
    });

    it('resolves adaptive step sizes from wheel mode and delta magnitude', () => {
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 1 }, 16)).toBe(16);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 2 }, 500)).toBe(500);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 20)).toBe(40);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 100)).toBe(100);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 240)).toBe(120);
    });
});

describe('usePdfSinglePageScroll wheel behavior', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores ctrl/meta wheel packets to avoid competing with zoom gestures', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        const ctrlEvent = createWheelEvent(120, 10, 0, 0, {ctrlKey: true});
        singlePageScroll.handleWheel(ctrlEvent);
        expect(currentPage.value).toBe(1);
        expect(container.scrollTop).toBe(0);
        expect(ctrlEvent.preventDefault).not.toHaveBeenCalled();

        const metaEvent = createWheelEvent(120, 20, 0, 0, {metaKey: true});
        singlePageScroll.handleWheel(metaEvent);
        expect(currentPage.value).toBe(1);
        expect(container.scrollTop).toBe(0);
        expect(metaEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('scrolls inside tall page first, then flips only at page edge', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        const downToSecond = createWheelEvent(120, 10);
        singlePageScroll.handleWheel(downToSecond);
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(120);
        expect(downToSecond.preventDefault).toHaveBeenCalledOnce();

        singlePageScroll.handleWheel(createWheelEvent(60, 20));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(180);

        singlePageScroll.handleWheel(createWheelEvent(60, 30));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(200);

        singlePageScroll.handleWheel(createWheelEvent(120, 40));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);
    });

    it('clears boundary accumulation and flips promptly when wheeling up', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        singlePageScroll.handleWheel(createWheelEvent(60, 20));
        singlePageScroll.handleWheel(createWheelEvent(60, 30));
        singlePageScroll.handleWheel(createWheelEvent(120, 40));

        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);

        singlePageScroll.handleWheel(createWheelEvent(400, 50));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);

        singlePageScroll.handleWheel(createWheelEvent(-60, 60));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(200);
    });

    it('does not reject mixed diagonal gestures when vertical intent is clear', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(120, 10, 80));
        expect(currentPage.value).toBe(2);
    });

    it('ignores horizontal-dominant wheel gestures in paged mode', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();
        const horizontalGesture = createWheelEvent(120, 10, 150);

        expect(singlePageScroll.handleWheel(horizontalGesture)).toBe(false);
        expect(horizontalGesture.preventDefault).not.toHaveBeenCalled();
        expect(currentPage.value).toBe(1);
        expect(container.scrollTop).toBe(0);
    });

    it('flips on a single line-mode wheel tick at page edge', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(1, 10, 0, 1));
        expect(currentPage.value).toBe(2);
    });

    it('moves one spread per wheel threshold in facing mode', () => {
        const {
            currentPage,
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            viewMode: 'facing',
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
            ],
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 360) {
                    return 7;
                }
                if (viewer.scrollTop >= 240) {
                    return 5;
                }
                if (viewer.scrollTop >= 120) {
                    return 3;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(720, 10));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(120);
    });

    it('flips down at page boundary when computed page bounds exceed container max scroll', () => {
        const {
            currentPage,
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 500,
                },
                {
                    offsetTop: 540,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 600,
            getMostVisiblePage: (viewer) => (viewer?.scrollTop ?? 0) >= 500 ? 2 : 1,
        });

        currentPage.value = 2;
        container.scrollTop = 500;

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(500);
    });

    it('falls back to internal page scrolling in continuous mode when target page is not mounted', () => {
        const {
            currentPage,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            mountedPageNumbers: [
                10,
                11,
                12,
            ],
        });

        singlePageScroll.scrollToPage(1);

        expect(scrollToPageInternal).toHaveBeenCalledOnce();
        expect(currentPage.value).toBe(1);
    });

    it('keeps paged scrollToPage programmatic until the settle timer releases it', () => {
        vi.useFakeTimers();
        try {
            const {singlePageScroll} = createSinglePageScrollHarness({mountedPageNumbers: [
                1,
                99,
                100,
            ]});

            singlePageScroll.scrollToPage(2);

            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);

            vi.advanceTimersByTime(800);

            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps paged navigation held until the target row has a fresh canvas', async () => {
        const {
            currentPage,
            emitCurrentPage,
            emitNavigationFeedbackPage,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            canvasReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
        });

        singlePageScroll.scrollToPage(3);
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(currentPage.value).toBe(1);
        expect(emitCurrentPage).not.toHaveBeenCalledWith(3);
        expect(emitNavigationFeedbackPage).toHaveBeenCalledWith(3);
        expect(emitNavigationFeedbackPage).not.toHaveBeenCalledWith(null);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);

        markPageCanvasReady(3);
        markPageVisualReady(3);
        singlePageScroll.releasePagedNavigationHoldForPage(3);

        expect(currentPage.value).toBe(3);
        expect(emitCurrentPage).toHaveBeenCalledWith(3);
        expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(null);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('prepares paged target layout before publishing the target row', async () => {
        const preparation = { resolve: null as (() => void) | null };
        const preparePagedTargetLayout = vi.fn(() => new Promise<void>((resolve) => {
            preparation.resolve = resolve;
        }));
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            canvasReadyPageNumbers: [1],
            freshRenderedPageNumbers: [1],
            visuallyReadyPageNumbers: [1],
            preparePagedTargetLayout,
            suppressPagedRowRender: () => true,
        });

        const didScroll = singlePageScroll.scrollToPage(3);
        await nextTick();

        expect(didScroll).toBe(true);
        expect(preparePagedTargetLayout).toHaveBeenCalledWith(3, expect.any(Function));
        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();

        preparation.resolve?.();
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
    });

    it('invalidates stale paged target layout preparation after a newer click', async () => {
        const firstPreparation = {
            resolve: null as (() => void) | null,
            shouldContinue: null as (() => boolean) | null,
        };
        const preparePagedTargetLayout = vi.fn((
            pageNumber: number,
            shouldContinue: () => boolean,
        ) => {
            if (pageNumber === 2) {
                firstPreparation.shouldContinue = shouldContinue;
                return new Promise<void>((resolve) => {
                    firstPreparation.resolve = resolve;
                });
            }
            return undefined;
        });
        const { singlePageScroll } = createSinglePageScrollHarness({
            canvasReadyPageNumbers: [1],
            freshRenderedPageNumbers: [1],
            visuallyReadyPageNumbers: [1],
            preparePagedTargetLayout,
            suppressPagedRowRender: () => true,
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();
        singlePageScroll.scrollToPage(3);

        expect(firstPreparation.shouldContinue?.()).toBe(false);

        firstPreparation.resolve?.();
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
    });

    it('retries paged navigation release after canvas DOM readiness settles', async () => {
        const {
            currentPage,
            emitCurrentPage,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            canvasReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            suppressPagedRowRender: () => true,
        });

        singlePageScroll.scrollToPage(3);
        await nextTick();
        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);

        singlePageScroll.releasePagedNavigationHoldForPage(3);
        markPageCanvasReady(3);
        markPageVisualReady(3);
        await nextTick();

        expect(currentPage.value).toBe(3);
        expect(emitCurrentPage).toHaveBeenCalledWith(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(false);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('walks search navigation state through navigating, settling, then idle', () => {
        vi.useFakeTimers();
        try {
            const {
                emitNavigationFeedbackPage,
                singlePageScroll,
            } = createSinglePageScrollHarness();

            singlePageScroll.beginSearchNavigation(2, 500);

            expect(singlePageScroll.searchNavigationState.value).toBe('navigating');
            expect(singlePageScroll.searchNavigationTargetPage.value).toBe(2);
            expect(singlePageScroll.isSearchNavigationLocked.value).toBe(true);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
            expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(2);

            singlePageScroll.endSearchNavigation(80);

            expect(singlePageScroll.searchNavigationState.value).toBe('settling');
            expect(singlePageScroll.searchNavigationTargetPage.value).toBe(2);
            expect(singlePageScroll.isSearchNavigationLocked.value).toBe(true);

            vi.advanceTimersByTime(80);

            expect(singlePageScroll.searchNavigationState.value).toBe('idle');
            expect(singlePageScroll.searchNavigationTargetPage.value).toBeNull();
            expect(singlePageScroll.isSearchNavigationLocked.value).toBe(false);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
            expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(null);

            vi.advanceTimersByTime(421);
            singlePageScroll.handleScroll();

            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores stale search completion after newer paged navigation takes ownership', () => {
        const {singlePageScroll} = createSinglePageScrollHarness({visuallyReadyPageNumbers: [
            1,
            2,
        ]});

        singlePageScroll.beginSearchNavigation(2, 500);
        singlePageScroll.scrollToPage(3);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);

        singlePageScroll.endSearchNavigation(0);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
    });

    it('clears held paged navigation when search takes ownership', async () => {
        const {
            emitNavigationFeedbackPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
        });

        singlePageScroll.scrollToPage(3);
        await nextTick();

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);

        singlePageScroll.beginSearchNavigation(2, 500);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(false);
        expect(singlePageScroll.searchNavigationTargetPage.value).toBe(2);
        expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(2);
    });

    it('reveals a mounted paged search target without committing the current page', async () => {
        const {
            container,
            currentPage,
            emitCurrentPage,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness();

        singlePageScroll.beginSearchNavigation(3, 500);
        expect(singlePageScroll.revealSearchNavigationTarget(3)).toBe(true);

        expect(visibleRange.value).toEqual({
            start: 3,
            end: 3,
        });

        await nextTick();

        expect(container.scrollTop).toBe(320);
        expect(currentPage.value).toBe(1);
        expect(emitCurrentPage).not.toHaveBeenCalledWith(3);
    });

    it('uses the search marker rect for the initial paged target reveal', async () => {
        const {
            container,
            currentPage,
            emitCurrentPage,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            clientHeight: 200,
            scrollHeight: 1300,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 1000,
                },
            ],
        });

        singlePageScroll.beginSearchNavigation(2, 500);
        expect(singlePageScroll.revealSearchNavigationTarget(2, {markerRect: {
            left: 0.2,
            top: 0.75,
            width: 0.1,
            height: 0.05,
        }})).toBe(true);

        expect(visibleRange.value).toEqual({
            start: 2,
            end: 2,
        });

        await nextTick();

        expect(container.scrollTop).toBe(815);
        expect(currentPage.value).toBe(1);
        expect(emitCurrentPage).not.toHaveBeenCalledWith(2);
    });

    it('bounds the initial paged search reveal to the target page for near-bottom matches', async () => {
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            clientHeight: 200,
            scrollHeight: 1300,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 1000,
                },
            ],
        });

        singlePageScroll.beginSearchNavigation(2, 500);
        expect(singlePageScroll.revealSearchNavigationTarget(2, {markerRect: {
            left: 0.02,
            top: 0.96,
            width: 0.05,
            height: 0.02,
        }})).toBe(true);

        await nextTick();

        expect(container.scrollTop).toBe(960);
    });

    it('reveals a continuous search target with layout scrolling when the page is unmounted', () => {
        const {
            currentPage,
            emitCurrentPage,
            scrollToPageInternal,
            singlePageScroll,
            updateVisibleRange,
            visibleRange,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 500,
                    offsetHeight: 100,
                },
            ],
            mountedPageNumbers: [
                10,
                11,
                12,
                13,
                14,
            ],
            getMostVisiblePage: () => 5,
            updateVisibleRange: (_viewer, _pageCount, range) => {
                range.value = {
                    start: 5,
                    end: 5,
                };
            },
        });

        singlePageScroll.beginSearchNavigation(5, 500);
        expect(singlePageScroll.revealSearchNavigationTarget(5)).toBe(true);

        expect(scrollToPageInternal).toHaveBeenCalledOnce();
        expect(scrollToPageInternal.mock.calls[0]?.[1]).toBe(5);
        expect(scrollToPageInternal.mock.calls[0]?.[4]).toBeUndefined();
        expect(updateVisibleRange).toHaveBeenCalledOnce();
        expect(visibleRange.value).toEqual({
            start: 5,
            end: 5,
        });
        expect(currentPage.value).toBe(5);
        expect(emitCurrentPage).toHaveBeenCalledWith(5);
    });

    it('reveals a continuous search target with the current match marker rect', () => {
        const {
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({continuousScroll: true});

        const markerRect = {
            left: 0.2,
            top: 0.75,
            width: 0.1,
            height: 0.05,
        };
        singlePageScroll.beginSearchNavigation(2, 500);
        expect(singlePageScroll.revealSearchNavigationTarget(2, { markerRect })).toBe(true);

        expect(scrollToPageInternal).toHaveBeenCalledWith(
            expect.anything(),
            2,
            3,
            20,
            { markerRect },
        );
    });

    it('publishes a temporary continuous navigation anchor while jumping to an unmounted page', async () => {
        vi.useFakeTimers();
        try {
            const {
                scrollToPageInternal,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                continuousScroll: true,
                mountedPageNumbers: [
                    10,
                    11,
                    12,
                ],
            });

            singlePageScroll.scrollToPage(1);

            expect(scrollToPageInternal).toHaveBeenCalledOnce();
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBe(1);

            await vi.runAllTimersAsync();
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reapplies a continuous programmatic jump after the virtualized window settles', async () => {
        vi.useFakeTimers();
        try {
            const {
                renderVisiblePages,
                scrollToPageInternal,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                continuousScroll: true,
                mountedPageNumbers: [
                    10,
                    11,
                    12,
                ],
            });

            singlePageScroll.scrollToPage(1, { preferExactDom: true });
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);

            await vi.runOnlyPendingTimersAsync();
            await nextTick();

            expect(scrollToPageInternal.mock.calls.length).toBeGreaterThan(1);
            expect(scrollToPageInternal.mock.calls[1]?.[4]).toEqual({ preferExactDom: true });
            expect(renderVisiblePages).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reapplies continuous destination navigation with the original page y target', async () => {
        vi.useFakeTimers();
        try {
            const {
                renderVisiblePages,
                scrollToPageInternal,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                continuousScroll: true,
                mountedPageNumbers: [
                    10,
                    11,
                    12,
                ],
            });

            singlePageScroll.scrollToPage(1, {pageYRatio: 0});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);

            await vi.runOnlyPendingTimersAsync();
            await nextTick();

            expect(scrollToPageInternal.mock.calls.length).toBeGreaterThan(1);
            expect(scrollToPageInternal.mock.calls[1]?.[4]).toEqual({ pageYRatio: 0 });
            expect(renderVisiblePages).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reapplies continuous destination navigation after the visible render settles', async () => {
        const waitMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));
        let resolveRender: (() => void) | undefined;
        const renderComplete = new Promise<void>((resolve) => {
            resolveRender = resolve;
        });
        const {
            renderVisiblePages,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            mountedPageNumbers: [
                10,
                11,
                12,
            ],
            renderVisiblePages: async () => renderComplete,
        });

        try {
            singlePageScroll.scrollToPage(1, {pageYRatio: 0});

            await waitMacrotask();
            await waitMacrotask();
            await nextTick();
            await Promise.resolve();

            expect(renderVisiblePages).toHaveBeenCalledTimes(1);
            expect(scrollToPageInternal).toHaveBeenCalledTimes(2);

            resolveRender?.();
            await nextTick();
            await Promise.resolve();
            await nextTick();
            await waitMacrotask();
            await waitMacrotask();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(4);
            expect(scrollToPageInternal.mock.calls[2]?.[4]).toEqual({pageYRatio: 0});
            expect(scrollToPageInternal.mock.calls[3]?.[4]).toEqual({pageYRatio: 0});
            const preFrameReapplyOrder = scrollToPageInternal.mock.invocationCallOrder[2];
            const postFrameReapplyOrder = scrollToPageInternal.mock.invocationCallOrder[3];
            const renderOrder = renderVisiblePages.mock.invocationCallOrder[0];
            expect(preFrameReapplyOrder).toBeDefined();
            expect(postFrameReapplyOrder).toBeDefined();
            expect(renderOrder).toBeDefined();
            expect(preFrameReapplyOrder!)
                .toBeGreaterThan(renderOrder!);
            expect(postFrameReapplyOrder!)
                .toBeGreaterThan(preFrameReapplyOrder!);
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('hydrates target row metrics before the first continuous destination scroll', async () => {
        const waitMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));
        let resolveHydration!: (value: boolean) => void;
        const hydrationPromise = new Promise<boolean>((resolve) => {
            resolveHydration = resolve;
        });
        const ensurePageMetricsInRange = vi.fn(() => hydrationPromise);
        const {
            renderVisiblePages,
            scrollToPageInternal,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            ensurePageMetricsInRange,
        });

        try {
            singlePageScroll.scrollToPage(3, {pageYRatio: 0});

            expect(ensurePageMetricsInRange).toHaveBeenCalledWith(3, 3);
            expect(scrollToPageInternal).not.toHaveBeenCalled();

            resolveHydration(true);
            await nextTick();
            await Promise.resolve();
            await nextTick();
            await waitMacrotask();
            await waitMacrotask();

            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 1,
                    preserveInFlightRequiredPages: true,
                },
            );
            expect(visibleRange.value).toEqual({
                start: 3,
                end: 3,
            });
            expect(scrollToPageInternal).toHaveBeenCalledWith(
                expect.anything(),
                3,
                3,
                20,
                {pageYRatio: 0},
            );
            expect(scrollToPageInternal.mock.invocationCallOrder[0])
                .toBeGreaterThan(renderVisiblePages.mock.invocationCallOrder[0]!);
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('clears a continuous navigation anchor when target metric hydration fails', async () => {
        const waitMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));
        const ensurePageMetricsInRange = vi.fn(async () => {
            throw new Error('metric hydration failed');
        });
        const {singlePageScroll} = createSinglePageScrollHarness({
            continuousScroll: true,
            ensurePageMetricsInRange,
        });

        singlePageScroll.scrollToPage(3, {pageYRatio: 0});

        expect(singlePageScroll.continuousNavigationTargetPage.value).toBe(3);

        await Promise.resolve();
        await waitMacrotask();

        expect(singlePageScroll.continuousNavigationTargetPage.value).toBeNull();
    });

    it('uses mounted exact DOM immediately for continuous fit snaps even when metric hydration is available', () => {
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const {
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            ensurePageMetricsInRange,
        });

        const didScroll = singlePageScroll.scrollToPage(3, { preferExactDom: true });

        expect(didScroll).toBe(true);
        expect(ensurePageMetricsInRange).not.toHaveBeenCalled();
        expect(scrollToPageInternal).toHaveBeenCalledOnce();
        expect(scrollToPageInternal.mock.calls[0]?.[1]).toBe(3);
    });

    it('continues continuous destination navigation when target metrics are already cached', async () => {
        const waitMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));
        const ensurePageMetricsInRange = vi.fn(async () => false);
        const {
            renderVisiblePages,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            ensurePageMetricsInRange,
        });

        try {
            singlePageScroll.scrollToPage(3, {pageYRatio: 0});

            await nextTick();
            await Promise.resolve();
            await nextTick();
            await waitMacrotask();
            await waitMacrotask();

            expect(ensurePageMetricsInRange).toHaveBeenCalledWith(3, 3);
            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 1,
                    preserveInFlightRequiredPages: true,
                },
            );
            expect(scrollToPageInternal).toHaveBeenCalledWith(
                expect.anything(),
                3,
                3,
                20,
                {pageYRatio: 0},
            );
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('reapplies continuous destination navigation after a target layout mutation', async () => {
        const mutationCallbacks: MutationCallback[] = [];
        class TestMutationObserver {
            observe = vi.fn();
            disconnect = vi.fn();

            constructor(callback: MutationCallback) {
                mutationCallbacks.push(callback);
            }
        }
        vi.stubGlobal('MutationObserver', TestMutationObserver);

        const {
            container,
            renderVisiblePages,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            mountedPageNumbers: [
                10,
                11,
                12,
            ],
        });

        try {
            singlePageScroll.scrollToPage(1, {pageYRatio: 0});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
            expect(mutationCallbacks).toHaveLength(1);

            const mutationRecord = cast<MutationRecord>({
                target: container,
                addedNodes: cast<NodeList>([]),
                removedNodes: cast<NodeList>([]),
            });
            mutationCallbacks[0]?.([mutationRecord], cast<MutationObserver>({}));
            await nextTick();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(2);
            expect(scrollToPageInternal.mock.calls[1]?.[4]).toEqual({pageYRatio: 0});
            expect(renderVisiblePages).not.toHaveBeenCalled();
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('reapplies continuous destination navigation after stale scroll restoration', async () => {
        const {
            container,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
        });

        try {
            singlePageScroll.scrollToPage(2, {pageYRatio: 0});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);

            container.scrollTop = 0;
            singlePageScroll.handleScroll();
            await nextTick();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(2);
            expect(scrollToPageInternal.mock.calls[1]?.[1]).toBe(2);
            expect(scrollToPageInternal.mock.calls[1]?.[4]).toEqual({pageYRatio: 0});
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('reapplies continuous marker navigation when horizontal alignment is stale', async () => {
        const {
            container,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            clientWidth: 100,
            scrollWidth: 600,
            pageGeometries: [
                {
                    offsetLeft: 0,
                    offsetTop: 20,
                    offsetWidth: 300,
                    offsetHeight: 100,
                },
                {
                    offsetLeft: 200,
                    offsetTop: 140,
                    offsetWidth: 300,
                    offsetHeight: 100,
                },
            ],
        });
        const markerRect = {
            left: 0.8,
            top: 0.45,
            width: 0.2,
            height: 0.1,
        };

        try {
            singlePageScroll.scrollToPage(2, {markerRect});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);

            container.scrollTop = 140;
            container.scrollLeft = 0;
            singlePageScroll.handleScroll();
            await nextTick();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(2);
            expect(scrollToPageInternal.mock.calls[1]?.[1]).toBe(2);
            expect(scrollToPageInternal.mock.calls[1]?.[4]).toEqual({markerRect});
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('reapplies hydrated continuous destination navigation after stale scroll restoration', async () => {
        const waitMacrotask = () => new Promise(resolve => setTimeout(resolve, 0));
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const {
            container,
            scrollToPageInternal,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            ensurePageMetricsInRange,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
        });

        try {
            singlePageScroll.scrollToPage(2, {pageYRatio: 0});

            await nextTick();
            await Promise.resolve();
            await nextTick();
            await waitMacrotask();
            await waitMacrotask();

            expect(ensurePageMetricsInRange).toHaveBeenCalledWith(2, 2);
            expect(scrollToPageInternal).toHaveBeenCalledTimes(2);

            container.scrollTop = 0;
            singlePageScroll.handleScroll();
            await nextTick();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(3);
            expect(scrollToPageInternal.mock.calls[2]?.[1]).toBe(2);
            expect(scrollToPageInternal.mock.calls[2]?.[4]).toEqual({pageYRatio: 0});
        } finally {
            singlePageScroll.resetContinuousScrollState();
        }
    });

    it('cancels held continuous destination navigation before user scrolling', async () => {
        vi.useFakeTimers();
        try {
            const {
                scrollToPageInternal,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                continuousScroll: true,
                mountedPageNumbers: [
                    10,
                    11,
                    12,
                ],
            });

            singlePageScroll.scrollToPage(1, {pageYRatio: 0});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBe(1);

            singlePageScroll.cancelContinuousNavigationTarget();
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBeNull();

            await vi.runOnlyPendingTimersAsync();
            await nextTick();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels stale continuous destination navigation when search navigation begins', async () => {
        vi.useFakeTimers();
        try {
            const {
                scrollToPageInternal,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                continuousScroll: true,
                mountedPageNumbers: [
                    10,
                    11,
                    12,
                ],
            });

            singlePageScroll.scrollToPage(1, {preferExactDom: true});
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBe(1);

            singlePageScroll.beginSearchNavigation(2, 500);

            expect(singlePageScroll.searchNavigationTargetPage.value).toBe(2);
            expect(singlePageScroll.continuousNavigationTargetPage.value).toBeNull();

            await vi.runOnlyPendingTimersAsync();
            await nextTick();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('renders only the latest pending paged target during rapid supersession', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const {
                renderVisiblePages,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                pageGeometries: [
                    {
                        offsetTop: 20,
                        offsetHeight: 100,
                    },
                    {
                        offsetTop: 140,
                        offsetHeight: 100,
                    },
                    {
                        offsetTop: 260,
                        offsetHeight: 100,
                    },
                ],
                clientHeight: 100,
                scrollHeight: 380,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            singlePageScroll.scrollToPage(3);
            await nextTick();

            expect(renderVisiblePages).toHaveBeenCalledTimes(1);
            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                    preserveInFlightRequiredPages: true,
                },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('can snap to a mounted paged target without queueing another row render', async () => {
        const {
            renderVisiblePages,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.scrollToPage(1, {
            preferExactDom: true,
            suppressRenderAfterSnap: true,
        });
        await nextTick();

        expect(renderVisiblePages).not.toHaveBeenCalled();
    });

    it('suppresses queued paged row render when an exact target is not mounted yet', async () => {
        const mountedPageNumbers = [
            1,
            99,
            100,
        ];
        const {
            currentPage,
            renderVisiblePages,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({ mountedPageNumbers });

        const didScroll = singlePageScroll.scrollToPage(2, {
            preferExactDom: true,
            suppressRenderAfterSnap: true,
        });
        await nextTick();

        expect(didScroll).toBe(true);
        expect(currentPage.value).toBe(1);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });

    it('cancels stale paged navigation ownership before the next viewport scroll sync', () => {
        const {
            currentPage,
            emitCurrentPage,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            mountedPageNumbers: [
                1,
                99,
                100,
            ],
            getMostVisiblePage: () => 1,
            updateVisibleRange: (_viewer, _pageCount, range) => {
                range.value = {
                    start: 1,
                    end: 1,
                };
            },
        });

        singlePageScroll.scrollToPage(2);
        singlePageScroll.cancelProgrammaticNavigation();
        singlePageScroll.handleScroll();

        expect(currentPage.value).toBe(1);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });
        expect(emitCurrentPage).not.toHaveBeenCalled();
    });

    it('renders the authoritative paged target even when fit-current suppression is active', async () => {
        const suppressPagedRowRender = vi.fn(() => true);
        const {
            renderVisiblePages,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            mountedPageNumbers: [],
            suppressPagedRowRender,
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(suppressPagedRowRender).toHaveBeenCalled();
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 2,
                end: 2,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                preserveInFlightRequiredPages: true,
            },
        );
    });

    it('throttles rapid same-direction flips on small pages (trackpad inertia guard)', () => {
        // Fixture with three small pages that each fit the viewport so no
        // tall-page interior scrolling can bypass the cooldown.
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 360,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        // Two rapid wheel events 30ms apart simulate macOS trackpad inertia.
        // Without a cooldown the second event would advance to page 3.
        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(2);
        const scrollTopAfterFirstFlip = container.scrollTop;

        singlePageScroll.handleWheel(createWheelEvent(120, 40));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(scrollTopAfterFirstFlip);

        // After the cooldown elapses the next event should advance.
        singlePageScroll.handleWheel(createWheelEvent(120, 250));
        expect(currentPage.value).toBe(3);
    });

    it('does not accumulate a long pixel-wheel tail into a late same-direction page flip', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 360,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(2);

        for (const timeStamp of [
            40,
            80,
            130,
            190,
            230,
            270,
            310,
            370,
            430,
            490,
            550,
            610,
        ]) {
            singlePageScroll.handleWheel(createWheelEvent(30, timeStamp));
            expect(currentPage.value).toBe(2);
        }

        singlePageScroll.handleWheel(createWheelEvent(120, 850));
        expect(currentPage.value).toBe(3);
    });

    it('keeps paging during a sustained same-direction pixel-wheel gesture', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 480,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 360) {
                    return 4;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(2);

        for (const timeStamp of [
            70,
            130,
            190,
            250,
            310,
            370,
        ]) {
            singlePageScroll.handleWheel(createWheelEvent(120, timeStamp));
            expect(currentPage.value).toBe(2);
        }

        singlePageScroll.handleWheel(createWheelEvent(120, 430));
        expect(currentPage.value).toBe(3);
    });

    it('keeps paging during sustained small-delta trackpad scrolling', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 480,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 360) {
                    return 4;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(30, 10));
        expect(currentPage.value).toBe(1);
        singlePageScroll.handleWheel(createWheelEvent(30, 70));
        expect(currentPage.value).toBe(2);

        for (const timeStamp of [
            130,
            190,
            250,
        ]) {
            singlePageScroll.handleWheel(createWheelEvent(30, timeStamp));
            expect(currentPage.value).toBe(2);
        }

        singlePageScroll.handleWheel(createWheelEvent(30, 310));
        expect(currentPage.value).toBe(2);
        singlePageScroll.handleWheel(createWheelEvent(30, 370));
        expect(currentPage.value).toBe(3);
    });

    it('does not starve sustained low-delta trackpad scrolling after a small-delta flip', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 480,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 360) {
                    return 4;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(30, 10));
        expect(currentPage.value).toBe(1);
        singlePageScroll.handleWheel(createWheelEvent(30, 70));
        expect(currentPage.value).toBe(2);

        for (const timeStamp of [
            130,
            190,
            250,
            310,
            370,
        ]) {
            singlePageScroll.handleWheel(createWheelEvent(15, timeStamp));
            expect(currentPage.value).toBe(2);
        }

        singlePageScroll.handleWheel(createWheelEvent(15, 430));
        expect(currentPage.value).toBe(3);
    });

    it('reuses in-flight paged target layout preparation for repeated same-target wheel input', () => {
        const preparePagedTargetLayout = vi.fn(() => new Promise<void>(() => {}));
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({ preparePagedTargetLayout });

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(1);
        expect(preparePagedTargetLayout).toHaveBeenCalledTimes(1);
        expect(preparePagedTargetLayout).toHaveBeenLastCalledWith(2, expect.any(Function));

        singlePageScroll.handleWheel(createWheelEvent(120, 250));
        expect(currentPage.value).toBe(1);
        expect(preparePagedTargetLayout).toHaveBeenCalledTimes(1);
    });

    it('bypasses cooldown when wheel direction reverses', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
            clientHeight: 100,
            scrollHeight: 360,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 240) {
                    return 3;
                }
                if (viewer.scrollTop >= 120) {
                    return 2;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(2);

        // Reversing direction immediately should NOT be blocked by cooldown —
        // the user explicitly changed intent.
        singlePageScroll.handleWheel(createWheelEvent(-120, 30));
        expect(currentPage.value).toBe(1);
    });

    it('snaps fit-height pages to top so margins frame the page (no "1.5 pages" bleed)', () => {
        // Fit-height layout: each page is shorter than the container by 2x
        // margin (40 px), the canonical case where the previous 'center' anchor
        // produced a scrollTop offset by half-margin (20 px) and bled the
        // adjacent page into view. Container=100, margin=20, page height=60,
        // so a perfectly framed snap is scrollTop=offsetTop−margin.
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 100,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 180,
                    offsetHeight: 60,
                },
            ],
            clientHeight: 100,
            scrollHeight: 260,
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 160) {
                    return 3;
                }
                if (viewer.scrollTop >= 80) {
                    return 2;
                }
                return 1;
            },
        });

        // Wheel down → flip to page 2. With 'top' anchor, scrollTop should be
        // baseTop = offsetTop(2) − margin = 100 − 20 = 80. Viewport [80, 180]
        // shows the 20px gutter, then page 2 (100..160), then 20px gutter
        // below the page. With the buggy 'center' anchor it would have been
        // 80 − (100 − 60)/2 = 60, viewport [60, 160] — which would put the
        // bottom 20px of page 1 (which ends at 80) inside the top of the
        // viewport.
        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(80);

        // Wheel up → flip back to page 1. 'top' anchor: scrollTop = max(0,
        // 20 − 20) = 0. (Both 'top' and the old 'center' resolve to 0 here
        // because of the clamp, but the assertion documents the contract.)
        singlePageScroll.handleWheel(createWheelEvent(-120, 30));
        expect(currentPage.value).toBe(1);
        expect(container.scrollTop).toBe(0);
    });

    it('emits current page updates while search navigation suppression is active', () => {
        const {
            container,
            currentPage,
            emitCurrentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.beginSearchNavigation(2, 500);
        container.scrollTop = 160;

        singlePageScroll.handleScroll();

        expect(currentPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
    });

    it('emits reconciled page in continuous mode when exact target page is not mounted', () => {
        const {
            currentPage,
            emitCurrentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: true,
            mountedPageNumbers: [
                10,
                11,
                12,
            ],
            getMostVisiblePage: () => 1,
        });

        currentPage.value = 3;
        singlePageScroll.scrollToPage(1, {preferExactDom: true});

        expect(currentPage.value).toBe(1);
        expect(emitCurrentPage).toHaveBeenCalledWith(1);
    });

    it('keeps an unmounted paged target pending before visual readiness', async () => {
        const {
            currentPage,
            emitCurrentPage,
            scrollToPageInternal,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            continuousScroll: false,
            mountedPageNumbers: [
                1,
                99,
                100,
            ],
        });

        singlePageScroll.scrollToPage(2);

        expect(currentPage.value).toBe(1);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(emitCurrentPage).not.toHaveBeenCalled();
        expect(scrollToPageInternal).not.toHaveBeenCalled();

        await nextTick();
        expect(scrollToPageInternal).not.toHaveBeenCalled();
    });

    it('keeps a paged navigation target pending while stale scroll events settle', () => {
        const {
            currentPage,
            emitCurrentPage,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            continuousScroll: false,
            mountedPageNumbers: [1],
            getMostVisiblePage: () => 1,
        });

        singlePageScroll.scrollToPage(2);
        singlePageScroll.handleScroll();

        expect(currentPage.value).toBe(1);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(emitCurrentPage).not.toHaveBeenCalled();
    });

    it('advances wheel paging from the current page after stale visibility lags behind', () => {
        vi.useFakeTimers();
        try {
            const staleVisiblePage = vi.fn(() => 3);
            const {
                currentPage,
                emitCurrentPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                pageGeometries: [
                    {
                        offsetTop: 20,
                        offsetHeight: 60,
                    },
                    {
                        offsetTop: 100,
                        offsetHeight: 60,
                    },
                    {
                        offsetTop: 180,
                        offsetHeight: 60,
                    },
                    {
                        offsetTop: 260,
                        offsetHeight: 60,
                    },
                    {
                        offsetTop: 340,
                        offsetHeight: 60,
                    },
                ],
                clientHeight: 100,
                scrollHeight: 420,
                getMostVisiblePage: staleVisiblePage,
            });

            singlePageScroll.scrollToPage(4);
            expect(currentPage.value).toBe(4);

            vi.advanceTimersByTime(601);

            const wheelEvent = createWheelEvent(120, 700);
            expect(singlePageScroll.handleWheel(wheelEvent)).toBe(true);

            expect(wheelEvent.preventDefault).toHaveBeenCalled();
            expect(currentPage.value).toBe(5);
            expect(emitCurrentPage).toHaveBeenLastCalledWith(5);
            expect(staleVisiblePage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('scrollToPage in single-page mode snaps fit-height pages to top (no "1.5 pages" bleed)', () => {
        // Fit-height geometry: page (60 tall) + 20-margin gutters within a
        // 100-tall viewport. The pre-fix 'center' anchor would set
        // scrollTop = baseTop − (containerHeight − pageHeight)/2
        //           = (140 − 20) − (100 − 60)/2
        //           = 120 − 20 = 100
        // which leaves the bottom 20 px of the previous page visible at the
        // top of the viewport. The 'top' anchor sets
        // scrollTop = baseTop = 120, framing page 2 cleanly.
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: false,
            clientHeight: 100,
            scrollHeight: 280,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 220,
                    offsetHeight: 60,
                },
            ],
        });

        singlePageScroll.scrollToPage(2);

        expect(container.scrollTop).toBe(120);
    });

    it('scrollToPage in single-page mode honors PDF destination y on tall pages', () => {
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: false,
            clientHeight: 100,
            scrollHeight: 620,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 400,
                },
            ],
        });

        singlePageScroll.scrollToPage(2, { pageYRatio: 0.25 });

        expect(container.scrollTop).toBe(220);
    });

    it('scrollToPage in facing-first-single mode honors destination y against the target page height', () => {
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            continuousScroll: false,
            clientHeight: 100,
            scrollHeight: 520,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 70,
                },
                {
                    offsetTop: 110,
                    offsetHeight: 200,
                },
                {
                    offsetTop: 110,
                    offsetHeight: 60,
                },
            ],
        });

        singlePageScroll.scrollToPage(3, { pageYRatio: 0.5 });

        expect(container.scrollTop).toBe(120);
    });

    it('scrollToPage in facing-first-single mode frames the full spread row', () => {
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            continuousScroll: false,
            clientHeight: 100,
            scrollHeight: 270,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 70,
                },
                {
                    offsetTop: 110,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 110,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 190,
                    offsetHeight: 60,
                },
                {
                    offsetTop: 190,
                    offsetHeight: 60,
                },
            ],
        });

        singlePageScroll.scrollToPage(2);

        expect(container.scrollTop).toBe(90);
    });

    it('keeps the commit hold until the pending target reports visual readiness', () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                markPageCanvasReady,
                markPageVisualReady,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.isNavigationHoldActiveForPage(1)).toBe(false);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);

            vi.advanceTimersByTime(700);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

            markPageCanvasReady(2);
            markPageVisualReady(2);
            singlePageScroll.releasePagedNavigationHoldForPage(2);
            expect(currentPage.value).toBe(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('commits held paged navigation from the watchdog ready retry once the target is visually ready', async () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                emitCurrentPage,
                emitNavigationFeedbackPage,
                markPageCanvasReady,
                markPageVisualReady,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(currentPage.value).toBe(1);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(emitNavigationFeedbackPage).toHaveBeenCalledWith(2);

            vi.advanceTimersByTime(119);

            markPageCanvasReady(2);
            markPageVisualReady(2);

            expect(currentPage.value).toBe(1);
            expect(emitCurrentPage).not.toHaveBeenCalledWith(2);

            vi.advanceTimersByTime(1);

            expect(currentPage.value).toBe(2);
            expect(emitCurrentPage).toHaveBeenCalledWith(2);
            expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(null);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not commit held paged navigation before the target canvas is finalized', async () => {
        const {
            currentPage,
            emitCurrentPage,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [1],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(1);
        expect(emitCurrentPage).not.toHaveBeenCalledWith(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        markPageCanvasReady(2);
        markPageVisualReady(2);
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('commits held paged navigation when the target canvas is finalized after mounting', async () => {
        const {
            currentPage,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [1],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        markPageCanvasReady(2);
        markPageVisualReady(2);
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('does not use the programmatic settle timer to commit a target without a final canvas', async () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                markPageCanvasReady,
                markPageVisualReady,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(currentPage.value).toBe(1);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);

            vi.advanceTimersByTime(800);

            expect(currentPage.value).toBe(1);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

            markPageCanvasReady(2);
            markPageVisualReady(2);
            singlePageScroll.releasePagedNavigationHoldForPage(2);

            expect(currentPage.value).toBe(2);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('forces a recovery render when a suppressed paged target stalls', async () => {
        vi.useFakeTimers();
        try {
            const {
                renderVisiblePages,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            await nextTick();
            renderVisiblePages.mockClear();

            await vi.advanceTimersByTimeAsync(1_400);
            await nextTick();

            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 2,
                    end: 2,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                    preserveInFlightRequiredPages: true,
                },
            );
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('abandons a stale paged target after the recovery timeout', async () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                emitNavigationFeedbackPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(emitNavigationFeedbackPage).toHaveBeenCalledWith(2);

            await vi.advanceTimersByTimeAsync(6_000);
            await nextTick();

            expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(currentPage.value).toBe(2);
            expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(null);
        } finally {
            vi.useRealTimers();
        }
    });

    it('abandons a stale paged target without publishing it when visibility still reports the previous page', async () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                emitCurrentPage,
                emitNavigationFeedbackPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
                getMostVisiblePage: () => 1,
            });

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

            await vi.advanceTimersByTimeAsync(6_000);
            await nextTick();

            expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(currentPage.value).toBe(1);
            expect(emitCurrentPage).not.toHaveBeenCalledWith(2);
            expect(emitNavigationFeedbackPage).toHaveBeenLastCalledWith(null);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not commit paged navigation when the target canvas exists before render finalization', async () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [1],
            canvasReadyPageNumbers: [
                1,
                2,
            ],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
    });

    it('does not commit paged navigation while the target skeleton still covers a canvas', async () => {
        const {
            currentPage,
            hidePageSkeleton,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
            skeletonPageNumbers: [2],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

        hidePageSkeleton(2);
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('commits paged navigation when a hidden skeleton node remains after render finalization', async () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
            hiddenSkeletonPageNumbers: [2],
            skeletonPageNumbers: [2],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
    });

    it('does not commit paged navigation from a stale rendered target canvas', async () => {
        const {
            currentPage,
            markPageFreshRendered,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            suppressPagedRowRender: () => true,
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [1],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

        markPageFreshRendered(2);
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
    });

    it('waits for every page in a facing row before committing paged navigation', async () => {
        const {
            currentPage,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            suppressPagedRowRender: () => true,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
            ],
            mountedPageNumbers: [
                1,
                2,
                3,
                4,
            ],
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(1);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        markPageCanvasReady(3);
        markPageVisualReady(3);
        singlePageScroll.releasePagedNavigationHoldForPage(3);

        expect(currentPage.value).toBe(2);
    });

    it('holds same-row facing navigation until the target page is visually ready', async () => {
        const {
            currentPage,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({
            viewMode: 'facing-first-single',
            suppressPagedRowRender: () => true,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
            ],
            mountedPageNumbers: [
                1,
                2,
                3,
            ],
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [
                1,
                2,
            ],
        });
        currentPage.value = 2;
        visibleRange.value = {
            start: 2,
            end: 3,
        };

        singlePageScroll.scrollToPage(3);
        await nextTick();

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
    });

    it('keeps the commit hold after paged navigation settle and stall timers fire', () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);

            vi.advanceTimersByTime(800);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(currentPage.value).toBe(1);

            vi.advanceTimersByTime(3_200);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(currentPage.value).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('replaces the held target row when the next paged navigation starts', () => {
        vi.useFakeTimers();
        try {
            const {singlePageScroll} = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

            singlePageScroll.scrollToPage(3);

            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
            expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears the commit hold when programmatic navigation is cancelled', () => {
        vi.useFakeTimers();
        try {
            const {singlePageScroll} = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

            singlePageScroll.cancelProgrammaticNavigation();

            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('releases an active hold without marking expiry when the target paints in time', () => {
        vi.useFakeTimers();
        try {
            const {
                markPageCanvasReady,
                markPageVisualReady,
                singlePageScroll,
            } = createSinglePageScrollHarness({
                suppressPagedRowRender: () => true,
                visuallyReadyPageNumbers: [1],
            });

            singlePageScroll.scrollToPage(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);

            markPageCanvasReady(2);
            markPageVisualReady(2);
            singlePageScroll.releasePagedNavigationHoldForPage(2);

            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(false);
            vi.advanceTimersByTime(700);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('scrollToPage in single-page mode keeps tall pages centered (which clamps to top edge)', () => {
        // Tall page: pageHeight (200) > containerHeight (100). centerOffset =
        // max(0, (100 − 200)/2) = 0, so 'center' degenerates to topTarget =
        // baseTop = 140 − 20 = 120. Verifies the anchor logic doesn't break
        // tall-page navigation.
        const {
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            continuousScroll: false,
            clientHeight: 100,
            scrollHeight: 580,
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 200,
                },
                {
                    offsetTop: 360,
                    offsetHeight: 200,
                },
            ],
        });

        singlePageScroll.scrollToPage(2);

        expect(container.scrollTop).toBe(120);
    });
});
