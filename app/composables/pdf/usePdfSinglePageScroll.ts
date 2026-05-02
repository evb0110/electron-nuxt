import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    tryOnScopeDispose,
    useDebounceFn,
} from '@vueuse/core';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';
import { runGuardedTask } from '@app/utils/async-guard';
import { stepBySpread } from '@app/utils/pdf-view-mode';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import {
    getPageContainerByNumber,
    getPageScrollBounds as getPageScrollBoundsForContainer,
} from '@app/composables/pdf/pdfScrollVisibility';

const WHEEL_LINE_DELTA_PX = 16;
const PAGE_FLIP_STEP_DELTA_PX = 120;
const MIN_COARSE_PAGE_FLIP_STEP_DELTA_PX = 40;
const WHEEL_IDLE_RESET_MS = 140;
const MAX_PAGE_FLIPS_PER_EVENT = 3;
const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;
const WHEEL_DELTA_EPSILON = 0.01;
// Minimum gap between consecutive same-direction page flips driven by the
// wheel handler. Prevents trackpad inertia from blasting through pages — one
// swipe gesture should advance one page, matching Adobe Acrobat / Preview.
// Bypassed on direction reversal and when tall-page interior scrolling has
// happened since the last flip (so reaching the edge of a tall page still
// flips on the next wheel tick).
const SAME_DIRECTION_FLIP_COOLDOWN_MS = 180;

export type TPageSnapAnchor = 'center' | 'top' | 'bottom';
export type TWheelDirection = -1 | 1;

interface IPageScrollBounds {
    min: number;
    max: number;
}

export interface IWheelPageAccumulatorState {
    delta: number;
    direction: TWheelDirection | 0;
    lastEventTimeMs: number;
}

export function createWheelPageAccumulatorState(): IWheelPageAccumulatorState {
    return {
        delta: 0,
        direction: 0,
        lastEventTimeMs: 0,
    };
}

export function normalizePageWheelDelta(
    delta: number,
    mode: number,
    container: HTMLElement,
) {
    if (mode === 1) {
        return delta * WHEEL_LINE_DELTA_PX;
    }
    if (mode === 2) {
        return delta * container.clientHeight;
    }
    return delta;
}

interface IWheelPageAccumulatorResult {
    stepsToFlip: number;
    state: IWheelPageAccumulatorState;
}

interface IAccumulateWheelForPageFlipsInput {
    state: IWheelPageAccumulatorState;
    delta: number;
    direction: TWheelDirection;
    eventTimeMs: number;
    stepDelta: number;
    maxSteps?: number;
}

export function resolveSnapAnchorForWheelDirection(
    direction: TWheelDirection,
): TPageSnapAnchor {
    return direction > 0 ? 'top' : 'bottom';
}

export function accumulateWheelForPageFlips(
    input: IAccumulateWheelForPageFlipsInput,
): IWheelPageAccumulatorResult {
    const {
        delta,
        direction,
        eventTimeMs,
        stepDelta,
    } = input;

    let accumulatedDelta = input.state.delta;
    const isDirectionChanged =
        input.state.direction !== 0 && input.state.direction !== direction;
    const isStale =
        input.state.lastEventTimeMs > 0 &&
        eventTimeMs - input.state.lastEventTimeMs > WHEEL_IDLE_RESET_MS;

    if (isDirectionChanged || isStale) {
        accumulatedDelta = 0;
    }

    accumulatedDelta += delta;

    const safeStepDelta = Math.max(stepDelta, WHEEL_DELTA_EPSILON);
    const rawSteps = Math.floor(Math.abs(accumulatedDelta) / safeStepDelta);
    const stepsToFlip = Math.min(rawSteps, input.maxSteps ?? MAX_PAGE_FLIPS_PER_EVENT);
    const consumedDelta = direction * stepsToFlip * safeStepDelta;

    return {
        stepsToFlip,
        state: {
            delta: accumulatedDelta - consumedDelta,
            direction,
            lastEventTimeMs: eventTimeMs,
        },
    };
}

export function resolveWheelPageFlipStepDelta(
    event: Pick<WheelEvent, 'deltaMode'>,
    normalizedDelta: number,
) {
    const magnitude = Math.abs(normalizedDelta);
    if (magnitude < WHEEL_DELTA_EPSILON) {
        return PAGE_FLIP_STEP_DELTA_PX;
    }

    if (event.deltaMode === 1 || event.deltaMode === 2) {
        // Line/page deltas are already wheel-step-oriented; treat each event
        // as one meaningful edge-flip step.
        return magnitude;
    }

    return Math.max(
        MIN_COARSE_PAGE_FLIP_STEP_DELTA_PX,
        Math.min(PAGE_FLIP_STEP_DELTA_PX, magnitude),
    );
}

function shouldHandleSinglePageWheel(
    event: WheelEvent,
    container: HTMLElement | null,
    hasPdfDocument: boolean,
    isContinuousScroll: boolean,
    isPdfLoading: boolean,
    pageCount: number,
) {
    if (
        isContinuousScroll ||
        isPdfLoading ||
        !hasPdfDocument ||
        !container ||
        pageCount === 0 ||
        event.ctrlKey ||
        event.metaKey
    ) {
        return false;
    }

    if (event.deltaY === 0) {
        return false;
    }

    return Math.abs(event.deltaX)
        <= Math.abs(event.deltaY) * HORIZONTAL_INTENT_REJECT_RATIO;
}

function resolveWheelDirection(delta: number): TWheelDirection {
    return delta > 0 ? 1 : -1;
}

function canScrollWithinPageBounds(
    container: HTMLElement,
    bounds: IPageScrollBounds,
    direction: TWheelDirection,
) {
    return direction > 0
        ? container.scrollTop < bounds.max - PAGE_SCROLL_EDGE_EPSILON
        : container.scrollTop > bounds.min + PAGE_SCROLL_EDGE_EPSILON;
}

function resolveNextTopWithinPageBounds(
    container: HTMLElement,
    bounds: IPageScrollBounds,
    delta: number,
    direction: TWheelDirection,
) {
    return direction > 0
        ? Math.min(bounds.max, container.scrollTop + delta)
        : Math.max(bounds.min, container.scrollTop + delta);
}

function isInSameDirectionFlipCooldown(
    eventTimeMs: number,
    direction: TWheelDirection,
    lastFlipAtMs: number,
    lastFlipDirection: TWheelDirection | 0,
    hasInteriorScrollSinceLastFlip: boolean,
) {
    const sinceLastFlipMs = eventTimeMs - lastFlipAtMs;
    return (
        lastFlipAtMs > 0
        && lastFlipDirection === direction
        && !hasInteriorScrollSinceLastFlip
        && sinceLastFlipMs >= 0
        && sinceLastFlipMs < SAME_DIRECTION_FLIP_COOLDOWN_MS
    );
}

function resolveWheelTargetPage(
    activePage: number,
    viewMode: TPdfViewMode,
    pageCount: number,
    direction: TWheelDirection,
) {
    // Keep paged scrolling predictable: one spread turn per wheel threshold.
    return stepBySpread(
        activePage,
        viewMode,
        pageCount,
        direction,
        1,
    );
}

function resolveWheelTargetAnchor(
    targetPageIsTall: boolean,
    direction: TWheelDirection,
): TPageSnapAnchor {
    return targetPageIsTall
        ? resolveSnapAnchorForWheelDirection(direction)
        : 'top';
}

interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    scaledMargin: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    scrollToPageInternal: (
        container: HTMLElement,
        page: number,
        total: number,
        margin: number,
        options?: {preferExactDom?: boolean;},
    ) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    renderVisiblePages: (range: {
        start: number;
        end: number
    }) => Promise<void>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    emitCurrentPage: (page: number) => void;
}

export const usePdfSinglePageScroll = (
    options: IUsePdfSinglePageScrollOptions,
) => {
    const {
        viewerContainer,
        numPages,
        currentPage,
        scaledMargin,
        viewMode,
        continuousScroll,
        isLoading,
        pdfDocument,
        getMostVisiblePage,
        scrollToPageInternal,
        updateVisibleRange,
        updateCurrentPage,
        renderVisiblePages,
        visibleRange,
        emitCurrentPage,
    } = options;

    const isSnapping = ref(false);
    const snapSuppressUntil = ref(0);
    const isProgrammaticNavigationActive = ref(false);
    const searchNavigationTargetPage = ref<number | null>(null);
    const searchNavigationState = ref<'idle' | 'navigating' | 'settling'>('idle');
    const isSearchNavigationLocked = computed(
        () => searchNavigationState.value !== 'idle',
    );
    let searchNavigationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    function clearSearchNavigationSettleTimer() {
        if (searchNavigationSettleTimer !== null) {
            clearTimeout(searchNavigationSettleTimer);
            searchNavigationSettleTimer = null;
        }
    }

    function markProgrammaticNavigation(ms: number) {
        const now = Date.now();
        snapSuppressUntil.value = Math.max(snapSuppressUntil.value, now + ms);
        isProgrammaticNavigationActive.value = true;
    }

    function maybeReleaseProgrammaticNavigation() {
        if (
            searchNavigationState.value === 'idle'
            && Date.now() >= snapSuppressUntil.value
        ) {
            isProgrammaticNavigationActive.value = false;
        }
    }

    function suppressSnapFor(ms: number) {
        markProgrammaticNavigation(ms);
    }

    function beginSearchNavigation(pageNumber: number, holdMs = 400) {
        clearSearchNavigationSettleTimer();
        if (numPages.value > 0) {
            searchNavigationTargetPage.value = Math.max(
                1,
                Math.min(pageNumber, numPages.value),
            );
        } else {
            searchNavigationTargetPage.value = pageNumber;
        }
        searchNavigationState.value = 'navigating';
        markProgrammaticNavigation(Math.max(100, holdMs));
    }

    function endSearchNavigation(settleMs = 80) {
        clearSearchNavigationSettleTimer();

        if (settleMs <= 0) {
            searchNavigationState.value = 'idle';
            searchNavigationTargetPage.value = null;
            snapSuppressUntil.value = 0;
            isProgrammaticNavigationActive.value = false;
            return;
        }

        searchNavigationState.value = 'settling';
        markProgrammaticNavigation(Math.max(80, settleMs + 40));
        searchNavigationSettleTimer = setTimeout(() => {
            searchNavigationSettleTimer = null;
            searchNavigationState.value = 'idle';
            searchNavigationTargetPage.value = null;
            maybeReleaseProgrammaticNavigation();
        }, settleMs);
    }

    const wheelAccumulator = ref<IWheelPageAccumulatorState>(createWheelPageAccumulatorState());

    // Cooldown tracking: throttles rapid same-direction wheel flips while
    // still allowing immediate edge-flips after tall-page interior scrolling.
    let lastWheelFlipAtMs = 0;
    let lastWheelFlipDirection: TWheelDirection | 0 = 0;
    let interiorScrollSinceLastFlip = false;

    const debouncedRenderOnScroll = useDebounceFn(() => {
        if (isDisposed) {
            return;
        }
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        runGuardedTask(() => renderVisiblePages(visibleRange.value), {
            scope: 'pdf-single-page-scroll',
            message: 'Failed to render visible pages on scroll',
        });
    }, 100);

    function clearWheelAccumulator() {
        wheelAccumulator.value = createWheelPageAccumulatorState();
    }

    function getPageScrollBounds(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container || numPages.value === 0) {
            return null;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        return getPageScrollBoundsForContainer(
            container,
            targetPage,
            scaledMargin.value,
        );
    }

    function isWithinTallPageInterior(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }

        const bounds = getPageScrollBounds(pageNumber);
        if (!bounds || bounds.max - bounds.min <= PAGE_SCROLL_EDGE_EPSILON) {
            return false;
        }

        const top = container.scrollTop;
        return (
            top > bounds.min + PAGE_SCROLL_EDGE_EPSILON &&
            top < bounds.max - PAGE_SCROLL_EDGE_EPSILON
        );
    }

    function isTallPage(pageNumber: number) {
        const bounds = getPageScrollBounds(pageNumber);
        if (!bounds) {
            return false;
        }
        return bounds.max - bounds.min > PAGE_SCROLL_EDGE_EPSILON;
    }

    function snapToPage(pageNumber: number, anchor: TPageSnapAnchor = 'center') {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        const targetEl = getPageContainerByNumber(
            viewerContainer.value,
            targetPage,
        );
        if (!targetEl) {
            isSnapping.value = true;
            scrollToPageInternal(
                viewerContainer.value,
                targetPage,
                numPages.value,
                scaledMargin.value,
            );
            currentPage.value = targetPage;
            emitCurrentPage(targetPage);
            requestAnimationFrame(() => {
                isSnapping.value = false;
            });
            return;
        }

        const container = viewerContainer.value;
        const containerHeight = container.clientHeight;
        const targetHeight = targetEl.offsetHeight;
        const baseTop = targetEl.offsetTop - scaledMargin.value;
        const maxTop = Math.max(0, container.scrollHeight - containerHeight);
        const topTarget = Math.min(maxTop, Math.max(0, baseTop));
        const centerOffset = Math.max(0, (containerHeight - targetHeight) / 2);
        const centerTarget = Math.min(maxTop, Math.max(0, baseTop - centerOffset));
        const bottomTarget = Math.min(
            maxTop,
            Math.max(0, baseTop + targetHeight - containerHeight),
        );
        const targetTop = anchor === 'top'
            ? topTarget
            : anchor === 'bottom'
                ? bottomTarget
                : centerTarget;
        isSnapping.value = true;
        container.scrollTop = targetTop;
        currentPage.value = targetPage;
        emitCurrentPage(targetPage);

        requestAnimationFrame(() => {
            isSnapping.value = false;
        });
    }

    const debouncedSnapToPage = useDebounceFn(() => {
        if (isDisposed) {
            return;
        }
        const suppressed = (
            isLoading.value
            || !pdfDocument.value
            || continuousScroll.value
            || isSnapping.value
            || Date.now() < snapSuppressUntil.value
        );
        if (suppressed) {
            return;
        }
        const page = getMostVisiblePage(viewerContainer.value, numPages.value);
        if (isWithinTallPageInterior(page)) {
            return;
        }
        if (page === currentPage.value && isTallPage(page)) {
            return;
        }
        // For pages that fit within the viewport (fit-height, fit-width, or
        // any zoom where the page is shorter than the container), 'top' is the
        // only anchor that leaves the page cleanly framed: viewport shows
        // [margin gutter, full page, margin gutter]. The 'center' anchor
        // computes scrollTop = baseTop − (containerHeight − pageHeight)/2,
        // which is offset by half-margin and produces the classic "1.5 pages
        // visible" symptom (bottom edge of previous page bleeds into view).
        // Tall pages keep 'center' so they are vertically positioned within
        // the viewport rather than scrolled to the top edge.
        const anchor: TPageSnapAnchor = isTallPage(page) ? 'center' : 'top';
        snapToPage(page, anchor);
    }, 120);

    function handleWheel(event: WheelEvent) {
        const container = viewerContainer.value;
        if (!shouldHandleSinglePageWheel(
            event,
            container,
            !!pdfDocument.value,
            continuousScroll.value,
            isLoading.value,
            numPages.value,
        ) || !container) {
            return;
        }

        const delta = normalizePageWheelDelta(event.deltaY, event.deltaMode, container);
        if (Math.abs(delta) < WHEEL_DELTA_EPSILON) {
            return;
        }

        event.preventDefault();
        const direction = resolveWheelDirection(delta);
        const activePage = getMostVisiblePage(container, numPages.value);
        const bounds = getPageScrollBounds(activePage);

        if (
            bounds
            && isTallPage(activePage)
            && canScrollWithinPageBounds(container, bounds, direction)
        ) {
            clearWheelAccumulator();
            container.scrollTop = resolveNextTopWithinPageBounds(
                container,
                bounds,
                delta,
                direction,
            );
            // Record interior progress so the eventual edge-flip is not
            // gated by the same-direction cooldown.
            interiorScrollSinceLastFlip = true;
            return;
        }

        // Cooldown gate: when a same-direction flip just happened and the user
        // hasn't either reversed direction or scrolled within a tall page,
        // swallow this wheel packet to avoid trackpad inertia rapid-firing
        // through pages. preventDefault was already called above, so the
        // browser also won't perform a native scroll.
        if (isInSameDirectionFlipCooldown(
            event.timeStamp,
            direction,
            lastWheelFlipAtMs,
            lastWheelFlipDirection,
            interiorScrollSinceLastFlip,
        )) {
            clearWheelAccumulator();
            return;
        }

        const accumulationResult = accumulateWheelForPageFlips({
            state: wheelAccumulator.value,
            delta,
            direction,
            eventTimeMs: event.timeStamp,
            stepDelta: resolveWheelPageFlipStepDelta(event, delta),
        });
        wheelAccumulator.value = accumulationResult.state;
        if (accumulationResult.stepsToFlip === 0) {
            return;
        }

        const targetPage = resolveWheelTargetPage(
            activePage,
            viewMode.value,
            numPages.value,
            direction,
        );
        if (targetPage === activePage) {
            clearWheelAccumulator();
            return;
        }

        // Anchor selection:
        //   - Tall target page: align to 'top' on forward, 'bottom' on
        //     backward — standard reading flow (next page starts at top of
        //     viewport, previous page's tail visible when scrolling back).
        //   - Non-tall target page (page fits viewport): always 'top'. This
        //     leaves the page framed with clean margin gutters. The previous
        //     'center' anchor computed `baseTop − (containerHeight −
        //     pageHeight)/2`, which is half a margin off and bleeds the
        //     adjacent page into the viewport ("1.5 pages visible" symptom).
        const anchor = resolveWheelTargetAnchor(isTallPage(targetPage), direction);
        snapToPage(targetPage, anchor);
        suppressSnapFor(250);
        lastWheelFlipAtMs = event.timeStamp;
        lastWheelFlipDirection = direction;
        interiorScrollSinceLastFlip = false;
    }

    function handleScroll() {
        if (isLoading.value) {
            return;
        }

        const container = viewerContainer.value;
        updateVisibleRange(container, numPages.value);
        void debouncedRenderOnScroll();

        const previous = currentPage.value;
        const page = updateCurrentPage(container, numPages.value);
        if (page !== previous) {
            const top = container?.scrollTop ?? 0;
            logPdfNav(
                `[PDF-NAV] handleScroll: currentPage ${previous} -> ${page}`
                + ` scrollTop=${Math.round(top)}`,
            );
            emitCurrentPage(page);
        }
        maybeReleaseProgrammaticNavigation();

        if (!continuousScroll.value && !isSnapping.value) {
            void debouncedSnapToPage();
        }
    }

    function scrollToPage(
        pageNumber: number,
        options?: {preferExactDom?: boolean;},
    ) {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        logPdfNav(
            `[PDF-NAV] singlePageScroll.scrollToPage requested=${pageNumber}`
            + ` continuous=${continuousScroll.value}`
            + ` preferExactDom=${options?.preferExactDom === true}`
            + ` currentPage(before)=${currentPage.value}`
            + ` scrollTop(before)=${Math.round(viewerContainer.value.scrollTop)}`,
        );

        if (continuousScroll.value) {
            markProgrammaticNavigation(220);
            scrollToPageInternal(
                viewerContainer.value,
                pageNumber,
                numPages.value,
                scaledMargin.value,
                options,
            );
            const page = updateCurrentPage(viewerContainer.value, numPages.value);
            emitCurrentPage(page);
        } else {
            // Same anchor logic as the wheel and debounced snap paths: tall
            // pages can use 'center' (which clamps to topTarget when the page
            // exceeds the viewport — so it is effectively 'top'), but pages
            // that fit in the viewport MUST use 'top'. The legacy 'center'
            // anchor on a non-tall page produces scrollTop = baseTop −
            // (containerHeight − pageHeight)/2, off by half a margin, which is
            // the "1.5 pages visible" symptom (bottom of the previous page
            // bleeds in). pdf.js's scrollMode setter snaps to top-left of the
            // current page; mirror that behavior uniformly.
            const anchor: TPageSnapAnchor = isTallPage(pageNumber) ? 'center' : 'top';
            snapToPage(pageNumber, anchor);
        }

        queueMicrotask(() => {
            if (isLoading.value || !pdfDocument.value) {
                return;
            }
            updateVisibleRange(viewerContainer.value, numPages.value);
            runGuardedTask(() => renderVisiblePages(visibleRange.value), {
                scope: 'pdf-single-page-scroll',
                message: 'Failed to render visible pages after scrollToPage',
            });
        });
    }

    function resetContinuousScrollState() {
        clearWheelAccumulator();
        clearSearchNavigationSettleTimer();
        searchNavigationState.value = 'idle';
        isProgrammaticNavigationActive.value = false;
        searchNavigationTargetPage.value = null;
        snapSuppressUntil.value = 0;
        lastWheelFlipAtMs = 0;
        lastWheelFlipDirection = 0;
        interiorScrollSinceLastFlip = false;
    }

    tryOnScopeDispose(() => {
        isDisposed = true;
        clearSearchNavigationSettleTimer();
    });

    return {
        isSnapping,
        handleWheel,
        handleScroll,
        scrollToPage,
        snapToPage,
        suppressSnapFor,
        beginSearchNavigation,
        endSearchNavigation,
        isProgrammaticNavigationActive,
        isSearchNavigationLocked,
        searchNavigationState,
        searchNavigationTargetPage,
        resetContinuousScrollState,
    };
};
