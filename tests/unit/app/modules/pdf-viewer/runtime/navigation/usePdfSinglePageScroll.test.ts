import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import {
    createSinglePageNavigationControllerHarness,
    createSinglePageScrollHarness,
} from '@tests/unit/app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScrollFixture';
import { accumulateWheelForPageFlips } from '@app/utils/document-viewer/single-page-wheel/accumulateWheelForPageFlips';
import { resolveWheelPageFlipStepDelta } from '@app/utils/document-viewer/single-page-wheel/resolveWheelPageFlipStepDelta';
import { resolveSnapAnchorForWheelDirection } from '@app/utils/document-viewer/single-page-wheel/resolveSnapAnchorForWheelDirection';
import type { TWheelDirection } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

describe('usePdfSinglePageNavigationController', () => {
    it('starts a new navigation when requested page changes away from the active target', async () => {
        const {
            cancelPendingSearchScroll,
            container,
            requestedCurrentPage,
            singlePageScroll,
        } = createSinglePageNavigationControllerHarness();

        singlePageScroll.scrollToPage(3);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(container.scrollTop).toBeGreaterThan(100);

        requestedCurrentPage.value = 1;
        await nextTick();

        expect(cancelPendingSearchScroll).toHaveBeenCalledOnce();
        expect(container.scrollTop).toBeLessThan(100);
        expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
    });

    it('reissues a same-page request after canceling a stale visual target', async () => {
        const {
            cancelPendingSearchScroll,
            container,
            currentPage,
            requestedCurrentPage,
            singlePageScroll,
        } = createSinglePageNavigationControllerHarness();

        singlePageScroll.scrollToPage(3);

        expect(singlePageScroll.pagedNavigationTargetPage.value).toBe(3);
        expect(container.scrollTop).toBeGreaterThan(100);

        currentPage.value = 1;
        requestedCurrentPage.value = 1;
        await nextTick();

        expect(cancelPendingSearchScroll).toHaveBeenCalledOnce();
        expect(container.scrollTop).toBeLessThan(100);
        expect(singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
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

    it('reverts stale viewport page updates while snap suppression still owns continuous scroll', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            let currentPageRef: Ref<number> | null = null;
            const harness = createSinglePageScrollHarness({
                continuousScroll: true,
                getMostVisiblePage: () => 1,
                updateCurrentPage: (viewer) => {
                    const page = viewer ? 1 : 3;
                    currentPageRef!.value = page;
                    return page;
                },
            });
            currentPageRef = harness.currentPage;
            const {
                container,
                currentPage,
                emitCurrentPage,
                scrollToPageInternal,
                singlePageScroll,
            } = harness;

            currentPage.value = 3;
            singlePageScroll.suppressSnapFor(100);
            singlePageScroll.isProgrammaticNavigationActive.value = false;

            singlePageScroll.handleScroll();

            expect(currentPage.value).toBe(3);
            expect(emitCurrentPage).not.toHaveBeenCalled();
            expect(scrollToPageInternal).toHaveBeenCalledWith(
                container,
                3,
                3,
                20,
                undefined,
            );
        } finally {
            vi.useRealTimers();
        }
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
