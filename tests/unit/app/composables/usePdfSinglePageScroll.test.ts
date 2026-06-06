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
import type { PDFDocumentProxy } from '@app/types/pdf';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import { accumulateWheelForPageFlips } from '@app/utils/pdf-viewer/single-page-wheel/accumulateWheelForPageFlips';
import { resolveWheelPageFlipStepDelta } from '@app/utils/pdf-viewer/single-page-wheel/resolveWheelPageFlipStepDelta';
import { resolveSnapAnchorForWheelDirection } from '@app/utils/pdf-viewer/single-page-wheel/resolveSnapAnchorForWheelDirection';
import type { TWheelDirection } from '@app/utils/pdf-viewer/single-page-wheel/singlePageWheelTypes';
import type { TPdfViewMode } from '@contracts/shared';
import { cast } from '@tests/helpers/cast';

interface ITestPageGeometry {
    offsetTop: number;
    offsetHeight: number;
}

interface IScrollHarnessOptions {
    viewMode?: TPdfViewMode;
    pageGeometries?: ITestPageGeometry[];
    mountedPageNumbers?: number[];
    getMostVisiblePage?: (viewer: HTMLElement | null) => number;
    clientHeight?: number;
    scrollHeight?: number;
    continuousScroll?: boolean;
    suppressPagedRowRender?: () => boolean;
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
    const scrollHeight = options?.scrollHeight ?? 440;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    let scrollTop = 0;
    const mountedPageNumbers = options?.mountedPageNumbers
        ?? pageGeometries.map((_, index) => index + 1);
    const pageElements = pageGeometries.map((page, index) => cast<HTMLElement>({
        ...page,
        dataset: {page: String(mountedPageNumbers[index] ?? index + 1)},
    }));
    const container = cast<HTMLElement>({
        clientHeight,
        scrollHeight,
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

    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const scrollToPageInternal = vi.fn();
    const renderVisiblePages = vi.fn(async () => {});
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });

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

    const singlePageScroll = usePdfSinglePageScroll({
        viewerContainer: ref(container),
        numPages: ref(pageGeometries.length),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref(options?.viewMode ?? 'single'),
        continuousScroll: ref(options?.continuousScroll ?? false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage,
        scrollToPageInternal,
        updateVisibleRange: vi.fn(),
        updateCurrentPage: vi.fn((viewer: HTMLElement | null) => getMostVisiblePage(viewer)),
        renderVisiblePages,
        suppressPagedRowRender: options?.suppressPagedRowRender,
        visibleRange,
        emitCurrentPage,
    });

    return {
        container,
        currentPage,
        emitCurrentPage,
        renderVisiblePages,
        visibleRange,
        scrollToPageInternal,
        singlePageScroll,
    };
}

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

        singlePageScroll.handleWheel(createWheelEvent(120, 10, 150));
        expect(currentPage.value).toBe(2);
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

    it('skips stale queued paged row renders after a newer navigation wins', async () => {
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
            },
        );
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

    it('lets fit-current navigation suppress the queued paged row render', async () => {
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
        expect(renderVisiblePages).not.toHaveBeenCalled();
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

    it('makes an unmounted paged target row authoritative before the deferred DOM snap', async () => {
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
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
        expect(scrollToPageInternal).not.toHaveBeenCalled();

        await nextTick();
        expect(scrollToPageInternal).not.toHaveBeenCalled();
    });

    it('keeps a paged navigation target authoritative while stale scroll events settle', () => {
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
            start: 2,
            end: 3,
        });
        expect(emitCurrentPage).toHaveBeenCalledWith(2);
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
