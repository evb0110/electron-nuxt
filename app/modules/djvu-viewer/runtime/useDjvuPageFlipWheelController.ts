import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import { stepBySpread } from '@app/utils/pdfViewMode';
import { accumulateWheelForPageFlips } from '@app/utils/document-viewer/single-page-wheel/accumulateWheelForPageFlips';
import { createWheelPageAccumulatorState } from '@app/utils/document-viewer/single-page-wheel/createWheelPageAccumulatorState';
import type { IWheelPageAccumulatorState } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';
import { normalizePageWheelDelta } from '@app/utils/document-viewer/single-page-wheel/normalizePageWheelDelta';
import { resolveWheelPageFlipStepDelta } from '@app/utils/document-viewer/single-page-wheel/resolveWheelPageFlipStepDelta';

const WHEEL_DELTA_EPSILON = 0.01;
const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;

interface IUseDjvuPageFlipWheelControllerOptions {
    currentPage: Ref<number>;
    isActive: ComputedRef<boolean>;
    isContinuousScroll: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    scrollToPage: (pageNumber: number) => void;
    totalPages: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewerContainer: Ref<HTMLElement | null>;
}

export const useDjvuPageFlipWheelController = (options: IUseDjvuPageFlipWheelControllerOptions) => {
    let wheelAccumulator: IWheelPageAccumulatorState = createWheelPageAccumulatorState();

    function clearWheelAccumulator() {
        wheelAccumulator = createWheelPageAccumulatorState();
    }

    function shouldIgnorePageFlipWheel(event: WheelEvent) {
        return (
            options.isContinuousScroll.value
            || options.isLoading.value
            || options.totalPages.value <= 0
            || event.ctrlKey
            || event.metaKey
        );
    }

    function hasHorizontalWheelIntent(event: WheelEvent) {
        return Math.abs(event.deltaX) > Math.abs(event.deltaY) * HORIZONTAL_INTENT_REJECT_RATIO;
    }

    function canScrollCurrentSpread(
        container: HTMLElement,
        direction: -1 | 1,
        maxScrollTop: number,
    ) {
        return maxScrollTop > PAGE_SCROLL_EDGE_EPSILON
            && (
                direction > 0
                    ? container.scrollTop < maxScrollTop - PAGE_SCROLL_EDGE_EPSILON
                    : container.scrollTop > PAGE_SCROLL_EDGE_EPSILON
            );
    }

    function scrollCurrentSpreadByWheelDelta(
        container: HTMLElement,
        delta: number,
        direction: -1 | 1,
        maxScrollTop: number,
    ) {
        clearWheelAccumulator();
        container.scrollTop = direction > 0
            ? Math.min(maxScrollTop, container.scrollTop + delta)
            : Math.max(0, container.scrollTop + delta);
    }

    function resolvePageFlipWheelStep(event: WheelEvent, delta: number, direction: -1 | 1) {
        const accumulationResult = accumulateWheelForPageFlips({
            state: wheelAccumulator,
            delta,
            direction,
            eventTimeMs: event.timeStamp,
            stepDelta: resolveWheelPageFlipStepDelta(event, delta),
            maxSteps: 1,
        });
        wheelAccumulator = accumulationResult.state;
        return accumulationResult.stepsToFlip;
    }

    function flipPageFromWheel(direction: -1 | 1) {
        const targetPage = stepBySpread(
            options.currentPage.value,
            options.viewMode.value,
            options.totalPages.value,
            direction,
            1,
        );
        if (targetPage === options.currentPage.value) {
            clearWheelAccumulator();
            return;
        }

        options.scrollToPage(targetPage);
    }

    function resolvePageFlipWheelContext(event: WheelEvent) {
        if (shouldIgnorePageFlipWheel(event) || hasHorizontalWheelIntent(event)) {
            return null;
        }

        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }

        const delta = normalizePageWheelDelta(event.deltaY, event.deltaMode, container);
        if (Math.abs(delta) < WHEEL_DELTA_EPSILON) {
            return null;
        }

        const direction: -1 | 1 = delta > 0 ? 1 : -1;
        return {
            container,
            delta,
            direction,
            maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
        };
    }

    function handleViewerWheel(event: WheelEvent) {
        if (!options.isActive.value) {
            return;
        }
        const context = resolvePageFlipWheelContext(event);
        if (!context) {
            return;
        }
        event.preventDefault();

        if (canScrollCurrentSpread(context.container, context.direction, context.maxScrollTop)) {
            scrollCurrentSpreadByWheelDelta(
                context.container,
                context.delta,
                context.direction,
                context.maxScrollTop,
            );
            return;
        }

        if (resolvePageFlipWheelStep(event, context.delta, context.direction) === 0) {
            return;
        }

        flipPageFromWheel(context.direction);
    }

    return {
        clearWheelAccumulator,
        handleViewerWheel,
    };
};
