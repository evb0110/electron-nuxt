
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

describe('usePdfSinglePageScroll paging and visual readiness', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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
            scrollToPageInternal,
            singlePageScroll,
            visibleRange,
        } = createSinglePageScrollHarness({ mountedPageNumbers });

        const didScroll = singlePageScroll.scrollToPage(2, {
            preferExactDom: true,
            suppressRenderAfterSnap: true,
        });
        await nextTick();

        expect(didScroll).toBe(true);
        expect(currentPage.value).toBe(2);
        expect(visibleRange.value).toEqual({
            start: 2,
            end: 2,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(scrollToPageInternal).not.toHaveBeenCalled();
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
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(1);
    });

    it('renders the authoritative paged target when the target page is not mounted yet', async () => {
        const {
            renderVisiblePages,
            singlePageScroll,
        } = createSinglePageScrollHarness({mountedPageNumbers: []});

        singlePageScroll.scrollToPage(2);
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

    it('primes an unmounted paged target row before visual readiness', async () => {
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

        expect(currentPage.value).toBe(2);
        expect(visibleRange.value).toEqual({
            start: 2,
            end: 3,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
        expect(scrollToPageInternal).toHaveBeenCalledWith(
            expect.anything(),
            2,
            3,
            20,
            undefined,
        );

        await nextTick();
        expect(scrollToPageInternal).toHaveBeenCalledTimes(1);
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

        expect(currentPage.value).toBe(2);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
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

    it('keeps the latest exact destination options when re-snapping an active paged target', async () => {
        const {
            container,
            markPageCanvasReady,
            markPageVisualReady,
            singlePageScroll,
        } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

        singlePageScroll.scrollToPage(2, { pageYRatio: 0.1 });
        await nextTick();

        expect(container.scrollTop).toBe(138);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        singlePageScroll.scrollToPage(2, { pageYRatio: 0.4 });

        expect(container.scrollTop).toBe(192);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        markPageCanvasReady(2);
        markPageVisualReady(2);
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(container.scrollTop).toBe(192);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBeNull();
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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(currentPage.value).toBe(2);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(emitNavigationFeedbackPage).toHaveBeenCalledWith(2);

            vi.advanceTimersByTime(119);

            markPageCanvasReady(2);
            markPageVisualReady(2);

            expect(currentPage.value).toBe(2);
            expect(emitCurrentPage).toHaveBeenCalledWith(2);

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
        } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(2);
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
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
        } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);

        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

            singlePageScroll.scrollToPage(2);
            await nextTick();

            expect(currentPage.value).toBe(2);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);

            vi.advanceTimersByTime(800);

            expect(currentPage.value).toBe(2);
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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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

    it('abandons a stale paged target back to viewport authority when visibility still reports the previous page', async () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                emitCurrentPage,
                emitNavigationFeedbackPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({
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
            expect(emitCurrentPage).toHaveBeenCalledWith(2);
            expect(emitCurrentPage).toHaveBeenLastCalledWith(1);
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
            visuallyReadyPageNumbers: [1],
            canvasReadyPageNumbers: [
                1,
                2,
            ],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();
        singlePageScroll.releasePagedNavigationHoldForPage(2);

        expect(currentPage.value).toBe(2);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
        expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
    });

    it('does not commit paged navigation while the target skeleton still covers a canvas', async () => {
        const {
            currentPage,
            hidePageSkeleton,
            singlePageScroll,
        } = createSinglePageScrollHarness({
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

        expect(currentPage.value).toBe(2);
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
            visuallyReadyPageNumbers: [
                1,
                2,
            ],
            freshRenderedPageNumbers: [1],
        });

        singlePageScroll.scrollToPage(2);
        await nextTick();

        expect(currentPage.value).toBe(2);
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

        expect(currentPage.value).toBe(2);
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

        expect(currentPage.value).toBe(3);
        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(singlePageScroll.isNavigationHoldActiveForPage(3)).toBe(true);
    });

    it('keeps the commit hold after paged navigation settle and stall timers fire', () => {
        vi.useFakeTimers();
        try {
            const {
                currentPage,
                singlePageScroll,
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

            singlePageScroll.scrollToPage(2);

            vi.advanceTimersByTime(800);
            expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(currentPage.value).toBe(2);

            vi.advanceTimersByTime(3_200);
            expect(singlePageScroll.isNavigationHoldActiveForPage(2)).toBe(true);
            expect(singlePageScroll.isNavigationHoldExpiredPage(2)).toBe(false);
            expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(2);
            expect(currentPage.value).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('replaces the held target row when the next paged navigation starts', () => {
        vi.useFakeTimers();
        try {
            const {singlePageScroll} = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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
            const {singlePageScroll} = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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
            } = createSinglePageScrollHarness({visuallyReadyPageNumbers: [1]});

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
