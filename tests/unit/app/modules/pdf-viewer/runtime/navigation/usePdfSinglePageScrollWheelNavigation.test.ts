import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import {
    createSinglePageScrollHarness,
    createWheelEvent,
} from '@tests/unit/app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScrollFixture';
import { cast } from '@tests/helpers/cast';

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

        expect(currentPage.value).toBe(3);
        expect(emitCurrentPage).toHaveBeenCalledWith(3);
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
        });

        singlePageScroll.scrollToPage(3);
        await nextTick();
        expect(currentPage.value).toBe(3);
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
        } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [
            1,
            2,
        ]});

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

    it('reveals a mounted paged search target while keeping the target authoritative', async () => {
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
        expect(currentPage.value).toBe(3);
        expect(emitCurrentPage).toHaveBeenCalledWith(3);
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
        expect(currentPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
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

    it('coalesces page-ahead warming on the next animation frame while keeping debounced scroll render', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const frameCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = (callback: FrameRequestCallback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        };
        vi.stubGlobal('window', { requestAnimationFrame });
        try {
            const {
                container,
                renderVisiblePages,
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
                    {
                        offsetTop: 380,
                        offsetHeight: 100,
                    },
                    {
                        offsetTop: 500,
                        offsetHeight: 100,
                    },
                    {
                        offsetTop: 620,
                        offsetHeight: 100,
                    },
                ],
                clientHeight: 100,
                scrollHeight: 740,
                getMostVisiblePage: viewer => {
                    const top = viewer?.scrollTop ?? 0;
                    if (top >= 500) {
                        return 5;
                    }
                    if (top >= 380) {
                        return 4;
                    }
                    if (top >= 260) {
                        return 3;
                    }
                    if (top >= 140) {
                        return 2;
                    }
                    return 1;
                },
                updateVisibleRange: (viewer, _pageCount, range) => {
                    const page = viewer
                        ? Math.max(1, Math.floor((viewer.scrollTop + 20) / 120) + 1)
                        : 1;
                    range.value = {
                        start: page,
                        end: page,
                    };
                },
            });

            container.scrollTop = 0;
            singlePageScroll.handleScroll();

            vi.setSystemTime(1_016);
            container.scrollTop = 140;
            singlePageScroll.handleScroll();

            expect(renderVisiblePages).not.toHaveBeenCalled();
            expect(frameCallbacks).toHaveLength(1);

            vi.setSystemTime(1_032);
            container.scrollTop = 260;
            singlePageScroll.handleScroll();

            expect(frameCallbacks).toHaveLength(1);

            frameCallbacks[0]?.(16);
            await Promise.resolve();

            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                    renderWindowOverride: {
                        start: 3,
                        end: 6,
                    },
                    preserveInFlightRequiredPages: true,
                },
            );

            vi.advanceTimersByTime(100);
            await Promise.resolve();

            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                { preserveRenderedPages: true },
            );
        } finally {
            vi.unstubAllGlobals();
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

    it('primes the continuous destination before target row metric hydration settles', async () => {
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
            expect(scrollToPageInternal).toHaveBeenCalledTimes(1);

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
                .toBeLessThan(renderVisiblePages.mock.invocationCallOrder[0]!);
            expect(scrollToPageInternal.mock.invocationCallOrder.at(-1))
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
            expect(scrollToPageInternal).toHaveBeenCalledTimes(3);

            container.scrollTop = 0;
            singlePageScroll.handleScroll();
            await nextTick();
            await Promise.resolve();

            expect(scrollToPageInternal).toHaveBeenCalledTimes(4);
            expect(scrollToPageInternal.mock.calls[3]?.[1]).toBe(2);
            expect(scrollToPageInternal.mock.calls[3]?.[4]).toEqual({pageYRatio: 0});
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
});
