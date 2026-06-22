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
import { logPdfNav } from '@app/utils/logPdfNav';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { getPageScrollBounds as getPageScrollBoundsForContainer } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageScrollBounds';
import type { IPageScrollBounds } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type {
    IWheelPageAccumulatorState,
    TPageSnapAnchor,
    TWheelDirection,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';
import { createWheelPageAccumulatorState } from '@app/utils/document-viewer/single-page-wheel/createWheelPageAccumulatorState';
import { normalizePageWheelDelta } from '@app/utils/document-viewer/single-page-wheel/normalizePageWheelDelta';
import { resolveSnapAnchorForWheelDirection } from '@app/utils/document-viewer/single-page-wheel/resolveSnapAnchorForWheelDirection';
import { accumulateWheelForPageFlips } from '@app/utils/document-viewer/single-page-wheel/accumulateWheelForPageFlips';
import { resolveWheelPageFlipStepDelta } from '@app/utils/document-viewer/single-page-wheel/resolveWheelPageFlipStepDelta';
import type { TPdfNavigationEvent } from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import { createPdfNavigationRuntime } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationRuntime';
import { createWheelFlipGate } from '@app/modules/pdf-viewer/runtime/navigation/createWheelFlipGate';
import { createNavigationSettleEffects } from '@app/modules/pdf-viewer/runtime/navigation/createNavigationSettleEffects';

const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;
const WHEEL_DELTA_EPSILON = 0.01;
const CONTINUOUS_PROGRAMMATIC_RENDER_SETTLE_DELAYS_MS = [
    0,
    80,
    240,
] as const;
const CONTINUOUS_NAVIGATION_TARGET_MAX_HOLD_MS = 6_000;
const CONTINUOUS_NAVIGATION_REAPPLY_EPSILON = 0.5;
const PAGED_NAVIGATION_HOLD_STALL_LOG_MS = 4_000;
const PAGED_NAVIGATION_SETTLE_TIMEOUT_MS = 800;
const PAGED_NAVIGATION_DEFAULT_HOLD_MS = 600;
const PAGED_NAVIGATION_READY_RETRY_DELAYS_MS = [
    120,
    320,
    700,
] as const;
const PAGED_NAVIGATION_RECOVERY_RENDER_MS = 1_400;
const PAGED_NAVIGATION_ABANDON_MS = 6_000;
const SEARCH_NAVIGATION_DEFAULT_HOLD_MS = 400;
const SEARCH_NAVIGATION_MIN_HOLD_MS = 100;
const SEARCH_NAVIGATION_DEFAULT_SETTLE_MS = 80;
const SCROLL_RENDER_DEBOUNCE_MS = 100;
const TALL_PAGE_SNAP_DEBOUNCE_MS = 120;
const WHEEL_FLIP_SNAP_SUPPRESSION_MS = 250;
const CONTINUOUS_NAVIGATION_HOLD_WITH_METRICS_MS = 1_200;
const CONTINUOUS_NAVIGATION_HOLD_FALLBACK_MS = 220;
const PROGRAMMATIC_NAVIGATION_RELEASE_RETRY_MS = 40;

interface IPageRowGeometry {
    top: number;
    height: number;
}

interface IPagedNavigationHold {
    expired: boolean;
    runId: number;
    startedAtMs: number;
    targetStart: number;
    targetEnd: number;
}

interface IPagedRowRenderRequest {
    allowSuppressedRender?: boolean;
    pageNumber: number;
    message: string;
    runId: number;
}

interface INavigationFeedbackState {
    page: number | null;
    runId: number | null;
}

type TPagedTargetLayoutPreparation = void | Promise<void>;

interface IApplySnapToMountedPageCommitOptions {commitCurrentPage?: boolean;}

interface IMountedPageVisualState {
    buffered: boolean;
    hasCanvas: boolean;
    hasSkeleton: boolean;
    mounted: boolean;
    renderedClass: boolean;
}

interface IMountedPageVisualReadiness {
    freshlyRendered: boolean;
    hasUsableCanvas: boolean;
    usable: boolean;
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
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    preparePagedTargetLayout?: ((
        pageNumber: number,
        shouldContinue: () => boolean,
    ) => TPagedTargetLayoutPreparation) | undefined;
    /**
     * Suppress ordinary paged row renders while another controller owns them.
     *
     * Fit-height/fit-width navigation must hydrate the target page metrics,
     * recompute scale, and then force-render the current row. Letting the
     * generic paged navigation render at the previous scale creates a same-page
     * cancel/restart race in PDF.js on very large pages.
     */
    suppressPagedRowRender?: (() => boolean) | undefined;
    isPageFreshlyRenderedForNavigation?: ((pageNumber: number) => boolean) | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    emitCurrentPage: (page: number) => void;
    emitNavigationFeedbackPage?: ((page: number | null) => void) | undefined;
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
        ensurePageMetricsInRange,
        preparePagedTargetLayout,
        suppressPagedRowRender,
        visibleRange,
        emitCurrentPage,
        emitNavigationFeedbackPage,
    } = options;

    const isSnapping = ref(false);
    const snapSuppressUntil = ref(0);
    const isProgrammaticNavigationActive = ref(false);
    const navigationRuntime = createPdfNavigationRuntime();
    const searchNavigationState = computed(() => (
        navigationRuntime.source.value === 'search'
            ? navigationRuntime.status.value
            : 'idle'
    ));
    const searchNavigationTargetPage = computed(() => (
        navigationRuntime.source.value === 'search'
        && navigationRuntime.status.value !== 'idle'
            ? navigationRuntime.targetPage.value
            : null
    ));
    const continuousNavigationTargetPage = ref<number | null>(null);
    const isSearchNavigationLocked = computed(
        () => searchNavigationState.value !== 'idle',
    );
    const pagedNavigationTargetPage = computed(() => (
        navigationRuntime.source.value === 'paged'
        && navigationRuntime.status.value !== 'idle'
            ? navigationRuntime.targetPage.value
            : null
    ));
    const pagedNavigationHold = shallowRef<IPagedNavigationHold | null>(null);
    let continuousNavigationRenderRunId = 0;
    let pagedNavigationPrepareRunId = 0;
    let pagedNavigationPrepareTargetPage: number | null = null;
    let continuousNavigationTargetScrollOptions: IScrollToPageOptions | undefined;
    let pagedNavigationTargetScrollOptions: Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect'> | undefined;
    let navigationFeedbackState: INavigationFeedbackState = {
        page: null,
        runId: null,
    };
    let isDisposed = false;
    let pagedNavigationHardHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let pagedNavigationReadyRetryTimers: Array<ReturnType<typeof setTimeout>> = [];
    let pagedNavigationRecoveryRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let pagedNavigationAbandonTimer: ReturnType<typeof setTimeout> | null = null;
    let programmaticNavigationReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    const navigationEffects = createNavigationSettleEffects({
        getLayoutObserverElements: resolveContinuousNavigationLayoutObserverElements,
        hasLayoutMutation: hasContinuousNavigationLayoutMutation,
        onLayoutReapply: ({
            runId,
            pageNumber,
            reason,
            scrollOptions,
        }) => {
            logPdfRenderTrace('single-page-continuous-navigation-layout-reapply', {
                runId,
                activeRunId: continuousNavigationRenderRunId,
                targetPage: pageNumber,
                activeTargetPage: continuousNavigationTargetPage.value,
                reason,
            });
            reapplyContinuousNavigationTargetScroll(runId, pageNumber, scrollOptions);
        },
    });

    function clearPagedNavigationTarget() {
        navigationEffects.clearPagedSettle();
    }

    function clearPagedNavigationPreparation(runId?: number) {
        if (runId !== undefined && runId !== pagedNavigationPrepareRunId) {
            return;
        }
        pagedNavigationPrepareTargetPage = null;
    }

    function setNavigationFeedbackPage(page: number, reason: string, runId: number) {
        if (
            navigationFeedbackState.page === page
            && navigationFeedbackState.runId === runId
        ) {
            return;
        }

        navigationFeedbackState = {
            page,
            runId,
        };
        logPdfRenderTrace('single-page-navigation-feedback-page', {
            page,
            reason,
            runId,
            currentPage: currentPage.value,
            pagedNavigationTargetPage: pagedNavigationTargetPage.value,
        });
        emitNavigationFeedbackPage?.(page);
    }

    function clearNavigationFeedbackPage(reason: string, runId?: number) {
        if (
            runId !== undefined
            && navigationFeedbackState.runId !== runId
        ) {
            return;
        }
        if (
            navigationFeedbackState.page === null
            && navigationFeedbackState.runId === null
        ) {
            return;
        }

        const previous = navigationFeedbackState;
        navigationFeedbackState = {
            page: null,
            runId: null,
        };
        logPdfRenderTrace('single-page-navigation-feedback-page', {
            page: null,
            reason,
            runId: previous.runId,
            previousPage: previous.page,
            currentPage: currentPage.value,
            pagedNavigationTargetPage: pagedNavigationTargetPage.value,
        });
        emitNavigationFeedbackPage?.(null);
    }

    function clearPagedNavigationWatchdogTimers() {
        if (pagedNavigationHardHoldTimer) {
            clearTimeout(pagedNavigationHardHoldTimer);
            pagedNavigationHardHoldTimer = null;
        }
        for (const timer of pagedNavigationReadyRetryTimers) {
            clearTimeout(timer);
        }
        pagedNavigationReadyRetryTimers = [];
        if (pagedNavigationRecoveryRenderTimer) {
            clearTimeout(pagedNavigationRecoveryRenderTimer);
            pagedNavigationRecoveryRenderTimer = null;
        }
        if (pagedNavigationAbandonTimer) {
            clearTimeout(pagedNavigationAbandonTimer);
            pagedNavigationAbandonTimer = null;
        }
    }

    function clearProgrammaticNavigationReleaseTimer() {
        if (!programmaticNavigationReleaseTimer) {
            return;
        }
        clearTimeout(programmaticNavigationReleaseTimer);
        programmaticNavigationReleaseTimer = null;
    }

    function scheduleProgrammaticNavigationRelease() {
        clearProgrammaticNavigationReleaseTimer();
        if (!isProgrammaticNavigationActive.value || isDisposed) {
            return;
        }

        const remainingMs = snapSuppressUntil.value - Date.now();
        const delayMs = remainingMs > 0
            ? remainingMs
            : PROGRAMMATIC_NAVIGATION_RELEASE_RETRY_MS;
        programmaticNavigationReleaseTimer = setTimeout(() => {
            programmaticNavigationReleaseTimer = null;
            maybeReleaseProgrammaticNavigation();
            if (isProgrammaticNavigationActive.value && !isDisposed) {
                scheduleProgrammaticNavigationRelease();
            }
        }, delayMs);
    }

    function clearPagedNavigationHold(runId?: number) {
        const hold = pagedNavigationHold.value;
        if (runId !== undefined && hold?.runId !== runId) {
            return;
        }

        clearPagedNavigationWatchdogTimers();
        pagedNavigationHold.value = null;
    }

    function isPagedNavigationTargetCurrent(runId: number, targetPage: number) {
        return !isDisposed
            && !continuousScroll.value
            && isPagedNavigationRunCurrent(runId)
            && pagedNavigationTargetPage.value === targetPage;
    }

    function startPagedNavigationHold(runId: number, targetPage: number) {
        if (continuousScroll.value || numPages.value === 0) {
            clearPagedNavigationHold();
            return;
        }

        const fromRange = resolvePageRowRange(currentPage.value);
        const targetRange = resolvePageRowRange(targetPage);
        if (
            fromRange.start === targetRange.start
            && fromRange.end === targetRange.end
        ) {
            clearPagedNavigationHold();
            return;
        }

        clearPagedNavigationHold();
        pagedNavigationHold.value = {
            expired: false,
            runId,
            startedAtMs: Date.now(),
            targetStart: targetRange.start,
            targetEnd: targetRange.end,
        };
        for (const delayMs of PAGED_NAVIGATION_READY_RETRY_DELAYS_MS) {
            const timer = setTimeout(() => {
                if (!isPagedNavigationTargetCurrent(runId, targetPage)) {
                    return;
                }
                commitPagedNavigationTarget(runId, targetPage, 'watchdog-ready-retry');
            }, delayMs);
            pagedNavigationReadyRetryTimers.push(timer);
        }
        pagedNavigationRecoveryRenderTimer = setTimeout(() => {
            pagedNavigationRecoveryRenderTimer = null;
            if (!isPagedNavigationTargetCurrent(runId, targetPage)) {
                return;
            }
            if (commitPagedNavigationTarget(runId, targetPage, 'watchdog-recovery-precheck')) {
                return;
            }
            logPdfRenderTrace('single-page-paged-target-recovery-render', {
                runId,
                targetPage,
                targetRange,
                rowVisualStates: getMountedPageRowVisualStates(targetRange),
            });
            queuePagedRowRenderAfterNavigation(
                targetPage,
                'Failed to recover stalled paged navigation target',
                runId,
                { allowSuppressedRender: true },
            );
        }, PAGED_NAVIGATION_RECOVERY_RENDER_MS);
        pagedNavigationAbandonTimer = setTimeout(() => {
            pagedNavigationAbandonTimer = null;
            if (!isPagedNavigationTargetCurrent(runId, targetPage)) {
                return;
            }
            if (commitPagedNavigationTarget(runId, targetPage, 'watchdog-abandon-final-check')) {
                return;
            }

            const hold = pagedNavigationHold.value;
            if (hold?.runId === runId) {
                pagedNavigationHold.value = {
                    ...hold,
                    expired: true,
                };
            }
            logPdfRenderTrace('single-page-paged-target-abandoned', {
                runId,
                targetPage,
                targetRange,
                holdStartedAtMs: hold?.startedAtMs ?? null,
                rowVisualStates: getMountedPageRowVisualStates(targetRange),
            });
            clearNavigationFeedbackPage('paged-navigation-abandoned', runId);
            clearPagedNavigationHold(runId);
            dispatchNavigationMachine({ type: 'CANCEL' });
            clearPagedNavigationTarget();
            pagedNavigationTargetScrollOptions = undefined;
            snapSuppressUntil.value = 0;
            isProgrammaticNavigationActive.value = false;
            isSnapping.value = false;
            clearProgrammaticNavigationReleaseTimer();

            const container = viewerContainer.value;
            updateVisibleRange(container, numPages.value);
            const previous = currentPage.value;
            const page = updateCurrentPage(
                container,
                numPages.value,
                { requireAuthoritative: true },
            );
            if (page !== previous) {
                emitCurrentPage(page);
            }
            if (!isLoading.value && pdfDocument.value) {
                runGuardedTask(() => renderVisiblePages(
                    visibleRange.value,
                    {
                        preserveRenderedPages: true,
                        preserveInFlightRequiredPages: true,
                    },
                ), {
                    scope: 'pdf-single-page-scroll',
                    message: 'Failed to render visible pages after abandoning stalled paged navigation',
                });
            }
        }, PAGED_NAVIGATION_ABANDON_MS);
        pagedNavigationHardHoldTimer = setTimeout(() => {
            pagedNavigationHardHoldTimer = null;
            if (!isPagedNavigationRunCurrent(runId)) {
                return;
            }
            logPdfRenderTrace('single-page-paged-target-still-waiting', {
                runId,
                targetPage,
                targetRange,
                rowVisualStates: getMountedPageRowVisualStates(targetRange),
            });
        }, PAGED_NAVIGATION_HOLD_STALL_LOG_MS);
    }

    function isNavigationHoldActiveForPage(pageNumber: number) {
        const hold = pagedNavigationHold.value;
        return hold !== null
            && pageNumber >= hold.targetStart
            && pageNumber <= hold.targetEnd;
    }

    function isNavigationHoldExpiredPage(pageNumber: number) {
        const hold = pagedNavigationHold.value;
        return hold?.expired === true
            && pageNumber >= hold.targetStart
            && pageNumber <= hold.targetEnd;
    }

    function schedulePagedNavigationReadyRetry(
        runId: number,
        targetPage: number,
        pageNumber: number,
    ) {
        void nextTick(() => {
            if (
                isDisposed
                || !isPagedNavigationRunCurrent(runId)
                || pagedNavigationTargetPage.value !== targetPage
            ) {
                return;
            }

            commitPagedNavigationReadyPage(pageNumber, 'page-visual-ready-dom-settled');
        });
    }

    function releasePagedNavigationHoldForPage(pageNumber: number) {
        const targetPage = pagedNavigationTargetPage.value;
        if (targetPage === null) {
            return false;
        }

        const runId = navigationRuntime.txn.value;
        const targetRange = resolvePageRowRange(targetPage);
        if (!isPageInRange(pageNumber, targetRange)) {
            return false;
        }

        const committed = commitPagedNavigationReadyPage(pageNumber, 'page-visual-ready');
        if (!committed) {
            schedulePagedNavigationReadyRetry(runId, targetPage, pageNumber);
        }
        return committed;
    }

    function isPagedNavigationBurstActive() {
        return false;
    }

    function dispatchNavigationMachine(event: TPdfNavigationEvent) {
        return navigationRuntime.dispatch(event);
    }

    function isNavigationRunCurrent(runId: number) {
        return navigationRuntime.isTxnCurrent(runId);
    }

    function isPagedNavigationRunCurrent(runId: number) {
        return isNavigationRunCurrent(runId);
    }

    function isPagedNavigationPrepareRunCurrent(runId: number, targetPage: number) {
        return runId === pagedNavigationPrepareRunId
            && !isDisposed
            && !continuousScroll.value
            && !isLoading.value
            && Boolean(pdfDocument.value)
            && targetPage >= 1
            && targetPage <= numPages.value;
    }

    function isPromiseLike(value: TPagedTargetLayoutPreparation): value is Promise<void> {
        return value !== undefined
            && typeof (value as { then?: unknown }).then === 'function';
    }

    function getActiveSearchNavigationRunId() {
        return navigationRuntime.source.value === 'search'
        && navigationRuntime.status.value !== 'idle'
            ? navigationRuntime.txn.value
            : null;
    }

    function markPagedNavigationScrollApplied(runId: number, targetPage: number) {
        if (!isPagedNavigationRunCurrent(runId)) {
            return;
        }
        dispatchNavigationMachine({
            type: 'SCROLL_APPLIED',
            txn: runId,
            page: targetPage,
        });
        setNavigationFeedbackPage(targetPage, 'paged-scroll-applied', runId);
    }

    function finishPagedNavigation(
        runId: number,
        targetPage: number,
        options?: { releaseHold?: boolean; },
    ) {
        const releaseHold = options?.releaseHold ?? true;
        if (!isPagedNavigationRunCurrent(runId)) {
            if (releaseHold) {
                clearPagedNavigationHold(runId);
            }
            return;
        }
        const shouldReleaseProgrammaticNavigation = pagedNavigationTargetPage.value === targetPage;
        dispatchNavigationMachine({
            type: 'RENDER_SETTLED',
            txn: runId,
            page: targetPage,
        });
        if (shouldReleaseProgrammaticNavigation) {
            clearPagedNavigationTarget();
            pagedNavigationTargetScrollOptions = undefined;
            clearNavigationFeedbackPage('paged-navigation-finished', runId);
            if (releaseHold) {
                clearPagedNavigationHold(runId);
            }
            maybeReleaseProgrammaticNavigation();
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
        navigationEffects.clearContinuousTargetFallback();
        continuousNavigationTargetPage.value = null;
        continuousNavigationTargetScrollOptions = undefined;
        navigationEffects.clearLayoutObservers();
    }

    function scheduleContinuousNavigationTargetFallbackClear(runId: number, pageNumber: number) {
        navigationEffects.armContinuousTargetFallback(
            CONTINUOUS_NAVIGATION_TARGET_MAX_HOLD_MS,
            () => {
                clearContinuousNavigationTarget(runId, pageNumber);
            },
        );
    }

    function cancelContinuousNavigationTarget() {
        if (
            continuousNavigationTargetPage.value === null
            && !navigationEffects.hasContinuousRenderTimers()
        ) {
            return;
        }

        continuousNavigationRenderRunId += 1;
        navigationEffects.clearContinuousRenderTimers();
        clearContinuousNavigationTarget();
    }

    /**
     * Releases programmatic navigation ownership so future scroll events are
     * reconciled from the live viewport instead of an obsolete target.
     */
    function cancelProgrammaticNavigation() {
        pagedNavigationPrepareRunId += 1;
        clearPagedNavigationPreparation();
        dispatchNavigationMachine({ type: 'CANCEL' });
        clearPagedNavigationTarget();
        pagedNavigationTargetScrollOptions = undefined;
        clearNavigationFeedbackPage('programmatic-navigation-canceled');
        clearPagedNavigationHold();
        navigationEffects.clearSearchSettle();
        cancelContinuousNavigationTarget();
        snapSuppressUntil.value = 0;
        isProgrammaticNavigationActive.value = false;
        isSnapping.value = false;
        clearProgrammaticNavigationReleaseTimer();
    }

    function scheduleSinglePageScrollFrame(callback: () => void) {
        if (
            typeof window !== 'undefined'
            && typeof window.requestAnimationFrame === 'function'
        ) {
            window.requestAnimationFrame(callback);
            return;
        }

        setTimeout(callback, 0);
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

    function resolveContinuousNavigationLayoutObserverElements(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container) {
            return [];
        }

        const targetPageElement = getPageContainerByNumber(container, pageNumber);
        return targetPageElement
            ? [
                container,
                targetPageElement,
            ]
            : [container];
    }

    function resolveContinuousNavigationTargetTop(
        pageNumber: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }

        const targetPageElement = getPageContainerByNumber(container, pageNumber);
        if (!targetPageElement) {
            return null;
        }

        const pageHeight = targetPageElement.offsetHeight || targetPageElement.clientHeight;
        const pageYRatio = typeof scrollOptions?.pageYRatio === 'number'
            && Number.isFinite(scrollOptions.pageYRatio)
            ? clamp(scrollOptions.pageYRatio, 0, 1)
            : 0;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (typeof scrollOptions?.pageYRatio === 'number' && Number.isFinite(scrollOptions.pageYRatio)) {
            return Math.min(
                maxTop,
                Math.max(
                    0,
                    targetPageElement.offsetTop + pageYRatio * pageHeight - scaledMargin.value,
                ),
            );
        }

        if (scrollOptions?.markerRect) {
            const markerCenterY = clamp(
                scrollOptions.markerRect.top + scrollOptions.markerRect.height / 2,
                0,
                1,
            );
            return clampMarkerScrollTopToPageBounds({
                desiredTop: Math.max(
                    0,
                    targetPageElement.offsetTop + markerCenterY * pageHeight - container.clientHeight / 2,
                ),
                maxTop,
                pageTop: targetPageElement.offsetTop,
                pageHeight,
                containerHeight: container.clientHeight,
            });
        }

        return Math.min(
            maxTop,
            Math.max(0, targetPageElement.offsetTop - scaledMargin.value),
        );
    }

    function isContinuousNavigationTargetAligned(
        pageNumber: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        const container = viewerContainer.value;
        const targetTop = resolveContinuousNavigationTargetTop(pageNumber, scrollOptions);
        return Boolean(
            container
            && targetTop !== null
            && Math.abs(container.scrollTop - targetTop) <= CONTINUOUS_NAVIGATION_REAPPLY_EPSILON,
        );
    }

    function clampMarkerScrollTopToPageBounds(options: {
        desiredTop: number;
        maxTop: number;
        pageTop: number;
        pageHeight: number;
        containerHeight: number;
    }) {
        const minTop = Math.max(0, options.pageTop - scaledMargin.value);
        const pageMaxTop = Math.max(
            minTop,
            options.pageTop + options.pageHeight + scaledMargin.value - options.containerHeight,
        );
        const boundedMaxTop = Math.min(options.maxTop, pageMaxTop);
        const boundedMinTop = Math.min(minTop, boundedMaxTop);

        return clamp(
            options.desiredTop,
            boundedMinTop,
            Math.max(boundedMinTop, boundedMaxTop),
        );
    }

    function startContinuousNavigationLayoutObservers(
        runId: number,
        pageNumber: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        navigationEffects.attachLayoutObservers(runId, pageNumber, scrollOptions);
    }

    function getMutationElement(node: Node | null) {
        if (!node) {
            return null;
        }
        if (node === viewerContainer.value) {
            return viewerContainer.value;
        }
        if (typeof HTMLElement === 'undefined') {
            return null;
        }
        return node instanceof HTMLElement
            ? node
            : node.parentElement;
    }

    function isContinuousNavigationLayoutElement(element: HTMLElement, pageNumber: number) {
        const container = viewerContainer.value;
        if (element === container || element.classList.contains('pdf-viewer-virtual-spacer')) {
            return true;
        }

        const pageElement = element.classList.contains('page_container')
            ? element
            : element.closest<HTMLElement>('.page_container');
        if (!pageElement || pageElement !== element) {
            return false;
        }

        const page = Number.parseInt(pageElement.dataset.page ?? '', 10);
        return Number.isFinite(page) && page <= pageNumber;
    }

    function hasContinuousNavigationLayoutMutation(
        mutations: MutationRecord[],
        pageNumber: number,
    ) {
        return mutations.some((mutation) => {
            const targetElement = getMutationElement(mutation.target);
            if (
                targetElement
                && isContinuousNavigationLayoutElement(targetElement, pageNumber)
            ) {
                return true;
            }

            for (const node of Array.from(mutation.addedNodes)) {
                const element = getMutationElement(node);
                if (element && isContinuousNavigationLayoutElement(element, pageNumber)) {
                    return true;
                }
            }

            for (const node of Array.from(mutation.removedNodes)) {
                const element = getMutationElement(node);
                if (element && isContinuousNavigationLayoutElement(element, pageNumber)) {
                    return true;
                }
            }

            return false;
        });
    }

    function markProgrammaticNavigation(ms: number) {
        const now = Date.now();
        snapSuppressUntil.value = Math.max(snapSuppressUntil.value, now + ms);
        isProgrammaticNavigationActive.value = true;
        scheduleProgrammaticNavigationRelease();
    }

    function maybeReleaseProgrammaticNavigation() {
        if (
            searchNavigationState.value === 'idle'
            && Date.now() >= snapSuppressUntil.value
        ) {
            isProgrammaticNavigationActive.value = false;
            clearProgrammaticNavigationReleaseTimer();
        }
    }

    function suppressSnapFor(ms: number) {
        markProgrammaticNavigation(ms);
    }

    function beginPagedNavigation(
        pageNumber: number,
        holdMs = PAGED_NAVIGATION_DEFAULT_HOLD_MS,
        anchor: TPageSnapAnchor | null = null,
    ) {
        const targetPage = clamp(pageNumber, 1, numPages.value);
        const navigationState = dispatchNavigationMachine({
            type: 'NAVIGATE',
            source: 'paged',
            targetPage,
            anchor,
        });
        const runId = navigationState.txn;
        markProgrammaticNavigation(holdMs);
        navigationEffects.armPagedSettle(runId, targetPage, holdMs, () => {
            if (
                pagedNavigationTargetPage.value === targetPage
                && isPagedNavigationRunCurrent(runId)
            ) {
                maybeReleaseProgrammaticNavigation();
            }
        });
        return {
            runId,
            targetPage,
        };
    }

    function beginSearchNavigation(pageNumber: number, holdMs = SEARCH_NAVIGATION_DEFAULT_HOLD_MS) {
        navigationEffects.clearSearchSettle();
        cancelContinuousNavigationTarget();
        const targetPage = numPages.value > 0
            ? Math.max(
                1,
                Math.min(pageNumber, numPages.value),
            )
            : pageNumber;
        dispatchNavigationMachine({
            type: 'NAVIGATE',
            source: 'search',
            targetPage,
        });
        const runId = navigationRuntime.txn.value;
        setNavigationFeedbackPage(targetPage, 'search-navigation-started', runId);
        markProgrammaticNavigation(Math.max(SEARCH_NAVIGATION_MIN_HOLD_MS, holdMs));
    }

    function endSearchNavigation(settleMs = SEARCH_NAVIGATION_DEFAULT_SETTLE_MS) {
        navigationEffects.clearSearchSettle();
        const runId = getActiveSearchNavigationRunId();
        if (runId === null || !isNavigationRunCurrent(runId)) {
            return;
        }

        if (settleMs <= 0) {
            snapSuppressUntil.value = 0;
            isProgrammaticNavigationActive.value = false;
            clearProgrammaticNavigationReleaseTimer();
            clearNavigationFeedbackPage('search-navigation-canceled', runId);
            dispatchNavigationMachine({ type: 'CANCEL' });
            return;
        }

        const targetPage = searchNavigationTargetPage.value;
        if (targetPage === null) {
            return;
        }

        if (isNavigationRunCurrent(runId)) {
            dispatchNavigationMachine({
                type: 'SCROLL_APPLIED',
                txn: runId,
                page: targetPage,
            });
        }
        markProgrammaticNavigation(Math.max(SEARCH_NAVIGATION_DEFAULT_SETTLE_MS, settleMs + PROGRAMMATIC_NAVIGATION_RELEASE_RETRY_MS));
        navigationEffects.armSearchSettle(settleMs, () => {
            if (isNavigationRunCurrent(runId)) {
                clearNavigationFeedbackPage('search-navigation-finished', runId);
                dispatchNavigationMachine({ type: 'CANCEL' });
            }
            maybeReleaseProgrammaticNavigation();
        });
    }

    function revealSearchNavigationTarget(
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) {
        if (!viewerContainer.value || numPages.value === 0) {
            return false;
        }

        const targetPage = clamp(pageNumber, 1, numPages.value);
        const runId = getActiveSearchNavigationRunId();
        if (
            runId === null
            || searchNavigationTargetPage.value !== targetPage
            || !isNavigationRunCurrent(runId)
        ) {
            return false;
        }

        if (continuousScroll.value) {
            logPdfRenderTrace('single-page-search-reveal-continuous-target', {
                runId,
                targetPage,
                currentPage: currentPage.value,
                hasMarkerRect: Boolean(options?.markerRect),
            });
            return applyContinuousNavigationTargetScroll(targetPage, options);
        }

        const rowRange = setVisibleRangeToPageRow(targetPage);
        isSnapping.value = true;
        logPdfRenderTrace('single-page-search-reveal-paged-target', {
            runId,
            targetPage,
            rowRange,
            currentPage: currentPage.value,
            hasMarkerRect: Boolean(options?.markerRect),
        });

        void nextTick(() => {
            if (
                !isNavigationRunCurrent(runId)
                || searchNavigationTargetPage.value !== targetPage
                || continuousScroll.value
            ) {
                isSnapping.value = false;
                return;
            }

            const didSnap = applySnapToMountedPage(targetPage, 'top', options, { commitCurrentPage: false });
            logPdfRenderTrace('single-page-search-reveal-paged-target-snap', {
                runId,
                targetPage,
                didSnap,
                currentPage: currentPage.value,
                hasMarkerRect: Boolean(options?.markerRect),
            });
            if (!didSnap) {
                isSnapping.value = false;
            }
        });
        return true;
    }

    const wheelAccumulator = ref<IWheelPageAccumulatorState>(createWheelPageAccumulatorState());
    const wheelFlipGate = createWheelFlipGate();

    const debouncedRenderOnScroll = useDebounceFn(() => {
        if (isDisposed) {
            return;
        }
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        if (!continuousScroll.value && pagedNavigationTargetPage.value !== null) {
            logPdfRenderTrace('single-page-scroll-render-skipped-pending-paged-target', {
                visibleRange: visibleRange.value,
                pagedNavigationTargetPage: pagedNavigationTargetPage.value,
            });
            return;
        }
        runGuardedTask(() => renderVisiblePages(
            visibleRange.value,
            { preserveRenderedPages: true },
        ), {
            scope: 'pdf-single-page-scroll',
            message: 'Failed to render visible pages on scroll',
        });
    }, SCROLL_RENDER_DEBOUNCE_MS);

    function clearWheelAccumulator() {
        wheelAccumulator.value = createWheelPageAccumulatorState();
    }

    function resolveWheelActivePage(container: HTMLElement) {
        if (!continuousScroll.value) {
            const pagedTargetPage = pagedNavigationTargetPage.value;
            if (pagedTargetPage !== null) {
                return clamp(pagedTargetPage, 1, numPages.value);
            }

            return clamp(currentPage.value, 1, numPages.value);
        }

        return getMostVisiblePage(container, numPages.value);
    }

    function resolvePageRowRange(pageNumber: number) {
        return getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    }

    function isPageInRange(
        pageNumber: number,
        range: {
            start: number;
            end: number;
        },
    ) {
        return pageNumber >= range.start && pageNumber <= range.end;
    }

    function getMountedPageVisualState(pageNumber: number): IMountedPageVisualState {
        const container = viewerContainer.value;
        if (!container) {
            return {
                buffered: false,
                hasCanvas: false,
                hasSkeleton: false,
                mounted: false,
                renderedClass: false,
            };
        }

        const pageElement = getPageContainerByNumber(container, pageNumber);
        if (!pageElement) {
            return {
                buffered: false,
                hasCanvas: false,
                hasSkeleton: false,
                mounted: false,
                renderedClass: false,
            };
        }

        const queryPageElement = typeof pageElement.querySelector === 'function'
            ? (selector: string) => pageElement.querySelector(selector)
            : () => null;

        return {
            buffered: pageElement.classList?.contains('page_container--buffered') === true,
            hasCanvas: queryPageElement('.page_canvas canvas') !== null,
            hasSkeleton: queryPageElement('.pdf-page-skeleton') !== null,
            mounted: true,
            renderedClass: pageElement.classList?.contains('page_container--rendered') === true,
        };
    }

    function getMountedPageVisualReadiness(
        pageNumber: number,
        state: IMountedPageVisualState,
    ): IMountedPageVisualReadiness {
        const freshlyRendered = options.isPageFreshlyRenderedForNavigation?.(pageNumber) ?? state.renderedClass;
        const hasUsableCanvas = state.hasCanvas && state.renderedClass && freshlyRendered;
        return {
            freshlyRendered,
            hasUsableCanvas,
            usable: !state.buffered && hasUsableCanvas,
        };
    }

    function getMountedPageRowVisualStates(range: {
        start: number;
        end: number;
    }) {
        const states: Record<number, IMountedPageVisualState & IMountedPageVisualReadiness> = {};
        for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
            const visualState = getMountedPageVisualState(pageNumber);
            states[pageNumber] = {
                ...visualState,
                ...getMountedPageVisualReadiness(pageNumber, visualState),
            };
        }
        return states;
    }

    function isMountedPageRowCanvasUsable(
        range: {
            start: number;
            end: number;
        },
        rowVisualStates = getMountedPageRowVisualStates(range),
    ) {
        for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
            const state = rowVisualStates[pageNumber];
            if (!state || state.buffered || !state.hasUsableCanvas) {
                return false;
            }
        }
        return true;
    }

    function commitPagedNavigationTarget(
        runId: number,
        targetPage: number,
        reason: string,
    ) {
        if (!isPagedNavigationRunCurrent(runId)) {
            clearPagedNavigationHold(runId);
            return false;
        }

        const targetRange = resolvePageRowRange(targetPage);
        const visualState = getMountedPageVisualState(targetPage);
        const rowVisualStates = getMountedPageRowVisualStates(targetRange);
        const canCommit = isMountedPageRowCanvasUsable(targetRange, rowVisualStates);
        if (!canCommit) {
            logPdfRenderTrace('single-page-paged-target-commit-deferred', {
                targetPage,
                targetRange,
                runId,
                reason,
                rowVisualStates,
                visualState,
            });
            return false;
        }

        const anchor = navigationRuntime.state.value.anchor ?? 'top';
        const rowRange = setVisibleRangeToPageRow(targetPage);
        const didSnap = applySnapToMountedPage(targetPage, anchor, pagedNavigationTargetScrollOptions, { commitCurrentPage: true });
        if (!didSnap && currentPage.value !== targetPage) {
            currentPage.value = targetPage;
            emitCurrentPage(targetPage);
        }
        markPagedNavigationScrollApplied(runId, targetPage);
        logPdfRenderTrace('single-page-paged-target-committed', {
            targetPage,
            targetRange,
            rowRange,
            runId,
            reason,
            didSnap,
            rowVisualStates,
            visualState,
        });
        finishPagedNavigation(runId, targetPage);
        return true;
    }

    function commitPagedNavigationReadyPage(pageNumber: number, reason: string) {
        const targetPage = pagedNavigationTargetPage.value;
        if (targetPage === null) {
            return false;
        }

        const runId = navigationRuntime.txn.value;
        const targetRange = resolvePageRowRange(targetPage);
        if (!isPageInRange(pageNumber, targetRange)) {
            return false;
        }

        logPdfRenderTrace('single-page-paged-visual-ready', {
            pageNumber,
            runId,
            targetPage,
            targetRange,
            reason,
            visualState: getMountedPageVisualState(pageNumber),
        });
        return commitPagedNavigationTarget(runId, targetPage, reason);
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

    function setPagedNavigationTarget(pageNumber: number, anchor: TPageSnapAnchor | null) {
        const previousPage = currentPage.value;
        const {
            runId,
            targetPage,
        } = beginPagedNavigation(pageNumber, PAGED_NAVIGATION_SETTLE_TIMEOUT_MS, anchor);
        if (
            navigationFeedbackState.page !== null
            && navigationFeedbackState.runId !== runId
        ) {
            clearNavigationFeedbackPage('paged-target-replaced');
        }
        startPagedNavigationHold(runId, targetPage);
        logPdfRenderTrace('single-page-set-paged-target', {
            requestedPage: pageNumber,
            targetPage,
            runId,
            currentPageBefore: previousPage,
            visibleRangeBefore: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        return {
            runId,
            targetPage,
        };
    }

    /**
     * Render the row selected by the currently active paged navigation run.
     *
     * Rapid toolbar clicks can still queue several `nextTick` callbacks before
     * Vue mounts the final target row. The run guard keeps stale targets from
     * rendering or committing after a newer pending page wins.
     */
    function runPagedRowRenderAfterNavigation(request: IPagedRowRenderRequest) {
        const targetPage = clamp(request.pageNumber, 1, numPages.value);
        logPdfRenderTrace('single-page-queue-row-render', {
            targetPage,
            message: request.message,
            runId: request.runId,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            allowSuppressedRender: request.allowSuppressedRender === true,
        });
        void nextTick(() => {
            const isPagedRowRenderSuppressed = suppressPagedRowRender?.() === true;
            if (
                isDisposed
                || !isPagedNavigationRunCurrent(request.runId)
                || continuousScroll.value
                || isLoading.value
                || !pdfDocument.value
                || (
                    isPagedRowRenderSuppressed
                    && request.allowSuppressedRender !== true
                )
            ) {
                logPdfRenderTrace('single-page-row-render-skipped', {
                    targetPage,
                    message: request.message,
                    runId: request.runId,
                    activeRunId: navigationRuntime.txn.value,
                    isDisposed,
                    continuousScroll: continuousScroll.value,
                    isLoading: isLoading.value,
                    hasDocument: Boolean(pdfDocument.value),
                    currentPage: currentPage.value,
                    suppressPagedRowRender: isPagedRowRenderSuppressed,
                    allowSuppressedRender: request.allowSuppressedRender === true,
                });
                return;
            }

            const range = resolvePageRowRange(targetPage);
            logPdfRenderTrace('single-page-row-render-run', {
                targetPage,
                message: request.message,
                range,
                currentPage: currentPage.value,
            });
            runGuardedTask(async () => {
                await renderVisiblePages(
                    range,
                    {
                        preserveRenderedPages: true,
                        bufferOverride: 0,
                        preserveInFlightRequiredPages: true,
                    },
                );
                commitPagedNavigationTarget(request.runId, targetPage, 'row-rendered');
            }, {
                scope: 'pdf-single-page-scroll',
                message: request.message,
            });
        });
    }

    function queuePagedRowRenderAfterNavigation(
        pageNumber: number,
        message: string,
        runId: number,
        options?: Pick<IPagedRowRenderRequest, 'allowSuppressedRender'>,
    ) {
        const targetPage = clamp(pageNumber, 1, numPages.value);
        const request: IPagedRowRenderRequest = {
            pageNumber: targetPage,
            message,
            runId,
        };
        if (options?.allowSuppressedRender !== undefined) {
            request.allowSuppressedRender = options.allowSuppressedRender;
        }
        runPagedRowRenderAfterNavigation(request);
    }

    function queueAuthoritativePagedRowRenderAfterNavigation(
        pageNumber: number,
        message: string,
        runId: number,
    ) {
        queuePagedRowRenderAfterNavigation(
            pageNumber,
            message,
            runId,
            { allowSuppressedRender: true },
        );
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

        reapplyContinuousNavigationTargetScroll(runId, pageNumber, scrollOptions);

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
        runGuardedTask(async () => {
            await renderVisiblePages(
                range,
                {
                    preserveRenderedPages: true,
                    bufferOverride: 1,
                    preserveInFlightRequiredPages: true,
                },
            );
            await nextTick();
            reapplyContinuousNavigationTargetScroll(runId, pageNumber, scrollOptions);
            await waitForContinuousRenderFrame();
            reapplyContinuousNavigationTargetScroll(runId, pageNumber, scrollOptions);
        }, {
            scope: 'pdf-single-page-scroll',
            message,
        });
    }

    function reapplyContinuousNavigationTargetScroll(
        runId: number,
        pageNumber: number,
        scrollOptions?: IScrollToPageOptions,
    ) {
        if (
            isDisposed
            || runId !== continuousNavigationRenderRunId
            || !continuousScroll.value
            || isLoading.value
            || !pdfDocument.value
            || continuousNavigationTargetPage.value !== pageNumber
            || !viewerContainer.value
        ) {
            return;
        }

        const previous = currentPage.value;
        if (isContinuousNavigationTargetAligned(pageNumber, scrollOptions)) {
            const page = updateCurrentPage(
                viewerContainer.value,
                numPages.value,
                { requireAuthoritative: true },
            );
            if (page !== previous) {
                emitCurrentPage(page);
            }
            return;
        }

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

    function queueContinuousNavigationRenderAfterNavigation(
        runId: number,
        pageNumber: number,
        message: string,
        scrollOptions?: IScrollToPageOptions,
    ) {
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

        navigationEffects.armContinuousRender(
            CONTINUOUS_PROGRAMMATIC_RENDER_SETTLE_DELAYS_MS,
            (delayMs) => {
                void runContinuousNavigationRenderPass(
                    runId,
                    pageNumber,
                    message,
                    delayMs,
                    scrollOptions,
                );
            },
        );

        return runId;
    }

    function applyContinuousNavigationTargetScroll(
        pageNumber: number,
        options?: IScrollToPageOptions,
    ) {
        if (!viewerContainer.value) {
            return false;
        }

        const previous = currentPage.value;
        scrollToPageInternal(
            viewerContainer.value,
            pageNumber,
            numPages.value,
            scaledMargin.value,
            options,
        );
        updateVisibleRange(viewerContainer.value, numPages.value);
        const page = updateCurrentPage(
            viewerContainer.value,
            numPages.value,
            { requireAuthoritative: true },
        );
        if (page !== previous) {
            emitCurrentPage(page);
        }
        return true;
    }

    function finishContinuousNavigationStart(
        runId: number,
        targetPage: number,
        options?: IScrollToPageOptions,
        renderAlreadySettled = false,
    ) {
        if (
            isDisposed
            || runId !== continuousNavigationRenderRunId
            || continuousNavigationTargetPage.value !== targetPage
            || !continuousScroll.value
            || !viewerContainer.value
        ) {
            return false;
        }

        const didScroll = applyContinuousNavigationTargetScroll(targetPage, options);
        if (renderAlreadySettled) {
            startContinuousNavigationLayoutObservers(runId, targetPage, options);
            scheduleContinuousNavigationTargetFallbackClear(runId, targetPage);
            return didScroll;
        }

        queueContinuousNavigationRenderAfterNavigation(
            runId,
            targetPage,
            'Failed to render visible pages after scrollToPage',
            options,
        );
        startContinuousNavigationLayoutObservers(runId, targetPage, options);
        scheduleContinuousNavigationTargetFallbackClear(runId, targetPage);
        return didScroll;
    }

    /**
     * Hydrates target-row metrics before the first continuous jump, but treats a
     * false result as "metrics already cached". `ensurePageMetricsInRange`
     * returns false when no new metric needed loading, not only on failure.
     */
    async function finishContinuousNavigationStartAfterMetricHydration(
        runId: number,
        targetPage: number,
        options?: IScrollToPageOptions,
    ) {
        const rowRange = resolvePageRowRange(targetPage);
        await ensurePageMetricsInRange?.(rowRange.start, rowRange.end);
        await nextTick();
        if (
            isDisposed
            || runId !== continuousNavigationRenderRunId
            || continuousNavigationTargetPage.value !== targetPage
            || !continuousScroll.value
            || !viewerContainer.value
        ) {
            return;
        }

        const range = setVisibleRangeToPageRow(targetPage);
        await renderVisiblePages(
            range,
            {
                preserveRenderedPages: true,
                bufferOverride: 1,
                preserveInFlightRequiredPages: true,
            },
        );
        await nextTick();
        finishContinuousNavigationStart(runId, targetPage, options, true);
        await waitForContinuousRenderFrame();
        reapplyContinuousNavigationTargetScroll(runId, targetPage, options);
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

    function resolveMountedPageSnapTop(options: {
        anchor: TPageSnapAnchor;
        baseTop: number;
        maxTop: number;
        targetHeight: number;
        containerHeight: number;
        pageYRatio?: number | null | undefined;
        markerRect?: IScrollToPageOptions['markerRect'];
        markerPageTop?: number | undefined;
        markerPageHeight?: number | undefined;
        pageYBaseTop?: number | undefined;
        pageYPageHeight?: number | undefined;
    }) {
        if (typeof options.pageYRatio === 'number' && Number.isFinite(options.pageYRatio)) {
            const pageYBaseTop = typeof options.pageYBaseTop === 'number'
                && Number.isFinite(options.pageYBaseTop)
                ? options.pageYBaseTop
                : options.baseTop;
            const pageYPageHeight = typeof options.pageYPageHeight === 'number'
                && Number.isFinite(options.pageYPageHeight)
                && options.pageYPageHeight > 0
                ? options.pageYPageHeight
                : options.targetHeight;
            return Math.min(
                options.maxTop,
                Math.max(0, pageYBaseTop + clamp(options.pageYRatio, 0, 1) * pageYPageHeight),
            );
        }

        if (
            options.markerRect
            && typeof options.markerPageTop === 'number'
            && Number.isFinite(options.markerPageTop)
            && typeof options.markerPageHeight === 'number'
            && Number.isFinite(options.markerPageHeight)
            && options.markerPageHeight > 0
        ) {
            const markerCenterY = clamp(
                options.markerRect.top + options.markerRect.height / 2,
                0,
                1,
            );
            return clampMarkerScrollTopToPageBounds({
                desiredTop: Math.max(
                    0,
                    options.markerPageTop + markerCenterY * options.markerPageHeight - options.containerHeight / 2,
                ),
                maxTop: options.maxTop,
                pageTop: options.markerPageTop,
                pageHeight: options.markerPageHeight,
                containerHeight: options.containerHeight,
            });
        }

        const topTarget = Math.min(options.maxTop, Math.max(0, options.baseTop));
        const centerOffset = Math.max(0, (options.containerHeight - options.targetHeight) / 2);
        const centerTarget = Math.min(options.maxTop, Math.max(0, options.baseTop - centerOffset));
        const bottomTarget = Math.min(
            options.maxTop,
            Math.max(0, options.baseTop + options.targetHeight - options.containerHeight),
        );

        if (options.anchor === 'top') {
            return topTarget;
        }
        if (options.anchor === 'bottom') {
            return bottomTarget;
        }
        return centerTarget;
    }

    function resolveMountedPageMarkerScrollLeft(options: {
        containerWidth: number;
        maxLeft: number;
        markerRect?: IScrollToPageOptions['markerRect'];
        pageLeft: number;
        pageWidth: number;
    }) {
        if (
            !options.markerRect
            || !Number.isFinite(options.pageWidth)
            || options.pageWidth <= 0
        ) {
            return null;
        }

        const markerCenterX = clamp(
            options.markerRect.left + options.markerRect.width / 2,
            0,
            1,
        );
        const markerTargetLeft = Math.max(
            0,
            options.pageLeft + markerCenterX * options.pageWidth - options.containerWidth / 2,
        );
        const scrollClamp = resolvePageBoundedHorizontalScroll({
            scrollLeft: markerTargetLeft,
            viewportWidth: options.containerWidth,
            pageLeft: options.pageLeft,
            pageWidth: options.pageWidth,
            margin: scaledMargin.value,
        });

        return Math.min(
            options.maxLeft,
            Math.max(0, scrollClamp?.scrollLeft ?? markerTargetLeft),
        );
    }

    function applySnapToMountedPage(
        pageNumber: number,
        anchor: TPageSnapAnchor,
        options?: Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect'>,
        commitOptions?: IApplySnapToMountedPageCommitOptions,
    ) {
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
        const containerWidth = Number.isFinite(container.clientWidth) && container.clientWidth > 0
            ? container.clientWidth
            : 0;
        const targetGeometry = getPageRowGeometry(container, targetPage) ?? {
            top: targetEl.offsetTop,
            height: targetEl.offsetHeight,
        };
        const targetPageHeight = targetEl.offsetHeight || targetEl.clientHeight || targetGeometry.height;
        const targetPageWidth = targetEl.offsetWidth || targetEl.clientWidth || 0;
        const targetHeight = targetGeometry.height;
        const baseTop = targetGeometry.top - scaledMargin.value;
        const maxTop = Math.max(0, container.scrollHeight - containerHeight);
        const scrollWidth = Number.isFinite(container.scrollWidth) && container.scrollWidth > 0
            ? container.scrollWidth
            : containerWidth;
        const maxLeft = Math.max(0, scrollWidth - containerWidth);
        const targetTop = resolveMountedPageSnapTop({
            anchor,
            baseTop,
            maxTop,
            targetHeight,
            containerHeight,
            pageYRatio: options?.pageYRatio,
            markerRect: options?.markerRect,
            markerPageTop: targetEl.offsetTop,
            markerPageHeight: targetPageHeight,
            pageYBaseTop: targetEl.offsetTop - scaledMargin.value,
            pageYPageHeight: targetPageHeight,
        });
        const targetLeft = resolveMountedPageMarkerScrollLeft({
            containerWidth,
            maxLeft,
            markerRect: options?.markerRect,
            pageLeft: targetEl.offsetLeft,
            pageWidth: targetPageWidth,
        });
        isSnapping.value = true;
        container.scrollTop = targetTop;
        if (targetLeft !== null) {
            container.scrollLeft = targetLeft;
        }
        if (commitOptions?.commitCurrentPage !== false && currentPage.value !== targetPage) {
            currentPage.value = targetPage;
            emitCurrentPage(targetPage);
        }

        scheduleSinglePageScrollFrame(() => {
            isSnapping.value = false;
        });
        return true;
    }

    function startPreparedPagedNavigationTarget(
        prepareRunId: number,
        targetPage: number,
        anchor: TPageSnapAnchor,
        options?: Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect' | 'suppressRenderAfterSnap'>,
    ) {
        if (!isPagedNavigationPrepareRunCurrent(prepareRunId, targetPage)) {
            return false;
        }

        clearPagedNavigationPreparation(prepareRunId);
        const { runId } = setPagedNavigationTarget(targetPage, anchor);
        pagedNavigationTargetScrollOptions = options;

        if (applySnapToMountedPage(targetPage, anchor, options, { commitCurrentPage: false })) {
            markPagedNavigationScrollApplied(runId, targetPage);
            logPdfRenderTrace('single-page-snap-mounted', {
                targetPage,
                anchor,
                runId,
            });
            if (!options?.suppressRenderAfterSnap) {
                queueAuthoritativePagedRowRenderAfterNavigation(
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
            commitPagedNavigationTarget(runId, targetPage, 'mounted-target-ready');
            return true;
        }

        if (!options?.suppressRenderAfterSnap) {
            queueAuthoritativePagedRowRenderAfterNavigation(
                targetPage,
                'Failed to render visible pages after paged navigation',
                runId,
            );
        } else {
            logPdfRenderTrace('single-page-snap-deferred-render-suppressed', {
                targetPage,
                anchor,
                runId,
            });
        }
        isSnapping.value = true;
        void nextTick(() => {
            if (
                isDisposed
                || !isPagedNavigationRunCurrent(runId)
                || continuousScroll.value
                || pagedNavigationTargetPage.value !== targetPage
            ) {
                logPdfRenderTrace('single-page-snap-next-tick-skipped', {
                    targetPage,
                    runId,
                    activeRunId: navigationRuntime.txn.value,
                    isDisposed,
                    continuousScroll: continuousScroll.value,
                    currentPage: currentPage.value,
                    pagedNavigationTargetPage: pagedNavigationTargetPage.value,
                });
                isSnapping.value = false;
                return;
            }

            if (!applySnapToMountedPage(targetPage, anchor, options, { commitCurrentPage: false })) {
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
            markPagedNavigationScrollApplied(runId, targetPage);
            commitPagedNavigationTarget(runId, targetPage, 'mounted-target-ready-next-tick');
        });
        return true;
    }

    /**
     * Selects the authoritative paged target and reports whether navigation was
     * accepted. Rendering/alignment may still complete asynchronously.
     */
    function snapToPage(
        pageNumber: number,
        anchor: TPageSnapAnchor = 'center',
        options?: Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect' | 'suppressRenderAfterSnap'>,
    ) {
        if (!viewerContainer.value || numPages.value === 0) {
            return false;
        }

        const targetPage = clamp(pageNumber, 1, numPages.value);
        logPdfRenderTrace('single-page-snap-to-page', {
            requestedPage: pageNumber,
            targetPage,
            anchor,
            continuousScroll: continuousScroll.value,
            suppressRenderAfterSnap: options?.suppressRenderAfterSnap === true,
            pageYRatio: typeof options?.pageYRatio === 'number' ? options.pageYRatio : null,
            hasMarkerRect: Boolean(options?.markerRect),
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        if (!continuousScroll.value) {
            const activePagedTargetPage = pagedNavigationTargetPage.value;
            if (activePagedTargetPage === targetPage) {
                const activeAnchor = navigationRuntime.state.value.anchor ?? anchor;
                const didSnap = applySnapToMountedPage(targetPage, activeAnchor, options, { commitCurrentPage: false });
                logPdfRenderTrace('single-page-snap-active-paged-target', {
                    targetPage,
                    anchor: activeAnchor,
                    activeRunId: navigationRuntime.txn.value,
                    didSnap,
                });
                return true;
            }
            if (pagedNavigationPrepareTargetPage === targetPage) {
                logPdfRenderTrace('single-page-snap-paged-target-preparation-reused', {
                    targetPage,
                    currentPrepareRunId: pagedNavigationPrepareRunId,
                    anchor,
                });
                return true;
            }
            const prepareRunId = ++pagedNavigationPrepareRunId;
            pagedNavigationPrepareTargetPage = targetPage;
            const shouldContinuePreparing = () => isPagedNavigationPrepareRunCurrent(prepareRunId, targetPage);
            const preparation = preparePagedTargetLayout?.(targetPage, shouldContinuePreparing);
            if (isPromiseLike(preparation)) {
                runGuardedTask(
                    async () => {
                        try {
                            await preparation;
                            await nextTick();
                            startPreparedPagedNavigationTarget(
                                prepareRunId,
                                targetPage,
                                anchor,
                                options,
                            );
                        } finally {
                            clearPagedNavigationPreparation(prepareRunId);
                        }
                    },
                    {
                        scope: 'pdf-single-page-scroll',
                        message: 'Failed to prepare paged target layout before navigation',
                    },
                );
                return true;
            }

            return startPreparedPagedNavigationTarget(
                prepareRunId,
                targetPage,
                anchor,
                options,
            );
        }

        if (applySnapToMountedPage(targetPage, anchor, options)) {
            return true;
        }

        isSnapping.value = true;
        const previous = currentPage.value;
        scrollToPageInternal(
            viewerContainer.value,
            targetPage,
            numPages.value,
            scaledMargin.value,
            options,
        );
        if (currentPage.value !== previous) {
            emitCurrentPage(currentPage.value);
        }
        scheduleSinglePageScrollFrame(() => {
            isSnapping.value = false;
        });
        return true;
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
    }, TALL_PAGE_SNAP_DEBOUNCE_MS);

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
            return false;
        }

        const delta = normalizePageWheelDelta(event.deltaY, event.deltaMode, container);
        if (Math.abs(delta) < WHEEL_DELTA_EPSILON) {
            return false;
        }

        event.preventDefault();
        const direction = resolveWheelDirection(delta);
        const finishHandledWheel = () => {
            wheelFlipGate.recordWheelPacket(event.timeStamp, delta);
            return true;
        };
        const activePage = resolveWheelActivePage(container);
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
            wheelFlipGate.recordInteriorScroll();
            return finishHandledWheel();
        }

        // Cooldown gate: when a same-direction flip just happened and the user
        // hasn't either reversed direction or scrolled within a tall page,
        // swallow this wheel packet to avoid trackpad inertia rapid-firing
        // through pages. preventDefault was already called above, so the
        // browser also won't perform a native scroll.
        if (wheelFlipGate.shouldBlockFlip(direction, event.timeStamp, {
            delta,
            requireGestureIdle: event.deltaMode === 0,
        })) {
            clearWheelAccumulator();
            return finishHandledWheel();
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
            return finishHandledWheel();
        }

        const targetPage = resolveWheelTargetPage(
            activePage,
            viewMode.value,
            numPages.value,
            direction,
        );
        if (targetPage === activePage) {
            clearWheelAccumulator();
            return finishHandledWheel();
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
        if (!snapToPage(targetPage, anchor)) {
            clearWheelAccumulator();
            return finishHandledWheel();
        }
        suppressSnapFor(WHEEL_FLIP_SNAP_SUPPRESSION_MS);
        wheelFlipGate.recordFlip(direction, event.timeStamp, delta);
        return finishHandledWheel();
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

        /**
         * Programmatic bookmark navigation owns the viewport until its held
         * target is aligned. A later recovery restore can fire as an ordinary
         * scroll event, so repair it here instead of accepting the wrong page.
         */
        const continuousTargetPage = continuousNavigationTargetPage.value;
        if (
            continuousScroll.value
            && continuousTargetPage !== null
            && viewerContainer.value
            && (
                page !== continuousTargetPage
                || !isContinuousNavigationTargetAligned(
                    continuousTargetPage,
                    continuousNavigationTargetScrollOptions,
                )
            )
        ) {
            navigationEffects.scheduleLayoutReapply(
                continuousNavigationRenderRunId,
                continuousTargetPage,
                'scroll',
                continuousNavigationTargetScrollOptions,
            );
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

    /**
     * Starts page navigation with a clear immediate/deferred outcome for
     * callers that coordinate rendering around the destination viewport.
     */
    function scrollToPage(
        pageNumber: number,
        options?: IScrollToPageOptions,
    ) {
        if (!viewerContainer.value || numPages.value === 0) {
            return false;
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
            markProgrammaticNavigation(ensurePageMetricsInRange
                ? CONTINUOUS_NAVIGATION_HOLD_WITH_METRICS_MS
                : CONTINUOUS_NAVIGATION_HOLD_FALLBACK_MS);
            const targetPage = clamp(pageNumber, 1, numPages.value);
            const runId = ++continuousNavigationRenderRunId;
            navigationEffects.clearContinuous();
            continuousNavigationTargetPage.value = targetPage;
            continuousNavigationTargetScrollOptions = options;

            if (
                ensurePageMetricsInRange
                && !(
                    options?.preferExactDom === true
                    && getPageContainerByNumber(viewerContainer.value, targetPage)
                )
            ) {
                runGuardedTask(
                    () => finishContinuousNavigationStartAfterMetricHydration(
                        runId,
                        targetPage,
                        options,
                    ),
                    {
                        scope: 'pdf-single-page-scroll',
                        message: 'Failed to hydrate target page metrics before scrollToPage',
                        onError: () => {
                            clearContinuousNavigationTarget(runId, targetPage);
                        },
                    },
                );
                return false;
            }

            return finishContinuousNavigationStart(
                runId,
                targetPage,
                options,
            );
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
            return snapToPage(pageNumber, anchor, options);
        }
    }

    function resetContinuousScrollState() {
        pagedNavigationPrepareRunId += 1;
        clearPagedNavigationPreparation();
        dispatchNavigationMachine({ type: 'DOCUMENT_CHANGED' });
        clearWheelAccumulator();
        clearPagedNavigationTarget();
        pagedNavigationTargetScrollOptions = undefined;
        clearNavigationFeedbackPage('continuous-scroll-state-reset');
        clearPagedNavigationHold();
        navigationEffects.clearSearchSettle();
        navigationEffects.clearContinuous();
        isProgrammaticNavigationActive.value = false;
        clearProgrammaticNavigationReleaseTimer();
        continuousNavigationTargetPage.value = null;
        continuousNavigationTargetScrollOptions = undefined;
        snapSuppressUntil.value = 0;
        wheelFlipGate.reset();
    }

    tryOnScopeDispose(() => {
        isDisposed = true;
        pagedNavigationTargetScrollOptions = undefined;
        clearNavigationFeedbackPage('scope-dispose');
        clearPagedNavigationHold();
        clearProgrammaticNavigationReleaseTimer();
        navigationEffects.disposeAll();
    });

    return {
        isSnapping,
        handleWheel,
        handleScroll,
        scrollToPage,
        snapToPage,
        suppressSnapFor,
        beginSearchNavigation,
        revealSearchNavigationTarget,
        endSearchNavigation,
        isProgrammaticNavigationActive,
        isSearchNavigationLocked,
        searchNavigationState,
        searchNavigationTargetPage,
        pagedNavigationHold,
        isNavigationHoldActiveForPage,
        isNavigationHoldExpiredPage,
        releasePagedNavigationHoldForPage,
        isPagedNavigationBurstActive,
        pagedNavigationTargetPage,
        continuousNavigationTargetPage,
        cancelContinuousNavigationTarget,
        cancelProgrammaticNavigation,
        resetContinuousScrollState,
    };
};
