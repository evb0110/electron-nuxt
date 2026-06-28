import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IPageRange,
    PDFDocumentProxy,
} from '@app/types/pdf';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const SCROLL_DELTA_EPSILON = 0.01;
const FAST_VELOCITY_PX_PER_MS = 1;
const VERY_FAST_VELOCITY_PX_PER_MS = 3;
const MIN_PAGES_AHEAD = 1;
const MAX_PAGES_AHEAD = 3;

interface IPageRenderWindow {
    start: number;
    end: number;
}

interface IContinuousScrollWarmState {
    framePending: boolean;
    lastScrollTop: number | null;
    lastTimestampMs: number | null;
    renderWindow: IPageRenderWindow | null;
}

interface IContinuousScrollWarmSchedulerSource {
    currentPage: Ref<number>;
    numPages: Ref<number>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    visibleRange: Ref<IPageRange>;
    renderVisiblePages: (
        range: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
}

interface IContinuousScrollWarmSchedulerControls {
    isDisposed: () => boolean;
    isProgrammaticNavigationActive: () => boolean;
    getSnapSuppressUntil: () => number;
    scheduleFrame: (callback: () => void) => void;
    runGuardedTask: (
        task: () => Promise<void>,
        options: {
            scope: string;
            message: string;
        },
    ) => void;
}

export function createContinuousScrollWarmScheduler(
    source: IContinuousScrollWarmSchedulerSource,
    controls: IContinuousScrollWarmSchedulerControls,
) {
    const state: IContinuousScrollWarmState = {
        framePending: false,
        lastScrollTop: null,
        lastTimestampMs: null,
        renderWindow: null,
    };

    function getPagesAhead(velocityPxPerMs: number) {
        if (velocityPxPerMs >= VERY_FAST_VELOCITY_PX_PER_MS) {
            return MAX_PAGES_AHEAD;
        }
        if (velocityPxPerMs >= FAST_VELOCITY_PX_PER_MS) {
            return MIN_PAGES_AHEAD + 1;
        }
        return MIN_PAGES_AHEAD;
    }

    function resolveRenderWindow(
        direction: -1 | 1,
        velocityPxPerMs: number,
    ): IPageRenderWindow | null {
        if (source.numPages.value <= 0) {
            return null;
        }

        const pagesAhead = getPagesAhead(velocityPxPerMs);
        if (direction > 0) {
            return {
                start: source.visibleRange.value.start,
                end: Math.min(source.numPages.value, source.visibleRange.value.end + pagesAhead),
            };
        }

        return {
            start: Math.max(1, source.visibleRange.value.start - pagesAhead),
            end: source.visibleRange.value.end,
        };
    }

    function runWarmRender() {
        state.framePending = false;
        const renderWindow = state.renderWindow;
        state.renderWindow = null;

        if (
            controls.isDisposed()
            || !renderWindow
            || !source.continuousScroll.value
            || source.isLoading.value
            || !source.pdfDocument.value
            || controls.isProgrammaticNavigationActive()
            || Date.now() < controls.getSnapSuppressUntil()
        ) {
            return;
        }

        const range = {
            start: source.visibleRange.value.start,
            end: source.visibleRange.value.end,
        };
        if (
            renderWindow.start >= range.start
            && renderWindow.end <= range.end
        ) {
            return;
        }

        logPdfRenderTrace('single-page-continuous-scroll-warm-render-run', {
            currentPage: source.currentPage.value,
            visibleRange: range,
            renderWindow,
        });
        controls.runGuardedTask(() => source.renderVisiblePages(
            range,
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                renderWindowOverride: renderWindow,
                preserveInFlightRequiredPages: true,
            },
        ), {
            scope: 'pdf-single-page-scroll',
            message: 'Failed to warm PDF pages during continuous scroll',
        });
    }

    function schedule(renderWindow: IPageRenderWindow) {
        state.renderWindow = renderWindow;
        if (state.framePending) {
            return;
        }

        state.framePending = true;
        controls.scheduleFrame(runWarmRender);
    }

    function track(container: HTMLElement | null) {
        if (
            !source.continuousScroll.value
            || !container
            || source.isLoading.value
            || !source.pdfDocument.value
            || controls.isProgrammaticNavigationActive()
            || Date.now() < controls.getSnapSuppressUntil()
        ) {
            state.lastScrollTop = container?.scrollTop ?? null;
            state.lastTimestampMs = Date.now();
            return;
        }

        const now = Date.now();
        const scrollTop = container.scrollTop;
        const previousScrollTop = state.lastScrollTop;
        const previousTimestampMs = state.lastTimestampMs;
        state.lastScrollTop = scrollTop;
        state.lastTimestampMs = now;

        if (previousScrollTop === null || previousTimestampMs === null) {
            return;
        }

        const delta = scrollTop - previousScrollTop;
        if (Math.abs(delta) <= SCROLL_DELTA_EPSILON) {
            return;
        }

        const elapsedMs = Math.max(1, now - previousTimestampMs);
        const direction = delta > 0 ? 1 : -1;
        const velocityPxPerMs = Math.abs(delta) / elapsedMs;
        const renderWindow = resolveRenderWindow(direction, velocityPxPerMs);
        if (!renderWindow) {
            return;
        }

        logPdfRenderTrace('single-page-continuous-scroll-warm-render-scheduled', {
            currentPage: source.currentPage.value,
            visibleRange: {
                start: source.visibleRange.value.start,
                end: source.visibleRange.value.end,
            },
            renderWindow,
            direction,
            velocityPxPerMs,
        });
        schedule(renderWindow);
    }

    function reset() {
        state.framePending = false;
        state.lastScrollTop = null;
        state.lastTimestampMs = null;
        state.renderWindow = null;
    }

    return {
        reset,
        track,
    };
}
