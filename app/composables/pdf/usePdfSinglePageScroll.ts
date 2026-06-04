import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    tryOnScopeDispose,
    useDebounceFn,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import { delay } from 'es-toolkit/promise';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { stepBySpread } from '@app/utils/pdfViewMode';
import { logPdfNav } from '@app/utils/pdfNavLog';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    getPageContainerByNumber,
    getPageScrollBounds as getPageScrollBoundsForContainer,
} from '@app/composables/pdf/pdfScrollVisibility';
import { getPageRowBoundsForViewMode } from '@app/composables/pdf/pdfPageLayout';
import type { IScrollToPageOptions } from '@app/composables/pdf/usePdfScroll';

const WHEEL_LINE_DELTA_PX = 16;
const PAGE_FLIP_STEP_DELTA_PX = 120;
const MIN_COARSE_PAGE_FLIP_STEP_DELTA_PX = 40;
const WHEEL_IDLE_RESET_MS = 140;
const MAX_PAGE_FLIPS_PER_EVENT = 3;
const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;
const WHEEL_DELTA_EPSILON = 0.01;
const CONTINUOUS_PROGRAMMATIC_RENDER_SETTLE_DELAYS_MS = [
    0,
    80,
    240,
] as const;
const CONTINUOUS_NAVIGATION_TARGET_MAX_HOLD_MS = 6_000;
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

interface IPageRowGeometry {
    top: number;
    height: number;
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
        options?: IScrollToPageOptions,
    ) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
        options?: { requireAuthoritative?: boolean; },
    ) => number;
    renderVisiblePages: (
        range: {
            start: number;
            end: number
        },
        renderOptions?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            preserveInFlightRequiredPages?: boolean;
        },
    ) => Promise<void>;
    /**
     * Suppress ordinary paged row renders while another controller owns them.
     *
     * Fit-height/fit-width navigation must hydrate the target page metrics,
     * recompute scale, and then force-render the current row. Letting the
     * generic paged navigation render at the previous scale creates a same-page
     * cancel/restart race in PDF.js on very large pages.
     */
    suppressPagedRowRender?: (() => boolean) | undefined;
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
        suppressPagedRowRender,
        visibleRange,
        emitCurrentPage,
    } = options;

    const isSnapping = ref(false);
    const snapSuppressUntil = ref(0);
    const isProgrammaticNavigationActive = ref(false);
    const searchNavigationTargetPage = ref<number | null>(null);
    const continuousNavigationTargetPage = ref<number | null>(null);
    const searchNavigationState = ref<'idle' | 'navigating' | 'settling'>('idle');
    const isSearchNavigationLocked = computed(
        () => searchNavigationState.value !== 'idle',
    );
    const pagedNavigationTargetPage = ref<number | null>(null);
    let pagedNavigationRunId = 0;
    let pagedNavigationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let searchNavigationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let continuousNavigationRenderRunId = 0;
    let continuousNavigationRenderTimers: Array<ReturnType<typeof setTimeout>> = [];
    let continuousNavigationTargetClearTimer: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    function clearPagedNavigationSettleTimer() {
        if (pagedNavigationSettleTimer !== null) {
            clearTimeout(pagedNavigationSettleTimer);
            pagedNavigationSettleTimer = null;
        }
    }

    function clearPagedNavigationTarget() {
        clearPagedNavigationSettleTimer();
        pagedNavigationTargetPage.value = null;
    }

    function clearSearchNavigationSettleTimer() {
        if (searchNavigationSettleTimer !== null) {
            clearTimeout(searchNavigationSettleTimer);
            searchNavigationSettleTimer = null;
        }
    }

    function clearContinuousNavigationRenderTimers() {
        for (const timer of continuousNavigationRenderTimers) {
            clearTimeout(timer);
        }
        continuousNavigationRenderTimers = [];
    }

    function clearContinuousNavigationTargetClearTimer() {
        if (continuousNavigationTargetClearTimer !== null) {
            clearTimeout(continuousNavigationTargetClearTimer);
            continuousNavigationTargetClearTimer = null;
        }
    }

    function clearContinuousNavigationTarget(runId?: number, pageNumber?: number) {
        if (runId !== undefined && runId !== continuousNavigationRenderRunId) {
            return;
        }
        if (
            pageNumber !== undefined
            && continuousNavigationTargetPage.value !== pageNumber
        ) {
            return;
        }
        clearContinuousNavigationTargetClearTimer();
        continuousNavigationTargetPage.value = null;
    }

    function scheduleContinuousNavigationTargetFallbackClear(runId: number, pageNumber: number) {
        clearContinuousNavigationTargetClearTimer();
        continuousNavigationTargetClearTimer = setTimeout(() => {
            continuousNavigationTargetClearTimer = null;
            clearContinuousNavigationTarget(runId, pageNumber);
        }, CONTINUOUS_NAVIGATION_TARGET_MAX_HOLD_MS);
    }

    function clearContinuousNavigationTargetForPage(pageNumber: number) {
        clearContinuousNavigationTarget(undefined, pageNumber);
    }

    function waitForContinuousRenderFrame() {
        if (
            typeof window !== 'undefined'
            && typeof window.requestAnimationFrame === 'function'
        ) {
            return new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => resolve());
            });
        }

        return delay(0);
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

    function beginPagedNavigation(pageNumber: number, holdMs = 600) {
        const targetPage = clamp(pageNumber, 1, numPages.value);
        pagedNavigationTargetPage.value = targetPage;
        clearPagedNavigationSettleTimer();
        markProgrammaticNavigation(holdMs);
        pagedNavigationSettleTimer = setTimeout(() => {
            pagedNavigationSettleTimer = null;
            if (pagedNavigationTargetPage.value === targetPage) {
                pagedNavigationTargetPage.value = null;
                maybeReleaseProgrammaticNavigation();
            }
        }, holdMs);
        return targetPage;
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
        runGuardedTask(() => renderVisiblePages(
            visibleRange.value,
            { preserveRenderedPages: true },
        ), {
            scope: 'pdf-single-page-scroll',
            message: 'Failed to render visible pages on scroll',
        });
    }, 100);

    function clearWheelAccumulator() {
        wheelAccumulator.value = createWheelPageAccumulatorState();
    }

    function resolvePageRowRange(pageNumber: number) {
        return getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    }

    function setVisibleRangeToPageRow(pageNumber: number) {
        if (numPages.value === 0) {
            visibleRange.value = {
                start: 1,
                end: 1,
            };
            return visibleRange.value;
        }

        const rowRange = resolvePageRowRange(pageNumber);
        visibleRange.value = {
            start: rowRange.start,
            end: rowRange.end,
        };
        return visibleRange.value;
    }

    function setPagedNavigationTarget(pageNumber: number) {
        const targetPage = beginPagedNavigation(pageNumber);
        logPdfRenderTrace('single-page-set-paged-target', {
            requestedPage: pageNumber,
            targetPage,
            currentPageBefore: currentPage.value,
            visibleRangeBefore: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        setVisibleRangeToPageRow(targetPage);
        if (currentPage.value !== targetPage) {
            currentPage.value = targetPage;
            emitCurrentPage(targetPage);
        }
        return targetPage;
    }

    /**
     * Render the row selected by the currently active paged navigation run.
     *
     * Rapid toolbar clicks can queue several `nextTick` row renders before Vue
     * has mounted the final row. Without the run guard, an older page can write
     * `visibleRange` after a newer last-page jump and start a render that
     * cancels the real target. The current-page check handles external syncs
     * that supersede this run before the callback fires.
     */
    function queuePagedRowRenderAfterNavigation(
        pageNumber: number,
        message: string,
        runId: number,
    ) {
        const targetPage = clamp(pageNumber, 1, numPages.value);
        logPdfRenderTrace('single-page-queue-row-render', {
            targetPage,
            message,
            runId,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        void nextTick(() => {
            const isPagedRowRenderSuppressed = suppressPagedRowRender?.() === true;
            if (
                isDisposed
                || runId !== pagedNavigationRunId
                || continuousScroll.value
                || isLoading.value
                || !pdfDocument.value
                || currentPage.value !== targetPage
                || isPagedRowRenderSuppressed
            ) {
                logPdfRenderTrace('single-page-row-render-skipped', {
                    targetPage,
                    message,
                    runId,
                    activeRunId: pagedNavigationRunId,
                    isDisposed,
                    continuousScroll: continuousScroll.value,
                    isLoading: isLoading.value,
                    hasDocument: Boolean(pdfDocument.value),
                    currentPage: currentPage.value,
                    suppressPagedRowRender: isPagedRowRenderSuppressed,
                });
                return;
            }

            const range = setVisibleRangeToPageRow(targetPage);
            logPdfRenderTrace('single-page-row-render-run', {
                targetPage,
                message,
                range,
                currentPage: currentPage.value,
            });
            runGuardedTask(() => renderVisiblePages(
                range,
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                },
            ), {
                scope: 'pdf-single-page-scroll',
                message,
            });
        });
    }

    async function runContinuousNavigationRenderPass(
        runId: number,
        pageNumber: number,
        message: string,
        delayMs: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        await nextTick();
        await waitForContinuousRenderFrame();

        if (
            isDisposed
            || runId !== continuousNavigationRenderRunId
            || !continuousScroll.value
            || isLoading.value
            || !pdfDocument.value
        ) {
            logPdfRenderTrace('single-page-continuous-navigation-render-skipped', {
                runId,
                activeRunId: continuousNavigationRenderRunId,
                delayMs,
                isDisposed,
                continuousScroll: continuousScroll.value,
                isLoading: isLoading.value,
                hasDocument: Boolean(pdfDocument.value),
                currentPage: currentPage.value,
            });
            return;
        }

        if (continuousNavigationTargetPage.value === pageNumber && viewerContainer.value) {
            const previous = currentPage.value;
            scrollToPageInternal(
                viewerContainer.value,
                pageNumber,
                numPages.value,
                scaledMargin.value,
                scrollOptions,
            );
            const page = updateCurrentPage(
                viewerContainer.value,
                numPages.value,
                { requireAuthoritative: true },
            );
            if (page !== previous) {
                emitCurrentPage(page);
            }
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        const range = {
            start: visibleRange.value.start,
            end: visibleRange.value.end,
        };

        logPdfRenderTrace('single-page-continuous-navigation-render-run', {
            runId,
            delayMs,
            range,
            currentPage: currentPage.value,
            targetPage: continuousNavigationTargetPage.value,
        });
        runGuardedTask(() => renderVisiblePages(
            range,
            {
                preserveRenderedPages: true,
                bufferOverride: 1,
                preserveInFlightRequiredPages: true,
            },
        ), {
            scope: 'pdf-single-page-scroll',
            message,
        });
    }

    function queueContinuousNavigationRenderAfterNavigation(
        pageNumber: number,
        message: string,
        scrollOptions?: IScrollToPageOptions,
    ) {
        clearContinuousNavigationRenderTimers();
        const runId = ++continuousNavigationRenderRunId;

        logPdfRenderTrace('single-page-queue-continuous-navigation-render', {
            runId,
            delaysMs: [...CONTINUOUS_PROGRAMMATIC_RENDER_SETTLE_DELAYS_MS],
            currentPage: currentPage.value,
            targetPage: pageNumber,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });

        for (const delayMs of CONTINUOUS_PROGRAMMATIC_RENDER_SETTLE_DELAYS_MS) {
            const timer = setTimeout(() => {
                continuousNavigationRenderTimers = continuousNavigationRenderTimers
                    .filter(activeTimer => activeTimer !== timer);
                void runContinuousNavigationRenderPass(
                    runId,
                    pageNumber,
                    message,
                    delayMs,
                    scrollOptions,
                );
            }, delayMs);
            continuousNavigationRenderTimers.push(timer);
        }

        return runId;
    }

    function getPageScrollBounds(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container || numPages.value === 0) {
            return null;
        }

        const targetPage = clamp(pageNumber, 1, numPages.value);
        const rowGeometry = getPageRowGeometry(container, targetPage);
        if (rowGeometry) {
            return getPageScrollBoundsFromGeometry(container, rowGeometry);
        }

        return getPageScrollBoundsForContainer(
            container,
            targetPage,
            scaledMargin.value,
        );
    }

    function getPageRowGeometry(
        container: HTMLElement,
        pageNumber: number,
    ): IPageRowGeometry | null {
        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        let rowTop = Number.POSITIVE_INFINITY;
        let rowBottom = Number.NEGATIVE_INFINITY;
        let foundAnyPage = false;

        for (let rowPage = rowBounds.start; rowPage <= rowBounds.end; rowPage += 1) {
            const pageElement = getPageContainerByNumber(container, rowPage);
            if (!pageElement) {
                continue;
            }
            foundAnyPage = true;
            rowTop = Math.min(rowTop, pageElement.offsetTop);
            rowBottom = Math.max(rowBottom, pageElement.offsetTop + pageElement.offsetHeight);
        }

        if (!foundAnyPage) {
            return null;
        }

        return {
            top: rowTop,
            height: Math.max(0, rowBottom - rowTop),
        };
    }

    function getPageScrollBoundsFromGeometry(
        container: HTMLElement,
        geometry: IPageRowGeometry,
    ): IPageScrollBounds {
        const maxScrollTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
        );
        const unclampedMin = Math.max(0, geometry.top - scaledMargin.value);
        const unclampedMax = unclampedMin + Math.max(
            0,
            geometry.height - container.clientHeight,
        );
        const min = Math.min(maxScrollTop, unclampedMin);
        const max = Math.min(maxScrollTop, Math.max(min, unclampedMax));

        return {
            min,
            max,
        };
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

    function applySnapToMountedPage(pageNumber: number, anchor: TPageSnapAnchor) {
        if (!viewerContainer.value || numPages.value === 0) {
            return false;
        }

        const targetPage = clamp(pageNumber, 1, numPages.value);
        const targetEl = getPageContainerByNumber(
            viewerContainer.value,
            targetPage,
        );
        if (!targetEl || targetEl.classList?.contains('page_container--buffered')) {
            return false;
        }

        const container = viewerContainer.value;
        const containerHeight = container.clientHeight;
        const targetGeometry = getPageRowGeometry(container, targetPage) ?? {
            top: targetEl.offsetTop,
            height: targetEl.offsetHeight,
        };
        const targetHeight = targetGeometry.height;
        const baseTop = targetGeometry.top - scaledMargin.value;
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
        if (currentPage.value !== targetPage) {
            currentPage.value = targetPage;
            emitCurrentPage(targetPage);
        }

        requestAnimationFrame(() => {
            isSnapping.value = false;
        });
        return true;
    }

    function snapToPage(
        pageNumber: number,
        anchor: TPageSnapAnchor = 'center',
        options?: Pick<IScrollToPageOptions, 'suppressRenderAfterSnap'>,
    ) {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        const targetPage = clamp(pageNumber, 1, numPages.value);
        logPdfRenderTrace('single-page-snap-to-page', {
            requestedPage: pageNumber,
            targetPage,
            anchor,
            continuousScroll: continuousScroll.value,
            suppressRenderAfterSnap: options?.suppressRenderAfterSnap === true,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        if (!continuousScroll.value) {
            const runId = ++pagedNavigationRunId;
            setPagedNavigationTarget(targetPage);

            if (applySnapToMountedPage(targetPage, anchor)) {
                logPdfRenderTrace('single-page-snap-mounted', {
                    targetPage,
                    anchor,
                    runId,
                });
                setVisibleRangeToPageRow(targetPage);
                if (!options?.suppressRenderAfterSnap) {
                    queuePagedRowRenderAfterNavigation(
                        targetPage,
                        'Failed to render visible pages after paged snap',
                        runId,
                    );
                } else {
                    logPdfRenderTrace('single-page-snap-mounted-render-suppressed', {
                        targetPage,
                        anchor,
                        runId,
                    });
                }
                return;
            }

            queuePagedRowRenderAfterNavigation(
                targetPage,
                'Failed to render visible pages after paged navigation',
                runId,
            );
            isSnapping.value = true;
            void nextTick(() => {
                if (
                    isDisposed
                    || runId !== pagedNavigationRunId
                    || continuousScroll.value
                    || currentPage.value !== targetPage
                ) {
                    logPdfRenderTrace('single-page-snap-next-tick-skipped', {
                        targetPage,
                        runId,
                        activeRunId: pagedNavigationRunId,
                        isDisposed,
                        continuousScroll: continuousScroll.value,
                        currentPage: currentPage.value,
                    });
                    isSnapping.value = false;
                    return;
                }

                if (!applySnapToMountedPage(targetPage, anchor)) {
                    logPdfRenderTrace('single-page-snap-next-tick-missing-target', {
                        targetPage,
                        runId,
                        anchor,
                    });
                    isSnapping.value = false;
                    return;
                }
                logPdfRenderTrace('single-page-snap-next-tick-mounted', {
                    targetPage,
                    runId,
                    anchor,
                });
            });
            return;
        }

        if (applySnapToMountedPage(targetPage, anchor)) {
            return;
        }

        isSnapping.value = true;
        const previous = currentPage.value;
        scrollToPageInternal(
            viewerContainer.value,
            targetPage,
            numPages.value,
            scaledMargin.value,
        );
        if (currentPage.value !== previous) {
            emitCurrentPage(currentPage.value);
        }
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
        const container = viewerContainer.value;
        if (!continuousScroll.value && (isSnapping.value || pagedNavigationTargetPage.value !== null)) {
            const targetPage = pagedNavigationTargetPage.value ?? currentPage.value;
            logPdfRenderTrace('single-page-scroll-paged-navigation-active', {
                targetPage,
                currentPage: currentPage.value,
                isSnapping: isSnapping.value,
                pagedNavigationTargetPage: pagedNavigationTargetPage.value,
                scrollTop: container?.scrollTop ?? null,
            });
            if (currentPage.value !== targetPage) {
                currentPage.value = targetPage;
                emitCurrentPage(targetPage);
            }
            setVisibleRangeToPageRow(targetPage);
            return;
        }

        updateVisibleRange(container, numPages.value);

        const previous = currentPage.value;
        const page = updateCurrentPage(
            container,
            numPages.value,
            { requireAuthoritative: true },
        );
        if (page !== previous) {
            const top = container?.scrollTop ?? 0;
            logPdfNav(
                `[PDF-NAV] handleScroll: currentPage ${previous} -> ${page}`
                + ` scrollTop=${Math.round(top)}`,
            );
            emitCurrentPage(page);
        }

        if (isLoading.value) {
            return;
        }

        if (isProgrammaticNavigationActive.value || Date.now() < snapSuppressUntil.value) {
            logPdfRenderTrace('single-page-scroll-skip-debounced-render-programmatic', {
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                isProgrammaticNavigationActive: isProgrammaticNavigationActive.value,
                snapSuppressUntil: snapSuppressUntil.value,
                now: Date.now(),
            });
        } else {
            void debouncedRenderOnScroll();
        }
        maybeReleaseProgrammaticNavigation();

        if (!continuousScroll.value && !isSnapping.value) {
            void debouncedSnapToPage();
        }
    }

    function scrollToPage(
        pageNumber: number,
        options?: IScrollToPageOptions,
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
        logPdfRenderTrace('single-page-scroll-to-page', {
            requestedPage: pageNumber,
            continuousScroll: continuousScroll.value,
            preferExactDom: options?.preferExactDom === true,
            currentPageBefore: currentPage.value,
            scrollTopBefore: viewerContainer.value.scrollTop,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });

        if (continuousScroll.value) {
            markProgrammaticNavigation(220);
            const targetPage = clamp(pageNumber, 1, numPages.value);
            continuousNavigationTargetPage.value = targetPage;
            const previous = currentPage.value;
            scrollToPageInternal(
                viewerContainer.value,
                pageNumber,
                numPages.value,
                scaledMargin.value,
                options,
            );
            const page = updateCurrentPage(
                viewerContainer.value,
                numPages.value,
                { requireAuthoritative: true },
            );
            if (page !== previous) {
                emitCurrentPage(page);
            }
            const runId = queueContinuousNavigationRenderAfterNavigation(
                targetPage,
                'Failed to render visible pages after scrollToPage',
                options,
            );
            scheduleContinuousNavigationTargetFallbackClear(runId, targetPage);
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
            snapToPage(pageNumber, anchor, options);
        }
    }

    function resetContinuousScrollState() {
        clearWheelAccumulator();
        clearPagedNavigationTarget();
        clearSearchNavigationSettleTimer();
        clearContinuousNavigationRenderTimers();
        clearContinuousNavigationTargetClearTimer();
        searchNavigationState.value = 'idle';
        isProgrammaticNavigationActive.value = false;
        searchNavigationTargetPage.value = null;
        continuousNavigationTargetPage.value = null;
        snapSuppressUntil.value = 0;
        lastWheelFlipAtMs = 0;
        lastWheelFlipDirection = 0;
        interiorScrollSinceLastFlip = false;
    }

    tryOnScopeDispose(() => {
        isDisposed = true;
        clearPagedNavigationSettleTimer();
        clearSearchNavigationSettleTimer();
        clearContinuousNavigationRenderTimers();
        clearContinuousNavigationTargetClearTimer();
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
        continuousNavigationTargetPage,
        clearContinuousNavigationTargetForPage,
        resetContinuousScrollState,
    };
};
